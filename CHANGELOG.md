# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
