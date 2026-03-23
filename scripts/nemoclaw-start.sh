#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint. Configures OpenClaw and starts the dashboard
# gateway inside the sandbox so the forwarded host port has a live upstream.
#
# Optional env:
#   NVIDIA_API_KEY   API key for NVIDIA-hosted inference
#   CHAT_UI_URL      Browser origin that will access the forwarded dashboard

set -euo pipefail

NEMOCLAW_CMD=("$@")
CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"
PUBLIC_PORT=18789

write_auth_profile() {
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    return
  fi

  python3 - <<'PYAUTH'
import json
import os
path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    'nvidia:manual': {
        'type': 'api_key',
        'provider': 'nvidia',
        'keyRef': {'source': 'env', 'id': 'NVIDIA_API_KEY'},
        'profileId': 'nvidia:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}

print_dashboard_urls() {
  local token chat_ui_base local_url remote_url

  token="$(python3 - <<'PYTOKEN'
import json
import os
path = os.path.expanduser('~/.openclaw/openclaw.json')
try:
    cfg = json.load(open(path))
except Exception:
    print('')
else:
    print(cfg.get('gateway', {}).get('auth', {}).get('token', ''))
PYTOKEN
)"

  chat_ui_base="${CHAT_UI_URL%/}"
  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  remote_url="${chat_ui_base}/"
  if [ -n "$token" ]; then
    local_url="${local_url}#token=${token}"
    remote_url="${remote_url}#token=${token}"
  fi

  echo "[gateway] Local UI: ${local_url}"
  echo "[gateway] Remote UI: ${remote_url}"
}

start_auto_pair() {
  nohup python3 - <<'PYAUTOPAIR' >> /tmp/gateway.log 2>&1 &
import json
import subprocess
import time

DEADLINE = time.time() + 600
QUIET_POLLS = 0
APPROVED = 0

def run(*args):
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()

while time.time() < DEADLINE:
    rc, out, err = run('openclaw', 'devices', 'list', '--json')
    if rc != 0 or not out:
        time.sleep(1)
        continue
    try:
        data = json.loads(out)
    except Exception:
        time.sleep(1)
        continue

    pending = data.get('pending') or []
    paired = data.get('paired') or []
    has_browser = any((d.get('clientId') == 'openclaw-control-ui') or (d.get('clientMode') == 'webchat') for d in paired if isinstance(d, dict))

    if pending:
        QUIET_POLLS = 0
        for device in pending:
            request_id = (device or {}).get('requestId')
            if not request_id:
                continue
            arc, aout, aerr = run('openclaw', 'devices', 'approve', request_id, '--json')
            if arc == 0:
                APPROVED += 1
                print(f'[auto-pair] approved request={request_id}')
            elif aout or aerr:
                print(f'[auto-pair] approve failed request={request_id}: {(aerr or aout)[:400]}')
        time.sleep(1)
        continue

    if has_browser:
        QUIET_POLLS += 1
        if QUIET_POLLS >= 4:
            print(f'[auto-pair] browser pairing converged approvals={APPROVED}')
            break
    elif APPROVED > 0:
        QUIET_POLLS += 1
    else:
        QUIET_POLLS = 0

    time.sleep(1)
else:
    print(f'[auto-pair] watcher timed out approvals={APPROVED}')
PYAUTOPAIR
  echo "[gateway] auto-pair watcher launched (pid $!)"
}

echo 'Setting up NemoClaw...'
# openclaw doctor --fix and openclaw plugins install already ran at build time
# (Dockerfile Step 28). At runtime they fail with EPERM against the locked
# /sandbox/.openclaw directory and accomplish nothing.

# Ensure writable state directories exist and are owned by the current user.
# The Docker build (Dockerfile) sets this up correctly, but the native curl
# installer may create these directories as root, causing EACCES when openclaw
# tries to write device-auth.json or other state files.  Ref: #692
fix_openclaw_data_ownership() {
  local data_dir="${HOME}/.openclaw-data"
  local openclaw_dir="${HOME}/.openclaw"

  # Only act when the split layout (.openclaw-data + symlinks) is present.
  [ -d "$data_dir" ] || return 0

  # Create any missing writable subdirectories (mirrors Dockerfile setup).
  local subdirs="agents/main/agent extensions workspace skills hooks identity devices canvas cron"
  for sub in $subdirs; do
    mkdir -p "${data_dir}/${sub}" 2>/dev/null || true
  done

  # Fix ownership if the top-level data dir is not owned by us (common when
  # the entire tree was created as root during installation).
  if find "$data_dir" -maxdepth 2 ! -user "$(id -u)" -print -quit 2>/dev/null | grep -q .; then
    chown -R "$(id -u):$(id -g)" "$data_dir" 2>/dev/null || true
    echo "[setup] fixed ownership on ${data_dir}"
  fi

  # Ensure the identity symlink exists (may be missing on native installs).
  # Remove any broken symlinks first to prevent conflicts.
  if [ ! -L "${openclaw_dir}/identity" ] && [ ! -e "${openclaw_dir}/identity" ] && [ -d "${data_dir}/identity" ]; then
    ln -sf "${data_dir}/identity" "${openclaw_dir}/identity" 2>/dev/null || true
    echo "[setup] created identity symlink"
  elif [ -L "${openclaw_dir}/identity" ] && [ ! -e "${openclaw_dir}/identity" ]; then
    rm -f "${openclaw_dir}/identity"
    ln -sf "${data_dir}/identity" "${openclaw_dir}/identity" 2>/dev/null || true
    echo "[setup] replaced broken identity symlink"
  fi
}
fix_openclaw_data_ownership

write_auth_profile

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${NEMOCLAW_CMD[@]}"
fi

nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
echo "[gateway] openclaw gateway launched (pid $!)"
start_auto_pair
print_dashboard_urls
