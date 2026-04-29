#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Dev-install helper invoked by `npm install` via the package.json `prepare`
# script. Runs `npm link` so the local checkout exposes the `nemoclaw` CLI,
# and on failure falls back to a user-local wrapper at ~/.local/bin/nemoclaw.
# The wrapper preserves the Node directory that was on PATH at install time
# so the shim still works in shells where Node is provisioned via nvm and
# may not be on a fresh login PATH (matches scripts/install.sh's wrapper).

set -eu

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BIN_PATH="$REPO_ROOT/bin/nemoclaw.js"
SHIM_DIR="${HOME}/.local/bin"
SHIM_PATH="$SHIM_DIR/nemoclaw"
SHIM_MARKER="# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh"

if [ -n "${NEMOCLAW_INSTALLING:-}" ]; then
  exit 0
fi
export NEMOCLAW_INSTALLING=1

if [ ! -x "$BIN_PATH" ]; then
  printf '[nemoclaw] cannot expose CLI: %s is missing or not executable\n' "$BIN_PATH" >&2
  exit 0
fi

LINK_LOG="$(mktemp -t nemoclaw-link.XXXXXX.log 2>/dev/null || mktemp)"
trap 'rm -f "$LINK_LOG"' EXIT

if (cd "$REPO_ROOT" && npm link >"$LINK_LOG" 2>&1); then
  exit 0
fi

printf '[nemoclaw] npm link failed; falling back to user-local shim.\n' >&2
if [ -s "$LINK_LOG" ]; then
  sed 's/^/[nemoclaw]   /' "$LINK_LOG" >&2
fi

NODE_PATH="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  printf '[nemoclaw] cannot create shim: node is not on PATH\n' >&2
  exit 1
fi
NODE_DIR="$(cd -- "$(dirname -- "$NODE_PATH")" && pwd)"

if [ -e "$SHIM_PATH" ] || [ -L "$SHIM_PATH" ]; then
  if ! grep -qFx "$SHIM_MARKER" "$SHIM_PATH" 2>/dev/null; then
    printf '[nemoclaw] %s already exists and is not managed by NemoClaw; not overwriting.\n' "$SHIM_PATH" >&2
    printf "[nemoclaw] Move it aside and re-run 'npm install' to install the dev shim.\n" >&2
    exit 1
  fi
fi

mkdir -p "$SHIM_DIR"

# Write to a sibling tempfile and rename so a mid-write failure (disk full,
# etc.) cannot leave an unrecognisable partial shim that the marker check
# would later refuse to overwrite.
SHIM_TMP="$(mktemp "$SHIM_DIR/nemoclaw.tmp.XXXXXX")"
trap 'rm -f "$LINK_LOG" "$SHIM_TMP"' EXIT

cat >"$SHIM_TMP" <<EOF
#!/usr/bin/env bash
$SHIM_MARKER
export PATH="$NODE_DIR:\$PATH"
exec "$BIN_PATH" "\$@"
EOF
chmod +x "$SHIM_TMP"
mv -f "$SHIM_TMP" "$SHIM_PATH"

if [ ! -x "$SHIM_PATH" ]; then
  printf '[nemoclaw] shim creation failed: %s is not executable after write\n' "$SHIM_PATH" >&2
  exit 1
fi

printf '[nemoclaw] Created user-local shim at %s -> %s\n' "$SHIM_PATH" "$BIN_PATH" >&2

case ":${PATH:-}:" in
  *":$SHIM_DIR:"*) ;;
  *)
    printf '[nemoclaw] %s is not on PATH. Add it to your shell profile, e.g.:\n' "$SHIM_DIR" >&2
    printf "[nemoclaw]   echo 'export PATH=\"%s:\$PATH\"' >> ~/.bashrc\n" "$SHIM_DIR" >&2
    ;;
esac
