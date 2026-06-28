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

The bundled systemd unit runs in **user mode**, so confinement is the
invoking user's existing file-system permissions plus whatever you
layered on top (linger, dedicated user, container). The unit itself does
not enable `NoNewPrivileges` / `ProtectSystem` / `ReadWritePaths` —
those are system-mode-only and break under `systemd --user`. For
defence-in-depth, run the bridge as a dedicated unprivileged user, or
inside a container.

The LLM tool list (`src/tools.ts`) is a whitelist by design; pull requests
that add a `*_delete` or broadcast-style tool will be reviewed extra
carefully.

For the `claude-code` backend, the sandbox is enforced solely by setting
`cwd = CLAUDE_CODE_SANDBOX` on the subprocess. Claude Code's built-in
tools default-deny anything outside cwd, but Bash subprocesses do not —
absolute paths in shell commands can read elsewhere. Don't run the
bridge as a user that holds secrets you wouldn't share with whoever can
DM the bot.
