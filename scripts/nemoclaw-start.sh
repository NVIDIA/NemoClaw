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
#   NEMOCLAW_SKIP_AUTO_PAIR     Set to 1/true/yes to disable auto-pair watcher
#   NEMOCLAW_AUTO_PAIR_TIMEOUT  Auto-pair timeout in seconds (default: 120)

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

# Print the local and remote dashboard URLs, appending the auth token if present.
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

# Launch a background watcher that auto-approves pending device-pair requests.
start_auto_pair() {
  case "$(echo "${NEMOCLAW_SKIP_AUTO_PAIR:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes)
      echo "[gateway] auto-pair watcher skipped (NEMOCLAW_SKIP_AUTO_PAIR is set)"
      return
      ;;
  esac
  local pair_timeout="${NEMOCLAW_AUTO_PAIR_TIMEOUT:-120}"
  if ! [[ "$pair_timeout" =~ ^[0-9]+$ ]] || [ "$pair_timeout" -le 0 ]; then
    pair_timeout=120
  fi
  export NEMOCLAW_AUTO_PAIR_TIMEOUT="$pair_timeout"
  echo "[gateway] auto-pair watcher launching (timeout=${pair_timeout}s)"
  nohup python3 - <<'PYAUTOPAIR' >> /tmp/gateway.log 2>&1 &
import json
import os
import subprocess
import time

try:
    timeout = int(os.environ.get('NEMOCLAW_AUTO_PAIR_TIMEOUT', '120'))
    if timeout <= 0:
        timeout = 120
except ValueError:
    timeout = 120
DEADLINE = time.time() + timeout
QUIET_POLLS = 0
APPROVED = 0
print(f'[auto-pair] watcher launched (timeout={timeout}s)')

def run(*args):
    """Run a subprocess and return (returncode, stdout, stderr)."""
    remaining = max(1, int(DEADLINE - time.time()))
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=remaining)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, '', f'subprocess timed out after {remaining}s'

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
write_auth_profile

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${NEMOCLAW_CMD[@]}"
fi

nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
echo "[gateway] openclaw gateway launched (pid $!)"
start_auto_pair
print_dashboard_urls
