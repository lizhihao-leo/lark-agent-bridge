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

## Roadmap

- [x] **Phase 0** — TypeScript skeleton, lint, format, license, env-driven config
- [x] **Phase 1** — systemd unit, structured logs, SIGTERM cascade, child auto-restart
- [x] **Phase 2** — SQLite-backed session + idempotency store (survives restart)
- [x] **Phase 3** — group-chat `@bot` trigger, multi-format messages, markdown replies
- [x] **Phase 4** — Tool-use loop exposing a whitelisted subset of `lark-cli` to the LLM
- [ ] **Phase 5** — Docker image, npm publish, first `v0.1.0` GitHub release

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
