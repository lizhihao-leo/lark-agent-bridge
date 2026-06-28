# lark-agent-bridge

> Plug any LLM agent into Feishu / Lark in 5 minutes — no webhook server, no public HTTPS, no event-payload hand-rolling.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)
[![CI](https://github.com/lizhihao-leo/lark-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/lizhihao-leo/lark-agent-bridge/actions)

[简体中文](README.zh-CN.md)

`lark-agent-bridge` is a thin, batteries-included bridge between **Feishu / Lark**
events and **any Anthropic-compatible LLM** (Claude on `api.anthropic.com`,
Volcengine ARK, AWS Bedrock proxy, …). It reuses [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli)
for the hard parts — long-lived event subscription, token refresh, payload
normalization — and gives you a small, opinionated Node/TypeScript worker
you can lift into your own agent project.

This is the architecture that the `OPENCLAW_HOME` / `HERMES_HOME` agents inside
Lark use; this repo packages the same pattern as something you can `git clone`.

---

## Why long-poll instead of webhook?

| | Webhook | Long-poll (this repo) |
|---|---|---|
| Public HTTPS endpoint | required | **not required** |
| TLS cert / domain | required | not required |
| URL verification, signature checks | you implement | `lark-cli` handles it |
| Re-delivery on downtime | depends on your server | server-side replay window |
| Local development | needs tunneling | works directly |

If you ever need webhook (e.g. multi-replica deployment behind a load balancer)
the agent worker in `src/worker.ts` is the same — only the event source changes.

---

## Quick start

```bash
# 1. Install the official Lark CLI and authenticate (one-time per machine + per user)
sudo npm install -g @larksuite/cli@latest
lark-cli config init --new       # provide your App ID / App Secret
lark-cli auth login --recommend  # OAuth Device Flow, scan QR in Feishu app
lark-cli doctor                  # should be all-green

# 2. Clone and install
git clone https://github.com/lizhihao-leo/lark-agent-bridge.git
cd lark-agent-bridge
npm install

# 3. Configure
cp .env.example .env
$EDITOR .env                     # fill in ANTHROPIC_AUTH_TOKEN at minimum

# 4. Dev run
npm run dev
```

In the Feishu admin console make sure your app has:

- **Event subscription** mode set to **long connection** (not webhook)
- Event `im.message.receive_v1` added
- Scope `im:message.p2p_msg:readonly` (read) + `im:message:send_as_bot` (write) granted
- A published version (self-built apps only)

Send a private message to your bot in Feishu — within a second or two the bot
should reply with the LLM's response.

---

## Configuration

All knobs live in `.env`. See [`.env.example`](.env.example) for the full list.

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | _(required)_ | API key, `sk-ant-…` or provider equivalent |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Provider endpoint |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model ID |
| `LARK_EVENT_KEY` | `im.message.receive_v1` | Feishu event to consume |
| `LARK_EVENT_AS` | `bot` | Identity for event consumption |
| `BACKEND` | `anthropic-sdk` | `anthropic-sdk` or `claude-code` |
| `CLAUDE_CODE_SANDBOX` | `~/lark-bot-sandbox` | cwd for `claude-code` backend (also used to resolve image refs) |
| `MAX_INPUT_CHARS` | `4000` | Truncate user messages above this |
| `MAX_HISTORY_TURNS` | `12` | Per-chat context window |
| `MAX_TOKENS_REPLY` | `1024` | Cap on `max_tokens` for the LLM call |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

### Using Volcengine ARK / OpenAI-compatible / Bedrock proxies

The bridge talks to whatever endpoint `ANTHROPIC_BASE_URL` points at, as long
as it speaks the Anthropic protocol. Example for ARK:

```env
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
ANTHROPIC_AUTH_TOKEN=ark-xxxxxxxx
ANTHROPIC_MODEL=ark-code-latest
```

---

## Architecture

```
[Feishu cloud] ──long connection──> [lark-cli event daemon] ──NDJSON stdout──>
   [worker.ts]
     ├─ session history per chat_id
     ├─ Anthropic SDK call (configurable endpoint)
     └─ lark-cli im +messages-reply
```

See [`docs/architecture.md`](docs/architecture.md) for the full design
including the failure modes the worker is designed to survive.

---

## Backends

Two backends ship in the box. Pick with `BACKEND=` in `.env`.

### `anthropic-sdk` (default) — cheap, fast, single-turn

One HTTP `messages.create` per Feishu message. Session history comes from
the bridge's SQLite store; the LLM only sees what we hand it. Tool use
is an opt-in 6-iteration loop bound to a hand-curated lark-cli whitelist
(`src/tools.ts`, gated by `ENABLE_TOOLS=true`).

Best for: pure chat, low latency, predictable cost, any Anthropic-protocol
endpoint.

### `claude-code` — agentic, sandboxed

Spawns `claude -p --bare --dangerously-skip-permissions --output-format stream-json --verbose`
per Feishu message. Claude Code gets the full agent loop (Bash / Read /
Write / Edit / Grep + any MCP servers and skills you've installed) but
its cwd is locked to `CLAUDE_CODE_SANDBOX` (default `~/lark-bot-sandbox`).
Per-chat conversation state is preserved via Claude Code's own
`--session-id` / `--resume` machinery; we map each Feishu `chat_id` to a
deterministic UUIDv4 in `<sandbox>/.bridge-sessions.json`.

The bridge parses the streaming NDJSON output live: tool-use events go to
the logs in real time, `![alt](path)` markdown referencing files in the
sandbox is automatically uploaded back to Feishu as a native image
message (Phase 8), and the reply itself lands as an **interactive card**
that gets PATCHed live as the agent works (Phase 9) — state header,
growing tool log, and the body text appearing token-by-token. An emoji
reaction (default `OK`) acks the user's message within ~200 ms before
the LLM round-trip starts, and the final card carries a "🔄 重新生成"
button (callbacks require Console enablement; see `.env.example`).

Best for: multi-step agentic tasks the LLM should plan itself — search
files, write artefacts, shell out to other CLIs, etc.

| Aspect | `anthropic-sdk` | `claude-code` |
|---|---|---|
| Tool inventory | 5 hand-coded lark-cli wrappers | Claude Code's built-ins + Bash + MCP |
| Per-message cost | one model call | typically 3–15 model calls |
| Latency | 1–3 s | 3–15 s |
| Working directory | none | sandboxed |
| Session memory | bridge SQLite | Claude Code session file |
| Provider | any Anthropic-compatible endpoint | same — Claude Code respects `ANTHROPIC_*` env |

```env
# Volcengine ARK example with Claude Code backend
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
ANTHROPIC_AUTH_TOKEN=ark-xxxxxxxx
BACKEND=claude-code
CLAUDE_CODE_SANDBOX=/home/leo/lark-bot-sandbox
```

---

## Roadmap

- [x] **Phase 0** — TypeScript skeleton, lint, format, license, env-driven config
- [x] **Phase 1** — systemd unit, structured logs, SIGTERM cascade, child auto-restart
- [x] **Phase 2** — SQLite-backed session + idempotency store (survives restart)
- [x] **Phase 3** — group-chat `@bot` trigger, multi-format messages, markdown replies
- [x] **Phase 4** — Tool-use loop exposing a whitelisted subset of `lark-cli` to the LLM
- [x] **Phase 5** — CI, contributing guide, security policy, i18n
- [x] **Phase 6** — Claude Code headless backend (`BACKEND=claude-code`, sandboxed agent loop)
- [x] **Phase 7** — Streaming output (real-time tool logs) + "⏳ thinking…" placeholder + user-mode systemd hardening
- [x] **Phase 8** — Image replies for `BACKEND=claude-code` (sandbox-local PNGs auto-uploaded as Feishu image messages)
- [x] **Phase 9** — Real streaming via interactive card PATCH + emoji ack on receive + "🔄 重新生成" card-action button (callback support gated on `ENABLE_CARD_CALLBACK` + console enablement)
- [x] **Phase 10** — Production hardening: per-user rate limit + user/chat allow-lists, vision input (image messages → sandbox `in/`), "⏹ 停止" card button to abort in-flight runs, Prometheus `/metrics` endpoint
- [ ] **Phase 11** — Docker image, npm publish, `v0.1.0` release

Tracking in [issues](https://github.com/lizhihao-leo/lark-agent-bridge/issues).

---

## Development

```bash
npm run dev         # tsx watch, hot-reload
npm run typecheck   # strict tsc --noEmit
npm run lint        # eslint
npm run format      # prettier -w .
npm run build       # tsc → dist/
npm start           # node dist/index.js
```

---

## License

[MIT](LICENSE) © 2026 lizhihao-leo
