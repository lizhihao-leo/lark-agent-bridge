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
                              │  ├─ event_id dedup (in-memory)    │
                              │  ├─ session history (per chat)    │
                              │  ├─ src/llm.ts  →  Anthropic SDK  │──> LLM endpoint
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
real time; Feishu retries for a bounded window but not forever. Phase 2 adds
SQLite-backed `event_id` dedup so that restarts inside that window don't cause
double-handling.

### 2. Stdin to `lark-cli event consume` MUST stay open

lark-cli treats stdin EOF as a graceful-shutdown signal in unbounded mode.
Spawning with `stdio: ['ignore', 'pipe', 'inherit']` makes the child exit
within seconds with `context canceled`. We use `'pipe'` for stdin and never
write to it.

### 3. Async dispatch, never block the consumer loop

`onEvent` returns immediately after kicking off `handle(...)` as a detached
async task. A slow LLM call cannot back up the event reader, which would
otherwise pile up unread events and risk re-delivery storms.

### 4. The Anthropic SDK is the abstraction boundary

We deliberately do not expose model/provider details outside `src/llm.ts`.
Phase 4 will switch to a Strategy with multiple providers (Bedrock, OpenAI-
compatible, etc.) by re-implementing only that module; everything else stays
untouched.

### 5. Event payload is flat — no `event` / `header` wrapper

Captured live (see `src/lark/types.ts` comment). All fields — `event_id`,
`message_id`, `chat_id`, `content`, etc. — live at the root level. `content`
is **pre-rendered to plain text** by lark-cli; callers must not
`JSON.parse(content).text` (which is what the raw Feishu webhook payload
needs).

## Failure modes & responses

| Failure | What happens | Mitigation |
|---|---|---|
| LLM endpoint returns 5xx / network blip | `handle()` catches, replies with error string, conversation continues | Phase 4 will add provider retry/backoff |
| `lark-cli event` child dies | `child.on('exit')` propagates to a non-zero process exit; systemd / pm2 restarts the worker | Phase 1 |
| Duplicate event delivery (Feishu side) | In-memory `seenEvents` set; SQLite in Phase 2 |
| Reply API failure | Logged, conversation moves on; user sees nothing arrive | Phase 1 will surface to caller (out-of-band notifier) |
| Worker restart mid-conversation | All in-memory state lost (session history, dedup). Acceptable for chat use | Phase 2 |
