# Architecture

## Component diagram

```
┌──────────────┐                      ┌─────────────────────────┐
│ Feishu cloud │ <─── long connect ─> │ lark-cli event daemon   │
└──────────────┘                      │  (one process per app)  │
                                      └────────────┬────────────┘
                                                   │ NDJSON stdout
                                                   ▼
                              ┌───────────────────────────────────┐
                              │ src/lark/consume.ts               │
                              │  ├─ parses each line              │
                              │  └─ filters non-message events    │
                              └────────────┬──────────────────────┘
                                           │
                                           ▼
                              ┌───────────────────────────────────┐
                              │ src/worker.ts                     │
                              │  ├─ event_id dedup (SQLite)       │
                              │  ├─ session history (per chat)    │
                              │  ├─ src/llm.ts  →  Anthropic SDK  │──> LLM endpoint
                              │  │   OR                           │
                              │  │  src/llm-claude-code.ts        │──> spawn `claude -p` (sandboxed)
                              │  └─ src/lark/reply.ts             │──> lark-cli im +messages-reply
                              └───────────────────────────────────┘
```

## Key decisions

### 1. Use `lark-cli event consume`, not a webhook server

The official long-poll daemon already solves URL verification, encryption,
signature validation, AT-token refresh, and re-delivery semantics. Re-implementing
that in our own webhook would be at best redundant and at worst a security
liability.

The trade-off is that the daemon must be **online** for messages to arrive in
real time; Feishu retries for a bounded window but not forever. SQLite-backed
`event_id` dedup (in `src/store.ts`) ensures restarts inside that window don't
cause double-handling.

### 2. Stdin to `lark-cli event consume` MUST stay open

lark-cli treats stdin EOF as a graceful-shutdown signal in unbounded mode.
Spawning with `stdio: ['ignore', 'pipe', 'inherit']` makes the child exit
within seconds with `context canceled`. We use `'pipe'` for stdin and never
write to it.

### 3. Async dispatch, never block the consumer loop

`onEvent` returns immediately after kicking off `handle(...)` as a detached
async task. A slow LLM call cannot back up the event reader, which would
otherwise pile up unread events and risk re-delivery storms.

### 4. The Anthropic SDK is one backend, not the only one

`src/llm.ts` wraps the Anthropic SDK and is the default. `src/llm-claude-code.ts`
adds a second backend that spawns a headless Claude Code subprocess per
message (selected via `BACKEND=claude-code`). Adding a third — Bedrock,
OpenAI-compatible, etc. — means writing one more module and routing it from
`src/worker.ts`; nothing else has to change.

### 5. Event payload is flat — no `event` / `header` wrapper

Captured live (see `src/lark/types.ts` comment). All fields — `event_id`,
`message_id`, `chat_id`, `content`, etc. — live at the root level. `content`
is **pre-rendered to plain text** by lark-cli; callers must not
`JSON.parse(content).text` (which is what the raw Feishu webhook payload
needs).

## Failure modes & responses

| Failure | What happens | Mitigation |
|---|---|---|
| LLM endpoint returns 5xx / network blip | `handle()` catches, replies with error string, conversation continues | Anthropic SDK retries internally; bridge surfaces the final error rather than masking it |
| `lark-cli event` child dies | `consume.ts` auto-respawns after `restartDelayMs` (2 s); systemd restarts the whole worker if it ever crashes | `src/lark/consume.ts` + `deploy/systemd/...` |
| Duplicate event delivery (Feishu side) | `event_id` claimed atomically in SQLite; redelivered events log "duplicate event, skipped" | `src/store.ts:claimEvent` |
| Reply API failure | Logged, conversation moves on; user sees nothing arrive | `reply.ts` never throws; explicit log line `"reply failed"` |
| Worker restart mid-conversation | SQLite persists history and dedup; in-flight LLM call is lost (user can resend) | `src/store.ts` |
| Claude Code subprocess hangs | Killed after `CLAUDE_CODE_TIMEOUT_SEC` (default 180 s); error surfaces to the user | `src/llm-claude-code.ts` |

---

## Claude Code backend (Phase 6+)

```
[Feishu event] ──> worker.ts ──> spawn `claude -p --bare \
                                     --dangerously-skip-permissions \
                                     --output-format stream-json --verbose \
                                     --resume <UUID>(or --session-id) \
                                     <user text>`
                                          │
                                          │  cwd = CLAUDE_CODE_SANDBOX
                                          ▼
                              Claude Code agent loop
                                  Bash | Read | Write | Edit | Grep
                                  + any installed MCP servers / Skills
                                          │
                                          ▼
                                  stdout: NDJSON stream
                                  - system/init      → session info
                                  - stream_event     → token deltas (--include-partial-messages)
                                  - assistant        → tool_use blocks
                                  - user             → tool_result blocks
                                  - result           → final reply + cost
                                          │
                              worker.ts streams progress → logs + card PATCH
                              worker.ts parses final result → reply to Feishu
                                  ├─ emoji ack on the user's message (Phase 9)
                                  ├─ interactive card PATCH live (Phase 9)
                                  └─ image replies for sandbox-local PNGs (Phase 8)
```

