#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Deprecated Brev compatibility wrapper.
# Prefer provisioning the host separately, then running scripts/install.sh
# or the hosted installer directly on that machine.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

_ts() { date '+%H:%M:%S'; }
info() { echo -e "${GREEN}[$(_ts) brev]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(_ts) brev]${NC} $1"; }
fail() {
  echo -e "${RED}[$(_ts) brev]${NC} $1"
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALLER_SCRIPT="${REPO_DIR}/scripts/install.sh"

[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY not set"
[ -f "$INSTALLER_SCRIPT" ] || fail "Installer not found at $INSTALLER_SCRIPT"

export NEEDRESTART_MODE=a
export DEBIAN_FRONTEND=noninteractive
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-build}"

info "\`scripts/brev-setup.sh\` is deprecated."
info "Delegating to the standard NemoClaw installer and onboard flow."

if [ -n "${CHAT_UI_URL:-}" ]; then
  info "CHAT_UI_URL=${CHAT_UI_URL}"
elif [ -z "${DISPLAY:-}" ] && [ ! -e /tmp/.X11-unix ]; then
  warn "CHAT_UI_URL is not set. Remote browser access will fail with"
  warn "'origin not allowed' unless you set CHAT_UI_URL to the public URL"
  warn "of this instance (for example https://openclaw0-<id>.brevlab.com)."
fi

if [ "${SKIP_VLLM:-}" = "1" ]; then
  info "SKIP_VLLM=1 is ignored by the generic installer path."
fi

exec bash "$INSTALLER_SCRIPT" --non-interactive --yes-i-accept-third-party-software
