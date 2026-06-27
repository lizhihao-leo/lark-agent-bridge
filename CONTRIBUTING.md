# Contributing

Thanks for considering a contribution! lark-agent-bridge aims to stay a
small, opinionated, audited bridge — not a kitchen-sink framework. Please
read this guide before opening a non-trivial PR.

## Setup

```bash
git clone https://github.com/lizhihao-leo/lark-agent-bridge.git
cd lark-agent-bridge
npm install
cp .env.example .env       # fill in at least ANTHROPIC_AUTH_TOKEN
npm run dev                # tsx watch
```

You also need `lark-cli` installed and configured for the Feishu app you
want to test against (`npm i -g @larksuite/cli && lark-cli config init --new
&& lark-cli auth login --recommend`).

## Quality bar

Every PR must pass on Node 20 and Node 22:

```bash
npm run lint
npm run typecheck
npm run build
```

The CI runs this exact matrix.

## Style guide

- TypeScript, strict mode. No `any` without a comment justifying it.
- Prefer small functions and explicit named exports over default exports.
- Match the existing comment density: explain **why**, not **what**. The
  long comment block in `src/lark/consume.ts` explaining the stdin-EOF
  pitfall is a good example.
- `pino` for logs. No `console.log` — `console.error` is reserved for
  pre-logger config errors only.

## Adding a tool

`src/tools.ts` is a whitelist. To add a new tool:

1. Map it to a single `lark-cli` subcommand. Compose subcommands inside
   the bridge if you need a higher-level abstraction.
2. Choose the minimum identity (`bot` vs `user`) the tool needs.
3. Document the blast radius. A `..._delete` tool is not necessarily
   rejected, but it must be opt-in via env at minimum.
4. Update `CHANGELOG.md` with a `### Security` note listing what the
   tool can do.

## Filing issues

Use the templates in `.github/ISSUE_TEMPLATE/`. For bug reports include:

- `lark-cli --version`
- A redacted snippet from `journalctl --user -u lark-agent-bridge@$USER`
- The exact LLM endpoint + model you're targeting

## Releasing

Maintainers only:

1. Bump `version` in `package.json`.
2. Move the `[Unreleased]` section of `CHANGELOG.md` under a new
   `[vX.Y.Z] — YYYY-MM-DD` heading.
3. `git tag vX.Y.Z && git push --tags`.
4. Use the GitHub release UI; CI artifacts are not auto-published.
