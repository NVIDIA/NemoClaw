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
    .command(process.execPath, [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy",
      env: env(),
      timeoutMs: 120_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
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

select_scope_request() {
python3 - <<'PY'
import json, sys
state=json.load(sys.stdin)
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli' or 'cli' in norm(e.get('clientId')).lower()
def scopes(e): return {norm(s) for s in (e.get('scopes') or e.get('requestedScopes') or []) if norm(s)}
def approved(e): return {norm(s) for s in (e.get('approvedScopes') or e.get('scopes') or []) if norm(s)}
paired={norm(e.get('deviceId')): e for e in state.get('paired') or [] if isinstance(e, dict)}
for req in sorted([e for e in state.get('pending') or [] if isinstance(e, dict)], key=lambda e:e.get('ts') or 0, reverse=True):
    p=paired.get(norm(req.get('deviceId')))
    requested=scopes(req)
    if is_cli(req) and p and {'operator.write','operator.read'}.intersection(requested) and not requested.issubset(approved(p)):
        print(norm(req.get('requestId')))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

assert_agent_scopes_without_admin() {
python3 - <<'PY'
import json, sys
state=json.load(sys.stdin)
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli' or 'cli' in norm(e.get('clientId')).lower()
def scopes(e): return {norm(s) for s in (e.get('approvedScopes') or e.get('scopes') or []) if norm(s)}
for dev in state.get('paired') or []:
    if not isinstance(dev, dict) or not is_cli(dev):
        continue
    approved=scopes(dev)
    if 'operator.admin' in approved:
        print('ADMIN_SCOPE_PRESENT', file=sys.stderr)
        raise SystemExit(2)
    if {'operator.write','operator.read'}.issubset(approved):
        print(norm(dev.get('deviceId')) or 'cli-device')
        raise SystemExit(0)
print('NO_AGENT_SCOPES', file=sys.stderr)
raise SystemExit(1)
PY
}

openclaw devices list --json >/tmp/issue4462-devices-list.json 2>&1 || true
state="$(state_json)"
request_id="$(printf '%s' "$state" | select_scope_request 2>/dev/null || true)"
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
  request_id="$(printf '%s' "$state" | select_scope_request 2>/dev/null || true)"
  if [ -z "$request_id" ]; then
    if printf '%s' "$state" | assert_agent_scopes_without_admin >/tmp/issue4462-approved-device.txt 2>/tmp/issue4462-approved-device.err; then
      echo "SCOPE_ALREADY_APPROVED=$(cat /tmp/issue4462-approved-device.txt)"
    elif [ "$trigger_rc" -eq 0 ] && ! grep -Eiq 'EMBEDDED FALLBACK|scope upgrade pending approval|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' /tmp/issue4462-trigger-agent.log \
      && grep -Eq '(^|[^0-9])42([^0-9]|$)' /tmp/issue4462-trigger-agent.log; then
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
  approve_output="$(openclaw devices approve "$request_id" --json 2>&1)"
  printf '%s\n' "$approve_output" >/tmp/issue4462-approve.log
  python3 - <<'PY' "$request_id" </tmp/issue4462-approve.log
import json, sys
want=sys.argv[1]
raw=sys.stdin.read()
dec=json.JSONDecoder()
for idx,ch in enumerate(raw):
    if ch != '{':
        continue
    try:
        doc,_=dec.raw_decode(raw[idx:])
    except Exception:
        continue
    if doc.get('requestId') == want:
        raise SystemExit(0)
print(raw, file=sys.stderr)
raise SystemExit(1)
PY
fi

state="$(state_json)"
printf '%s' "$state" | assert_agent_scopes_without_admin >/tmp/issue4462-final-device.txt
if printf '%s' "$state" | select_scope_request >/tmp/issue4462-pending-after.txt 2>/dev/null; then
  echo "PENDING_AFTER_APPROVAL=$(cat /tmp/issue4462-pending-after.txt)" >&2
  exit 6
fi

session_id="issue-4462-final-$(date +%s)-$$"
final_output="$(openclaw agent --agent main --json --session-id "$session_id" -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.' 2>&1)"
printf '%s\n' "$final_output" >/tmp/issue4462-final-agent.log
if grep -Eiq 'EMBEDDED FALLBACK|scope upgrade pending approval|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' /tmp/issue4462-final-agent.log; then
  echo "FINAL_AGENT_FALLBACK_OR_PAIRING" >&2
  cat /tmp/issue4462-final-agent.log >&2
  exit 7
fi
if ! grep -Eq '(^|[^0-9])42([^0-9]|$)' /tmp/issue4462-final-agent.log; then
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
