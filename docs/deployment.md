# Deployment

Three supported deployment modes. Pick the one that fits your environment.

## 1. systemd (user mode) — recommended for single-host bots

The bundled unit runs the bridge as a **user service** (no root, no sudo
beyond the one-time `enable-linger` so it survives logout) and pulls
secrets from `.env` via `EnvironmentFile=`.

```bash
# from the repo root
npm ci
npm run build
cp .env.example .env && $EDITOR .env   # fill in ANTHROPIC_AUTH_TOKEN
./deploy/install-systemd.sh
```

Daily ops:

```bash
systemctl --user status   lark-agent-bridge@$USER
systemctl --user restart  lark-agent-bridge@$USER
journalctl  --user -u     lark-agent-bridge@$USER -f
```

The unit file is a template (`lark-agent-bridge@.service`) so the same
unit can host multiple users on one box (e.g. one bot per Feishu app).

### Hardening notes

The bundled unit runs in **user mode** (`--user`), so it inherits the
invoking user's privileges with no additional confinement. We deliberately
do **not** set `NoNewPrivileges`, `ProtectSystem`, or `ReadWritePaths` —
those directives are system-mode features and fail at activation under
`systemd --user` with status `216/GROUP` (Phase 7 removed them after
hitting this). For tighter isolation, run the bridge as a dedicated
unprivileged user with no access to the rest of `$HOME`, or use a real
container.

## 2. pm2 — for hosts that already use pm2

```bash
npm ci && npm run build
pm2 start dist/index.js --name lark-agent-bridge --env production
pm2 save
pm2 startup    # follow the printed sudo command once
```

`.env` is read by `dotenv` at process start, so pm2 needs no extra
environment plumbing.

## 3. Docker — for portable / Kubernetes deployments

A minimal Dockerfile is **not** provided in v0.1 because the image must
bundle the host-installed `lark-cli` (which itself runs OAuth Device Flow
against your Feishu app). Wrapping that into a container needs decisions
about credential sharing that depend on your environment. Track progress
in [issue #](https://github.com/lizhihao-leo/lark-agent-bridge/issues).

If you want to ship one anyway, the rough recipe is:

```Dockerfile
FROM node:20-bookworm-slim
RUN npm install -g @larksuite/cli@latest
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
USER 1001
CMD ["node", "dist/index.js"]
```

…and mount `~/.lark-cli/` from a pre-configured volume.

## Health checks

The bridge logs structured JSON; common operational queries:

| Question | journalctl filter |
|---|---|
| Did it ever start? | `grep '"msg":"bridge starting"'` |
| Is it receiving events? | `grep '"msg":"incoming message"'` |
| LLM endpoint failing? | `grep '"msg":"LLM call failed"'` |
| Reply API failing? | `grep '"msg":"reply failed"'` |
| Auto-restart fired? | `grep '"msg":"lark-cli event consumer exited"'` |

If the bridge can't reach Feishu the very first log line will already say
so — `lark-cli doctor` is the right next step.
