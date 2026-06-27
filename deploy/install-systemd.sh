#!/usr/bin/env bash
# install-systemd.sh — install the lark-agent-bridge user-mode systemd unit.
#
# Runs as the target user (no sudo needed). Idempotent.
#
# Usage:
#   ./deploy/install-systemd.sh           # installs for the current user
#   USER_INSTANCE=alice ./...             # installs for `alice` (must be the running user)
set -euo pipefail

INSTANCE="${USER_INSTANCE:-$(id -un)}"
if [[ "$(id -un)" != "$INSTANCE" ]]; then
  echo "error: USER_INSTANCE=$INSTANCE but you are $(id -un); run as the target user." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/deploy/systemd/lark-agent-bridge@.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DST="$UNIT_DIR/lark-agent-bridge@.service"

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "error: $REPO_ROOT/.env not found — copy .env.example and fill it in first." >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
  echo "error: $REPO_ROOT/dist/index.js not found — run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
install -m 0644 "$UNIT_SRC" "$UNIT_DST"

# Allow user services to keep running after logout — otherwise the bridge
# would die when you ssh out.
sudo loginctl enable-linger "$INSTANCE" >/dev/null 2>&1 || \
  echo "warning: could not enable-linger; bridge will stop when you log out."

systemctl --user daemon-reload
systemctl --user enable --now "lark-agent-bridge@$INSTANCE.service"

echo "✓ installed and started lark-agent-bridge@$INSTANCE.service"
echo
echo "Useful commands:"
echo "  systemctl --user status  lark-agent-bridge@$INSTANCE"
echo "  systemctl --user restart lark-agent-bridge@$INSTANCE"
echo "  journalctl --user -u lark-agent-bridge@$INSTANCE -f"
