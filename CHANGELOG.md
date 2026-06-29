# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Functional slash-commands** — `/`-prefixed messages run a built-in handler instead of calling the LLM. Extensible registry in `src/commands.ts` (`register({ name, description, handler })`); adding a command is one call. A handler returns `{ reply, contextNote? }` — `reply` goes straight to the chat, `contextNote` (optional) is recorded as a synthetic user turn so the *next* LLM call knows the command ran. Commands are acked with the emoji but not rate-limited (cheap/local). Shipped commands:
  - `/sandbox off` — lift the sandbox: subsequent claude-code turns run from `$HOME` (so the sandbox's restrictive `CLAUDE.md` isn't loaded) with `--add-dir /` and an authoritative `--append-system-prompt` granting full host filesystem access. Per-chat, persisted in SQLite.
  - `/sandbox on` — restore the sandbox (cwd back to `CLAUDE_CODE_SANDBOX`).
  - `/status` — system info (host, uptime), agent config (backend/model/sandbox/streaming/rate-limit), session context (chat id, claude-code session, message count), and per-chat token cost (turns + cumulative USD).
  - `/new` — start a fresh session: clears the chat's stored history and resets the claude-code session so the next turn begins clean.
  - `/help` — list commands. Unknown `/commands` reply with the help text instead of hitting the LLM.
- `src/commands.ts`, `src/rate-limit.ts`-style isolation: store gains `chat_settings` (per-chat KV) + `chat_stats` (turns + cumulative cost) tables, with `getSetting`/`setSetting`/`recordTurn`/`chatStats`/`clearHistory`.
- `larkbridge_commands_total{name}` metric.

