// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-issue-4462-scope-upgrade-approval.sh. */

import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-issue-4462-vitest";
const LIVE_TIMEOUT_MS = 70 * 60_000;
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "30",
    NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "3",
    NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10",
    NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "600",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await host
    .command(
      process.execPath,
      [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"],
      {
        artifactName: "cleanup-nemoclaw-destroy",
        env: env(),
        timeoutMs: 120_000,
      },
    )
    .catch(() => undefined);
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "remove", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

function scopeUpgradeScript(): string {
  return String.raw`
set -euo pipefail
if [ ! -r /tmp/nemoclaw-proxy-env.sh ]; then
  echo "MISSING_PROXY_ENV" >&2
  exit 2
fi
if ! grep -F "unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN; command openclaw" /tmp/nemoclaw-proxy-env.sh >/dev/null; then
  echo "MISSING_APPROVE_GUARD" >&2
  exit 3
fi
. /tmp/nemoclaw-proxy-env.sh
case "\${OPENCLAW_GATEWAY_URL:-}" in
  ws://127.0.0.1:*|ws://localhost:*) ;;
  ws://10.*:*|ws://192.168.*:*|ws://172.1[6-9].*:*|ws://172.2[0-9].*:*|ws://172.3[0-1].*:*)
    if [ "\${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" != "1" ]; then
      echo "MISSING_INSECURE_PRIVATE_WS_MARKER=\${OPENCLAW_GATEWAY_URL:-unset}" >&2
      exit 4
    fi
    ;;
  *) echo "BAD_GATEWAY_URL=\${OPENCLAW_GATEWAY_URL:-unset}" >&2; exit 4 ;;
esac

state_json() {
python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw') / 'devices'
def load(name):
    try:
        value = json.loads((root / name).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    return value if isinstance(value, dict) else {}
print(json.dumps({'pending': list(load('pending.json').values()), 'paired': list(load('paired.json').values())}, sort_keys=True))
PY
}

select_initial_pairing_request() {
python3 - 3<&0 <<'PY'
import json, os
state=json.load(os.fdopen(3))
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli' or 'cli' in norm(e.get('clientId')).lower()
paired={norm(e.get('deviceId')) for e in state.get('paired') or [] if isinstance(e, dict)}
for req in sorted([e for e in state.get('pending') or [] if isinstance(e, dict)], key=lambda e:e.get('ts') or 0, reverse=True):
    if is_cli(req) and norm(req.get('deviceId')) not in paired and norm(req.get('requestId')):
        print(norm(req.get('requestId')))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

select_paired_cli_device() {
python3 - 3<&0 <<'PY'
import json, os
state=json.load(os.fdopen(3))
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli' or 'cli' in norm(e.get('clientId')).lower()
for dev in sorted([e for e in state.get('paired') or [] if isinstance(e, dict)], key=lambda e:e.get('approvedAtMs') or 0, reverse=True):
    scopes={norm(s) for s in (dev.get('approvedScopes') or dev.get('scopes') or []) if norm(s)}
    if is_cli(dev) and norm(dev.get('deviceId')) and 'operator.admin' not in scopes:
        print(norm(dev.get('deviceId')))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

rotate_cli_to_pairing_scope() {
  local device_id="$1" rotate_output
  rotate_output="$(
    unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
    command openclaw devices rotate --device "$device_id" --role operator \
      --scope operator.pairing --json 2>&1
  )"
  (
    local rotate_log
    umask 077
    rotate_log="$(mktemp /tmp/issue4462-rotate.XXXXXX)"
    trap 'rm -f "$rotate_log"' EXIT
    printf '%s\n' "$rotate_output" >"$rotate_log"
    python3 - "$device_id" "$rotate_log" <<'PY'
import json, os, sys
from pathlib import Path

want=sys.argv[1]
raw=Path(sys.argv[2]).read_text(encoding='utf-8')
dec=json.JSONDecoder()
result=None
for idx,ch in enumerate(raw):
    if ch != '{':
        continue
    try:
        doc,_=dec.raw_decode(raw[idx:])
    except Exception:
        continue
    if doc.get('deviceId') == want and isinstance(doc.get('token'), str):
        result=doc
        break
if result is None:
    raise SystemExit('device token rotation did not return the expected JSON')
scopes={str(scope).strip() for scope in result.get('scopes') or [] if str(scope).strip()}
if scopes != {'operator.pairing'}:
    raise SystemExit(f'unexpected rotated scopes: {sorted(scopes)}')

root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
identity_path=root / 'identity' / 'device.json'
auth_path=root / 'identity' / 'device-auth.json'
paired_path=root / 'devices' / 'paired.json'
identity=json.loads(identity_path.read_text(encoding='utf-8'))
if str(identity.get('deviceId') or '').strip() != want:
    raise SystemExit('rotated device does not match the persisted CLI identity')

paired=json.loads(paired_path.read_text(encoding='utf-8'))
paired_key=next((key for key,value in paired.items() if isinstance(value, dict) and str(value.get('deviceId') or '').strip() == want), None)
if paired_key is None:
    raise SystemExit('rotated device is missing from paired state')
paired_device=paired[paired_key]
paired_device['scopes']=['operator.pairing']
paired_device['approvedScopes']=['operator.pairing']
paired_tmp=paired_path.with_name('.paired.json.tmp')
paired_tmp.write_text(json.dumps(paired, indent=2, sort_keys=True) + '\n', encoding='utf-8')
os.chmod(paired_tmp, 0o660)
os.replace(paired_tmp, paired_path)

try:
    auth=json.loads(auth_path.read_text(encoding='utf-8'))
except FileNotFoundError:
    auth={}
if not isinstance(auth, dict) or auth.get('deviceId') != want:
    auth={'version': 1, 'deviceId': want, 'tokens': {}}
tokens=auth.get('tokens') if isinstance(auth.get('tokens'), dict) else {}
tokens['operator']={
    'token': result['token'],
    'role': 'operator',
    'scopes': ['operator.pairing'],
    'updatedAtMs': result.get('rotatedAtMs'),
}
auth['version']=1
auth['deviceId']=want
auth['tokens']=tokens
auth_path.parent.mkdir(parents=True, exist_ok=True)
tmp=auth_path.with_name('.device-auth.json.tmp')
tmp.write_text(json.dumps(auth, indent=2, sort_keys=True) + '\n', encoding='utf-8')
os.chmod(tmp, 0o600)
os.replace(tmp, auth_path)
print(json.dumps({'deviceId': want, 'scopes': sorted(scopes)}, sort_keys=True))
PY
  )
}

select_scope_request() {
  local expected_device_id="$1"
python3 - "$expected_device_id" 3<&0 <<'PY'
import json, os, sys
state=json.load(os.fdopen(3))
expected_device_id=sys.argv[1]
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli' or 'cli' in norm(e.get('clientId')).lower()
def scopes(e): return {norm(s) for s in (e.get('scopes') or e.get('requestedScopes') or []) if norm(s)}
def approved(e): return {norm(s) for s in (e.get('approvedScopes') or e.get('scopes') or []) if norm(s)}
paired={norm(e.get('deviceId')): e for e in state.get('paired') or [] if isinstance(e, dict)}
for req in sorted([e for e in state.get('pending') or [] if isinstance(e, dict)], key=lambda e:e.get('ts') or 0, reverse=True):
    request_device_id=norm(req.get('deviceId'))
    if request_device_id != expected_device_id:
        continue
    p=paired.get(request_device_id)
    requested=scopes(req)
    is_upgrade = p is None or not requested.issubset(approved(p))
    if is_cli(req) and {'operator.write','operator.read'}.intersection(requested) and is_upgrade and norm(req.get('requestId')):
        print(norm(req.get('requestId')))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

contains_integer_42() {
  local raw compact
  raw="$(cat)"
  compact="$(printf '%s' "$raw" | tr -d '[:space:]')"
  grep -Eq '(^|[^0-9])42([^0-9]|$)' <<<"$compact"
}

assert_agent_scopes_without_admin() {
  local expected_device_id="$1"
python3 - "$expected_device_id" 3<&0 <<'PY'
import json, os, sys
state=json.load(os.fdopen(3))
expected_device_id=sys.argv[1]
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli' or 'cli' in norm(e.get('clientId')).lower()
def scopes(e): return {norm(s) for s in (e.get('approvedScopes') or e.get('scopes') or []) if norm(s)}
for dev in state.get('paired') or []:
    if not isinstance(dev, dict) or not is_cli(dev) or norm(dev.get('deviceId')) != expected_device_id:
        continue
    approved=scopes(dev)
    if 'operator.admin' in approved:
        print('ADMIN_SCOPE_PRESENT', file=sys.stderr)
        raise SystemExit(2)
    if 'operator.write' in approved:
        print(norm(dev.get('deviceId')) or 'cli-device')
        raise SystemExit(0)
print('NO_AGENT_SCOPES', file=sys.stderr)
raise SystemExit(1)
PY
}

approve_request() {
  local request_id="$1" approve_output approve_log
  approve_output="$(openclaw devices approve "$request_id" --json 2>&1)"
  approve_log="/tmp/issue4462-approve-$request_id.log"
  printf '%s\n' "$approve_output" >"$approve_log"
  python3 - "$request_id" "$approve_log" <<'PY'
import json, os, sys
from pathlib import Path

want=sys.argv[1]
raw=open(sys.argv[2], encoding='utf-8').read()
dec=json.JSONDecoder()
approved=None
for idx,ch in enumerate(raw):
    if ch != '{':
        continue
    try:
        doc,_=dec.raw_decode(raw[idx:])
    except Exception:
        continue
    if doc.get('requestId') == want:
        approved=doc
        break
if approved is None:
    print(raw, file=sys.stderr)
    raise SystemExit(1)

device=approved.get('device') if isinstance(approved.get('device'), dict) else {}
device_id=str(device.get('deviceId') or '').strip()
if not device_id:
    raise SystemExit('approval response did not include a device id')
root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
identity=json.loads((root / 'identity' / 'device.json').read_text(encoding='utf-8'))
if str(identity.get('deviceId') or '').strip() != device_id:
    raise SystemExit('approved device does not match the persisted CLI identity')
paired=json.loads((root / 'devices' / 'paired.json').read_text(encoding='utf-8'))
paired_device=next((value for value in paired.values() if isinstance(value, dict) and str(value.get('deviceId') or '').strip() == device_id), None)
if paired_device is None:
    raise SystemExit('approved device is missing from paired state')
tokens=paired_device.get('tokens') if isinstance(paired_device.get('tokens'), dict) else {}
operator=tokens.get('operator') if isinstance(tokens.get('operator'), dict) else {}
if not isinstance(operator.get('token'), str) or not operator.get('token'):
    raise SystemExit('approved device has no operator token')
auth_path=root / 'identity' / 'device-auth.json'
try:
    auth=json.loads(auth_path.read_text(encoding='utf-8'))
except FileNotFoundError:
    auth={}
if not isinstance(auth, dict) or auth.get('deviceId') != device_id:
    auth={'version': 1, 'deviceId': device_id, 'tokens': {}}
auth_tokens=auth.get('tokens') if isinstance(auth.get('tokens'), dict) else {}
auth_tokens['operator']={
    'token': operator['token'],
    'role': 'operator',
    'scopes': operator.get('scopes') or [],
    'updatedAtMs': operator.get('updatedAtMs') or operator.get('rotatedAtMs') or operator.get('createdAtMs'),
}
auth['version']=1
auth['deviceId']=device_id
auth['tokens']=auth_tokens
auth_path.parent.mkdir(parents=True, exist_ok=True)
tmp=auth_path.with_name('.device-auth.json.tmp')
tmp.write_text(json.dumps(auth, indent=2, sort_keys=True) + '\n', encoding='utf-8')
os.chmod(tmp, 0o600)
os.replace(tmp, auth_path)
print(json.dumps({'deviceId': device_id, 'requestId': want}, sort_keys=True))
PY
}

initial_list_rc=0
echo "ISSUE_4462_STAGE=direct-local-bootstrap"
(
  unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
  command openclaw devices list --json
) >/tmp/issue4462-devices-list.json 2>&1 || initial_list_rc=$?
printf '%s\n' "$initial_list_rc" >/tmp/issue4462-devices-list.rc
state="$(state_json)"
initial_request_id="$(printf '%s' "$state" | select_initial_pairing_request 2>/dev/null || true)"
if [ -n "$initial_request_id" ]; then
  echo "DIRECT_LOCAL_BOOTSTRAP_PENDING request=$initial_request_id rc=$initial_list_rc" >&2
  exit 5
fi
paired_device_id="$(printf '%s' "$state" | select_paired_cli_device 2>/dev/null || true)"
if [ -z "$paired_device_id" ]; then
  echo "NO_INITIAL_PAIRED_CLI_DEVICE rc=$initial_list_rc" >&2
  exit 5
fi
echo "ISSUE_4462_STAGE=rotate-cli-to-pairing"
rotate_cli_to_pairing_scope "$paired_device_id" >/tmp/issue4462-initial-pairing.log
state="$(state_json)"
request_id="$(printf '%s' "$state" | select_scope_request "$paired_device_id" 2>/dev/null || true)"
if [ -z "$request_id" ]; then
  session_id="issue-4462-trigger-$(date +%s)-$$"
  rm -f "/sandbox/.openclaw/agents/main/sessions/\${session_id}.jsonl.lock" \
        "/sandbox/.openclaw/agents/main/sessions/\${session_id}.trajectory.jsonl" 2>/dev/null || true
  set +e
  trigger_output="$(openclaw agent --agent main --json --session-id "$session_id" -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.' 2>&1)"
  trigger_rc=$?
  set -e
  printf '%s\n' "$trigger_output" >/tmp/issue4462-trigger-agent.log
  state="$(state_json)"
  request_id="$(printf '%s' "$state" | select_scope_request "$paired_device_id" 2>/dev/null || true)"
  if [ -z "$request_id" ]; then
    if printf '%s' "$state" | assert_agent_scopes_without_admin "$paired_device_id" >/tmp/issue4462-approved-device.txt 2>/tmp/issue4462-approved-device.err; then
      echo "SCOPE_ALREADY_APPROVED=$(cat /tmp/issue4462-approved-device.txt)"
    elif [ "$trigger_rc" -eq 0 ] && ! grep -Eiq 'EMBEDDED FALLBACK|scope upgrade pending approval|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' /tmp/issue4462-trigger-agent.log \
      && contains_integer_42 </tmp/issue4462-trigger-agent.log; then
      echo "TRIGGER_COMPLETED_WITHOUT_PENDING_SCOPE_UPGRADE"
      echo "ISSUE_4462_SCOPE_UPGRADE_OK device=trigger-completed request=not-reproduced"
      exit 0
    else
      echo "NO_SCOPE_REQUEST" >&2
      cat /tmp/issue4462-trigger-agent.log >&2
      printf '%s\n' "$state" >&2
      exit 5
    fi
  fi
fi

if [ -n "$request_id" ]; then
  echo "ISSUE_4462_STAGE=approve-scope-upgrade request=$request_id"
  approve_request "$request_id"
fi

state="$(state_json)"
printf '%s' "$state" | assert_agent_scopes_without_admin "$paired_device_id" >/tmp/issue4462-final-device.txt
if printf '%s' "$state" | select_scope_request "$paired_device_id" >/tmp/issue4462-pending-after.txt 2>/dev/null; then
  echo "PENDING_AFTER_APPROVAL=$(cat /tmp/issue4462-pending-after.txt)" >&2
  exit 6
fi

session_id="issue-4462-final-$(date +%s)-$$"
echo "ISSUE_4462_STAGE=final-gateway-agent"
final_output="$(openclaw agent --agent main --json --session-id "$session_id" -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.' 2>&1)"
printf '%s\n' "$final_output" >/tmp/issue4462-final-agent.log
if grep -Eiq 'EMBEDDED FALLBACK|scope upgrade pending approval|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' /tmp/issue4462-final-agent.log; then
  echo "FINAL_AGENT_FALLBACK_OR_PAIRING" >&2
  cat /tmp/issue4462-final-agent.log >&2
  exit 7
fi
if ! contains_integer_42 </tmp/issue4462-final-agent.log; then
  echo "FINAL_AGENT_MISSING_42" >&2
  cat /tmp/issue4462-final-agent.log >&2
  exit 8
fi
echo "ISSUE_4462_SCOPE_UPGRADE_OK device=$(cat /tmp/issue4462-final-device.txt) request=\${request_id:-auto}"
`;
}

liveTest(
  "issue 4462 scope-upgrade approval stays on gateway path without admin leak",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    await artifacts.writeJson("scenario.json", {
      id: "issue-4462-scope-upgrade-approval",
      legacySource: "test/e2e/test-issue-4462-scope-upgrade-approval.sh",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "install.sh creates a real OpenClaw sandbox",
        "proxy env exposes a loopback gateway and contains the devices approve guard",
        "CLI scope upgrade is approved without operator.admin",
        "final openclaw agent turn stays on the gateway path and answers 42",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
      skip(`Docker is required: ${resultText(docker)}`);
    }

    cleanupRegistry.add("remove issue-4462 sandbox", () => cleanup(host, sandbox));
    await cleanup(host, sandbox);

    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-1-install-sh",
        cwd: REPO_ROOT,
        env: env({ NVIDIA_INFERENCE_API_KEY: apiKey }),
        redactionValues: [apiKey],
        timeoutMs: 30 * 60_000,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);

    const encodedScopeUpgradeScript = Buffer.from(
      scopeUpgradeScript().replaceAll("\\${", "${"),
      "utf8",
    ).toString("base64");
    const probe = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        `tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; printf '%s' '${encodedScopeUpgradeScript}' | base64 -d > "$tmp"; bash "$tmp"`,
      ],
      {
        artifactName: "phase-2-scope-upgrade-approval",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 12 * 60_000,
      },
    );
    expect(probe.exitCode, resultText(probe)).toBe(0);
    expect(resultText(probe)).toContain("ISSUE_4462_SCOPE_UPGRADE_OK");

    await cleanup(host, sandbox);
    await artifacts.writeJson("scenario-result.json", {
      id: "issue-4462-scope-upgrade-approval",
      status: "passed",
    });
  },
);
