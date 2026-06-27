# Security policy

## Supported versions

`lark-agent-bridge` is pre-1.0; only the latest `main` is supported.
Once 1.x lands, security fixes will be backported one minor version.

## Reporting a vulnerability

Please **do not** open a public GitHub issue. Instead email the maintainer
(see commit author of any recent commit on `main`) with:

- A short description of the issue
- A reproduction or proof of concept
- Whether you're OK with public credit

Expect an acknowledgment within 7 days.

## Threat model snapshot

The bridge holds three sensitive things:

1. **`lark-cli` config + OAuth tokens** in `~/.lark-cli/` — owned by the
   running user. The bridge itself never reads these files; it shells out
   to `lark-cli` which manages them. Compromise of this dir means full
   Feishu access for the bot identity + the authed user identities.
2. **`ANTHROPIC_AUTH_TOKEN`** in `.env` (mode 0600 by default if you
   `cp .env.example .env`). Compromise = LLM-cost exfiltration.
3. **`data/bridge.sqlite`** — contains chat histories. Compromise =
   message content leak.

Mitigations baked into the unit file:
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, restricted
`ReadWritePaths`. Run the bridge as a **non-root** user.

The LLM tool list (`src/tools.ts`) is a whitelist by design; pull requests
that add a `*_delete` or broadcast-style tool will be reviewed extra
carefully.