### Changed
- **Claude Code session ids are now random UUIDs**, not a deterministic hash of `chat_id`. The deterministic scheme meant `/new` would re-derive the *same* id and collide with the orphaned server-side session (`Session ID … already in use` → `No deferred tool marker found`), so a "new" session was never actually new. `runClaudeCode` also gained symmetric self-healing: a `--session-id` that's "already in use" retries with `--resume`, and a `--resume` that finds "No conversation found" retries with `--session-id` (recovers a local map entry whose server session never got created).
- `runClaudeCode(chatId, text, opts)` — signature consolidated into an options object (`onProgress`, `abortSignal`, `fullAccess`). `fullAccess` (from `/sandbox off`) adds `--add-dir /` (placed before a flag, since it's variadic and would otherwise swallow the prompt), the override system-prompt, and switches cwd to `$HOME`.
- `src/lark/download.ts` now reads lark-cli's `saved_path` (absolute) so synthesised image/file prompts point at an absolute path that resolves in either sandbox mode.

### Verified
- All four commands round-tripped on real Feishu: `/help`, `/status`, `/sandbox off`, `/new`, plus an unknown `/foobar` → help. Each fired a `functional command` log line with **no** LLM spawn.
- `/sandbox off` end-to-end: bot read `/etc/hostname` (outside the sandbox) and returned `AGENT`, matching the real file. `/sandbox on` restores the sandbox cwd + CLAUDE.md convention.
- Sandbox state persists in `chat_settings`; `/new` clears history + resets the session (next turn mints a fresh UUID).
- `npm run lint` / `typecheck` / `build` clean.

> Note: `/sandbox on` is a *soft* boundary — because the backend runs with `--dangerously-skip-permissions`, the agent can still touch absolute paths if it decides to; the sandbox `CLAUDE.md` is advisory. A hard boundary needs OS-level isolation (dedicated user / container), tracked for a later phase. `/sandbox off`'s grant direction is reliable.

## [Phase 10] — rate limit + allow-lists + vision input + stop button + metrics

### Added
- **Per-user rate limit + allow-lists**. Token-bucket per `sender_id`, refilled smoothly across a 60 s window (`RATE_PER_USER_PER_MIN=6` default). Throttled users get a ⏰ reaction + an explicit "请约 N 秒后再试" text; the LLM call is skipped. Independent of that, two allow-list envs (`ALLOWED_USERS`, `ALLOWED_CHATS`, both empty by default) silent-drop traffic outside the allow-list. Both gates run before the LLM round-trip.
- **Vision input** (image messages → claude-code). Extracts the `img_…` key, downloads to `<sandbox>/in/`, synthesises a "用户发来图片…请用 Read 查看" turn. Phase 10.1 generalised this to **file** messages too (`file_…` key, original filename preserved, prompt nudges the agent to shell out to pandoc/pdftotext/unzip for binary docs).
- **"⏹ 停止" card button**. Routes through `card.action.trigger`, looks up the in-flight `AbortController` keyed by card-message-id, SIGTERMs the subprocess; card flushes to a grey `aborted` phase.
- **Prometheus `/metrics`** (`METRICS_PORT=9090`, localhost). Hand-rolled exposition, no `prom-client`: messages/dropped/llm-calls/cost/tool-calls/latency-histogram/card-patches/card-actions.
- New files: `src/rate-limit.ts`, `src/lark/download.ts`, `src/metrics.ts`. New envs: `ALLOWED_USERS`, `ALLOWED_CHATS`, `RATE_PER_USER_PER_MIN`, `METRICS_PORT`.

### Changed
- `runClaudeCode` gained an `AbortSignal`; on abort, SIGTERM→SIGKILL and `stopReason: 'aborted'`.
- `worker.handle()` ack-emoji + rate-limit unified into `admitAndAck()` shared by text and image/file paths.

### Verified
- One-turn smoke: metrics show messages/cost/card-patches incrementing. `.docx` file round-trip downloaded via bot identity. `npm run lint` / `typecheck` / `build` clean.

## [Phase 9] — emoji ack + streaming card PATCH + card-action callbacks

### Added
- **True streaming via interactive card PATCH** (`STREAMING_CARD=true`, default for `BACKEND=claude-code`). The reply now lands as a Feishu interactive card carrying four regions — state-coloured header (thinking → running → done/error), tool-call log (grows one line per `tool_use`), body text (appearing token-by-token from `text_delta` events) and a duration/cost footer — and the bridge PATCHes that card live as the agent loop streams events. Replaces the Phase 7 "⏳ 思考中…" text placeholder; the placeholder remains as a fallback when `STREAMING_CARD=false` or when the card-send fails.
- **Token-level text streaming**: `src/llm-claude-code.ts` spawns Claude Code with `--include-partial-messages` so each `text_delta` from the Anthropic stream arrives as its own progress event. The card body fills in chunk-by-chunk over the lifetime of the turn instead of appearing all at once at the end.
- **Emoji ack on receive** (`ACK_EMOJI=OK` by default). The bridge fires `lark-cli im reactions create --emoji_type <X>` on the user's message the moment it's accepted, giving a visible "received" signal within ~200 ms.
- **Card-action callbacks** (`ENABLE_CARD_CALLBACK=true`). Second long-poll consumer for `card.action.trigger` events alongside the message consumer. The "🔄 重新生成" button re-runs the most recent user turn with a "请重新回答上一个问题（用不同角度）" prefix.
- New files: `src/lark/reactions.ts`, `src/lark/card.ts`, `src/lark/card-send.ts` (incl. `CardPatcher` throttle), `src/lark/card-action-consume.ts`.
- New envs: `STREAMING_CARD`, `STREAMING_CARD_MIN_INTERVAL_MS`, `ACK_EMOJI`, `ENABLE_CARD_CALLBACK`. `SHOW_THINKING_PLACEHOLDER` only takes effect when `STREAMING_CARD=false`.

### Changed
- `src/worker.ts` split into a streaming-card path and a legacy text path (fallback). The two reply UIs share zero state.
- `src/llm-claude-code.ts` no longer emits `text` progress events from `assistant` envelopes (those would double-count with `text_delta` events).

### Verified
- Three scenarios on real Feishu: short no-tool reply (~9 s, thinking → done), tool-using reply (Bash entry visibly added), long-form reply (24 s, ~3000 chars — body fills in via `text_delta` patches).
- Emoji reaction confirmed on the user's message via `lark-cli im reactions list`.

## [Phase 8] — inline image replies for claude-code backend

### Added
- **Image replies for `BACKEND=claude-code`**: when Claude Code produces `![alt](path)` markdown referencing files inside the sandbox, the bridge extracts each local-file ref and sends it as a separate Feishu **image message** via `lark-cli im +messages-reply --image <relpath>` (cwd=sandbox). URLs and pre-uploaded keys pass through to the markdown reply unchanged. Refs that escape the sandbox or point at missing files are kept in the text reply with a logged warning.
- `src/lark/images.ts`: pure-function `extractLocalImages(body, sandboxDir)` returning `{ images, skipped, stripped }`.
- `src/lark/reply.ts`: new `replyImage({ messageId, image, cwd })` helper.

### Changed
- `worker.ts`: when the LLM reply contains only local image refs (text body empty after extraction), skip the text reply entirely. Empty-and-no-images still gets an explicit `(空回复)`.

### Fixed
- Doc / comment realignment after Phase 7: `--output-format json` → `stream-json --verbose`; removed false hardening claims (`NoNewPrivileges` etc., which Phase 7 dropped when switching to user-mode systemd); `src/lark/consume.ts` comment "in-memory dedup set" — SQLite-backed since Phase 2.
- Dead code: removed `replyText()` from `src/lark/reply.ts` — Phase 0/1 compat shim with zero callers.

## [Phase 7] — streaming + thinking placeholder + user-mode systemd

### Added
- **Streaming output for `BACKEND=claude-code`**: `llm-claude-code.ts` now spawns Claude Code with `--output-format stream-json --verbose` and parses the NDJSON event stream live. Tool-use, tool-result, and partial text events are forwarded to a new `onProgress` callback and surfaced in the worker's logs in real time.
- **"⏳ 思考中…" placeholder**: when `SHOW_THINKING_PLACEHOLDER=true` (default) and the Claude Code backend is in use, the bridge sends an immediate placeholder reply within ~1 second, then recalls it when the real reply lands. Smooths over the 5–15 s tool-loop latency. The recall is best-effort — if it fails (Feishu time window, permission), the user just sees two messages.
- `lark/reply.ts`: `reply()` now returns `{ ok, replyMessageId }`, and a new `recall(messageId)` helper wraps `lark-cli im messages delete --yes`.
- New env: `SHOW_THINKING_PLACEHOLDER=true|false` (default `true`).

### Changed
- `deploy/systemd/lark-agent-bridge@.service`: rewritten for **user-mode systemd**. Removed `User=`, `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` (these are system-mode features that produce `216/GROUP` failures under user systemd). Kept restart budget, SIGTERM cascade, journal output, 15 s graceful-stop window. `StartLimitIntervalSec`/`StartLimitBurst` moved into `[Unit]` (correct section).
- `deploy/install-systemd.sh`: enable-linger detection now checks `loginctl show-user` rather than relying on `sudo`'s exit code (which can lie in some configurations).

### Verified
- systemd service runs cleanly via `systemctl --user enable --now lark-agent-bridge@$USER`, SIGTERM cascades to `lark-cli` children, 4-process control group (worker + lark-cli wrapper + consumer + bus daemon), CPU 565 ms cold-start, 63 MB RSS.
- Streaming demo on real Feishu chat: "现在的时间" → placeholder sent at 1 s → tool-free direct text streamed at 4.7 s → final reply at 5.7 s → placeholder recalled at 7 s.

## [Phase 6] — Claude Code backend

### Added

### Added
- Phase 0 baseline: TypeScript skeleton, ESLint + Prettier + EditorConfig, MIT license, env-driven config (`zod`), structured logs (`pino`), in-memory session store, NDJSON event consumer, async dispatch, Anthropic SDK reply path.
- Docs: README (EN), architecture decision record (`docs/architecture.md`).
- `.env.example` with three deployable provider profiles (Anthropic / ARK / Bedrock-style proxies).

### Known issues
- Parent worker exiting on `SIGTERM` does not propagate to the `lark-cli event consume` child process; the lark-cli daemon then refuses to stop without `--force` because the orphaned consumer still holds the subscription. To be fixed in Phase 1 (process supervision + graceful cascade).

## [Phase 1] — deployment & resilience

### Added
- Auto-restart of the `lark-cli event consume` child on unexpected exit (backoff: 2s), preserving the in-memory dedup set across transient network blips.
- `deploy/systemd/lark-agent-bridge@.service` — user-mode template unit, `EnvironmentFile`-driven, with `NoNewPrivileges`/`PrivateTmp`/`ProtectSystem=strict`.
- `deploy/install-systemd.sh` — idempotent installer, enables `loginctl enable-linger` so the bot survives logout.
- `docs/deployment.md` — three deployment recipes (systemd / pm2 / Docker outline) + journalctl operator queries.

### Fixed
- SIGTERM cascade: shutdown handler now keeps the event loop alive via a refcounted interval until `stop()` resolves, then force-stops the lark-cli bus daemon via `lark-cli event stop --force`. Verified: no orphaned `lark-cli` subprocesses after SIGTERM.

## [Phase 2] — persistence

### Added
- `src/store.ts`: `better-sqlite3` (WAL, synchronous=NORMAL) store with `messages` and `seen_events` tables. Atomic `claimEvent()` via `INSERT OR IGNORE`, hourly `pruneSeenEvents()` keeping a 7-day rolling window.
- Worker now persists every user/assistant turn and reads chat history from SQLite at the start of each request — restarts no longer lose context.
- New env vars: `STORE_PATH` (default `data/bridge.sqlite`) and `SEEN_EVENT_TTL_DAYS` (default 7).

### Removed
- `src/sessions.ts` — superseded by `store.ts`.

## [Phase 3] — group chats & multi-format

### Added
- Group-chat support gated by `GROUP_TRIGGER` env: `mention` (default — react only when content starts with `@`), `all`, or `off`. P2P always triggers.
- `BOT_AT_PREFIX` env for stripping the bot's display-name `@`-prefix from group messages so the LLM doesn't see it (fallback: strip up to the first space).
- Markdown reply support: `lark/reply.ts` now accepts `format: 'markdown'`; worker heuristically picks markdown when the LLM response contains formatting sigils.
- Non-text messages (image/file/audio/post/...) get a graceful "not supported yet" reply instead of being silently dropped.
- E2E tested: user `@`-mentioned the bot in a group chat, `stripMention` correctly removed the prefix, the LLM saw clean input, reply landed in the group.

## [Phase 4] — LLM tool-use loop

### Added
- `src/tools.ts` — audited tool registry mapping lark-cli subcommands to Anthropic `tools` JSON Schema. v0.1 exposes 5 tools:
  - **read**: `lark_search_messages`, `lark_chat_messages_list`, `lark_doc_read`, `lark_base_records_search`
  - **scoped write**: `lark_send_text` (requires caller-supplied `chat_id`/`user_id`; cannot enumerate)
- `src/lark/cli.ts` — generic `runCli(argv)` helper: forces `--format json`, parses stdout, captures stderr, times out at 30s.
- `src/llm.ts` upgraded to a full tool-use loop (max 6 iterations) with a system prompt that tells the model to use tools instead of hallucinating data.
- `ENABLE_TOOLS=true|false` env (default `false`) — gates the entire tool API so non-tool-capable model proxies keep working.
- Verified end-to-end against Volcengine ARK's `/api/plan` endpoint → GLM-5.2: the model issued a real `tool_use` block, the tool ran, the model interpreted the resulting error (missing scope) and produced an actionable user-facing message.

### Security
- Tool list is a hard-coded whitelist. To add more tools, edit `src/tools.ts` and review the implication of each one (read vs write, identity required, blast radius). The CLI does **not** automatically expose every lark-cli command.

## [Phase 5] — release engineering

### Added
- `.github/workflows/ci.yml`: lint + typecheck + build on Node 20 and Node 22, runs on push to `main` and on every PR.
- `CONTRIBUTING.md` (style guide, how to add a tool, release procedure), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (threat model + reporting).
- Issue templates: `bug_report.md`, `feature_request.md`.
- `README.zh-CN.md` — Simplified Chinese translation of the README.
- CI badge in main README; Roadmap updated to show Phases 0-4 complete.