### Why a subprocess per message?

The alternative — keeping a long-lived `claude` daemon and piping prompts —
would need either (a) the Claude Agent SDK, which only speaks
`api.anthropic.com`, or (b) the experimental `--input-format stream-json`
protocol, which is brittle. A fresh subprocess per message is boring but
robust: each message sees a clean Node heap, a clean Claude Code instance,
and crashes can't leak across conversations.

### Streaming output (Phase 7)

`--output-format stream-json --verbose` emits one JSON event per line.
The bridge parses each line as it arrives and forwards `tool_use`,
`tool_result`, and partial text events to a progress callback, which logs
them in real time. The `result` envelope at the end carries the final
text, `session_id`, `stop_reason`, and `total_cost_usd`. To smooth over
the 5–15 s tool-loop latency, the bridge also fires a "⏳ 思考中…"
placeholder reply within ~1 s and recalls it after the real reply lands
(`SHOW_THINKING_PLACEHOLDER=true`).

### Image replies (Phase 8)

Claude Code can write files into its sandbox cwd and reference them via
`![alt](path)` markdown. Feishu won't render those (they're local paths,
not URLs), so the bridge runs `extractLocalImages()` against the final
reply, replaces each surfaced local-file ref with a `[图片: <alt>]`
caption in the text reply, then sends each image as a separate Feishu
image message via `lark-cli im +messages-reply --image <relpath>` with
`cwd` set to the sandbox dir. URL refs (`https://…`) and pre-uploaded
keys (`img_…`) pass through to the markdown reply unchanged.

### Streaming card (Phase 9)

`STREAMING_CARD=true` (default for `claude-code`) replaces the text
reply with an **interactive card** that gets PATCHed live as the agent
runs. The card carries four regions: state-coloured header
(thinking → running → done/error), tool-call log (one line per
`tool_use`, oldest first, capped at 12 with overflow note), body text
(updated from `text_delta` events from `--include-partial-messages` so
the reply truly appears token-by-token), and a footer note with
duration / cost / a "🔄 重新生成" action button.

Card patches go through `CardPatcher` — a debouncing wrapper around
`lark-cli api PATCH /open-apis/im/v1/messages/<id>` that emits at most
one update every `STREAMING_CARD_MIN_INTERVAL_MS` (1200 ms by default)
while collapsing intermediate states, with a guaranteed final flush.
On send failure the bridge falls back to the legacy text path (Phase 7
"⏳ 思考中…" placeholder + Phase 8 image replies) so users always see
*something*.

Every accepted message also gets an immediate emoji reaction
(`ACK_EMOJI`, default `OK`) so the user has a "received" signal within
~200 ms — much faster than even the initial card. The reaction call is
fire-and-forget; reaction failures never block the LLM round-trip.

### Card actions (Phase 9)

When `ENABLE_CARD_CALLBACK=true` the bridge starts a second long-poll
consumer for `card.action.trigger` events alongside the existing
`im.message.receive_v1` consumer. The Feishu Developer Console for the
app must have "Callback Configuration" (应用 → 事件与回调 → 回调配置)
enabled for these events to actually fire; without that the consumer
runs cleanly but receives no events.

Currently one action is supported: `regenerate` — re-runs the most
recent user turn for that chat as a synthesised `im.message.receive_v1`
event (with a "请重新回答上一个问题" prefix to nudge the model toward a
different angle). Adding more actions is mechanical — handle them in
`onCardAction()` in `src/worker.ts`.

### Session continuity

Claude Code requires `--session-id` to be a UUID. We derive a deterministic
UUIDv4 from `chat_id` (sha256 → reshape nibbles 12 and 16 to satisfy the
v4 spec) so the same Feishu chat always maps to the same session, even
if our local `.bridge-sessions.json` is wiped. The first call uses
`--session-id` (create); every subsequent call uses `--resume`.

### Sandbox enforcement

Sandbox is enforced solely by `spawn({ cwd: CLAUDE_CODE_SANDBOX })`.
Claude Code's tools default-deny anything outside the cwd; we explicitly
do NOT pass `--add-dir` for any other directory.

**Caveat:** the bridge runs as a regular user (typically `leo` for this
project). Claude Code can `spawn` shell processes that themselves don't
honour cwd as a hard boundary — any Bash command that uses absolute
paths can technically read elsewhere. For workloads where this matters,
run the bridge as a dedicated unprivileged user with no access to the
rest of `$HOME`, or use a real container.
