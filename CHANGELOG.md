# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **True streaming via interactive card PATCH** (`STREAMING_CARD=true`, default for `BACKEND=claude-code`). The reply now lands as a Feishu interactive card carrying four regions — state-coloured header (thinking → running → done/error), tool-call log (grows one line per `tool_use`), body text (appearing token-by-token from `text_delta` events) and a duration/cost footer — and the bridge PATCHes that card live as the agent loop streams events. Replaces the Phase 7 "⏳ 思考中…" text placeholder; the placeholder remains as a fallback when `STREAMING_CARD=false` or when the card-send fails.
- **Token-level text streaming**: `src/llm-claude-code.ts` now spawns Claude Code with `--include-partial-messages` so each `text_delta` from the Anthropic stream arrives as its own progress event. The card body fills in chunk-by-chunk over the lifetime of the turn instead of appearing all at once at the end.
- **Emoji ack on receive** (`ACK_EMOJI=OK` by default). The bridge fires `lark-cli im reactions create --emoji_type <X>` on the user's message the moment it's accepted, giving a visible "received" signal within ~200 ms — well before the much longer LLM round-trip starts. Fire-and-forget; reaction failures never block.
- **Card-action callbacks** (`ENABLE_CARD_CALLBACK=true` to opt in). When enabled, the bridge starts a second long-poll consumer for `card.action.trigger` events alongside the message consumer. Currently one action is supported: the **🔄 重新生成** button on every completed card re-runs the most recent user turn (with a "请重新回答上一个问题（用不同角度）" prefix to nudge the model). Requires Feishu Developer Console "Callback Configuration" to be enabled for the app; without that the consumer runs cleanly but receives no events.
- New files:
  - `src/lark/reactions.ts` — `react(messageId, emojiType)` wrapping `lark-cli im reactions create`.
  - `src/lark/card.ts` — `buildCard({ phase, tools, body, durationSec, costUsd, showActions })` that produces the four-region card JSON, with capped tool/body sizes to stay under Feishu's content limits.
  - `src/lark/card-send.ts` — `sendCardReply()` + `patchCard()` + `CardPatcher` (debouncing throttle, ≥ `STREAMING_CARD_MIN_INTERVAL_MS` between patches with a guaranteed final flush).
  - `src/lark/card-action-consume.ts` — `card.action.trigger` consumer, auto-restarts on subprocess exit, normalises `action_value` JSON into a typed event.
- New envs (all live in `.env.example`): `STREAMING_CARD`, `STREAMING_CARD_MIN_INTERVAL_MS`, `ACK_EMOJI`, `ENABLE_CARD_CALLBACK`. `SHOW_THINKING_PLACEHOLDER` now only takes effect when `STREAMING_CARD=false`.

### Changed
- `src/worker.ts` split into a streaming-card path (`tryStreamingCard`) and a legacy text path (`handleClaudeCode` fallback) so the two reply UIs share zero state. The previous monolithic `handle()` claude-code branch is gone.
- `src/llm-claude-code.ts` no longer emits `text` progress events from `assistant` envelopes (those would double-count with `text_delta` events). Tool-use progress still comes from `assistant`.

### Verified
- End-to-end on real Feishu, three scenarios: (1) short reply, no tools — card flips thinking → done in ~9 s; (2) tool-using reply — card shows ✓ Bash tool entry growing into a final reply with regenerate button; (3) long-form reply (24 s, ~3000 chars) — body visibly fills in over the run via `text_delta` patches.
- Emoji reaction confirmed on the user's message (`lark-cli im reactions list` returns the bot's `OK` reaction).
- `npm run lint` / `typecheck` / `build` clean.

## [Phase 8] — inline image replies for claude-code backend

### Added
- **Image replies for `BACKEND=claude-code`**: when Claude Code produces `![alt](path)` markdown referencing files inside the sandbox, the bridge now extracts each local-file ref and sends it as a separate Feishu **image message** via `lark-cli im +messages-reply --image <relpath>` (cwd=sandbox). lark-cli handles the upload-then-send flow so we never have to talk to the OpenAPI directly. URLs (`http(s)://`) and pre-uploaded keys (`img_…`) pass through to the markdown reply unchanged. Refs that escape the sandbox, contain `..`, or point at missing files are kept in the text reply with a logged warning rather than dropped silently.
- `src/lark/images.ts`: pure-function `extractLocalImages(body, sandboxDir)` returning `{ images, skipped, stripped }`. The `stripped` text replaces each surfaced ref with `[图片: <alt>]` (or `[图片]` if alt is empty) so the text reply still reads coherently.
- `src/lark/reply.ts`: new `replyImage({ messageId, image, cwd })` helper. Same error-handling contract as `reply()` — logs and resolves `{ ok: false }` rather than throwing.

### Changed
- `worker.ts`: when the LLM reply contains **only** local image refs (text body is empty after extraction), the bridge now skips the text reply entirely instead of sending a placeholder string. Empty-and-no-images still gets an explicit `(空回复)` so dropped turns are visible.

### Fixed
- Doc / comment realignment after Phase 7: `--output-format` updated from `json` to `stream-json --verbose`; deployment & security docs no longer falsely claim the unit enables `NoNewPrivileges`/`ProtectSystem`/`PrivateTmp`/`ReadWritePaths` (Phase 7 removed those when switching to user-mode systemd); `src/lark/consume.ts` comment said "in-memory dedup set" but dedup has been SQLite-backed since Phase 2.
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
