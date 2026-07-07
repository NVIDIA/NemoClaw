// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-cloud-onboard";
const CHECKS_DIR = path.join(REPO_ROOT, "test/e2e/e2e-cloud-experimental/checks");
const LIVE_TIMEOUT_MS = 60 * 60_000;

validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_POLICY_MODE: "custom",
    NEMOCLAW_POLICY_PRESETS: "npm,pypi",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function cleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: { verify: boolean; label: string },
): Promise<void> {
  const args = [path.join(REPO_ROOT, "test/e2e/e2e-cloud-experimental/cleanup.sh")];
  if (options.verify) args.push("--verify");
  const cleanupResult = await host.command("bash", args, {
    artifactName: `${options.label}-cloud-experimental-cleanup`,
    env: env(),
    timeoutMs: 180_000,
  });
  if (options.verify) {
    expect(cleanupResult.exitCode, resultText(cleanupResult)).toBe(0);
  }

  const gatewayDestroy = await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
    artifactName: `${options.label}-openshell-gateway-destroy`,
    env: env(),
    timeoutMs: 60_000,
  });
  if (options.verify && gatewayDestroy.exitCode !== 0) {
    expect(resultText(gatewayDestroy)).toMatch(
      /unrecognized subcommand|not found|No active gateway/i,
    );
  }
}

async function assertPackagedInitialCliPairing(sandbox: SandboxClient): Promise<void> {
  const result = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(String.raw`
set -euo pipefail
auto_pair_log=/tmp/auto-pair.log
device_id="$(python3 - <<'PY'
import json
from pathlib import Path

identity = json.loads(
    Path("/sandbox/.openclaw/identity/device.json").read_text(encoding="utf-8")
)
device_id = str(identity.get("deviceId") or "").strip()
if not device_id:
    raise SystemExit("CLI identity has no deviceId")
print(device_id)
PY
)"
marker_count_before="$(grep -c 'approved initial CLI pairing request=' "$auto_pair_log" 2>/dev/null || true)"
if ! (
  unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
  openclaw devices remove "$device_id" --json
) >/tmp/nemoclaw-6113-device-remove.json 2>/tmp/nemoclaw-6113-device-remove.err; then
  echo "CANONICAL_DEVICE_REMOVE_FAILED" >&2
  cat /tmp/nemoclaw-6113-device-remove.err >&2
  exit 20
fi
rm -f /sandbox/.openclaw/identity/device-auth.json
if [ -e /sandbox/.openclaw/identity/device-auth.json ]; then
  echo "LOCAL_DEVICE_AUTH_RESET_FAILED" >&2
  exit 21
fi

devices_json=/tmp/nemoclaw-6113-devices.json
devices_err=/tmp/nemoclaw-6113-devices.err
attempt=0
while :; do
  (
    unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
    openclaw devices list --json
  ) >"$devices_json" 2>"$devices_err" || true
  marker_count_after="$(grep -c 'approved initial CLI pairing request=' "$auto_pair_log" 2>/dev/null || true)"
  if [ "$marker_count_after" -gt "$marker_count_before" ]; then
    break
  fi
  if [ "$attempt" -ge 30 ]; then
    echo "INITIAL_CLI_PAIRING_MARKER_MISSING" >&2
    cat "$auto_pair_log" >&2 2>/dev/null || true
    exit 22
  fi
  attempt=$((attempt + 1))
  sleep 1
done

attempt=0
while ! (
  unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
  openclaw devices list --json
) >"$devices_json" 2>"$devices_err"; do
  if [ "$attempt" -ge 10 ]; then
    echo "POST_BOOTSTRAP_DEVICES_LIST_FAILED" >&2
    cat "$devices_err" >&2
    exit 23
  fi
  attempt=$((attempt + 1))
  sleep 1
done

python3 - "$devices_json" <<'PY'
import json
import sys
from pathlib import Path

value = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
pending = value.get("pending") or []
paired = value.get("paired") or []
if isinstance(pending, dict):
    pending = list(pending.values())
if isinstance(paired, dict):
    paired = list(paired.values())
if not isinstance(pending, list) or not isinstance(paired, list):
    raise SystemExit("devices list must expose pending and paired collections")
if pending:
    raise SystemExit(f"initial CLI pairing left pending requests: {len(pending)}")
identity = json.loads(
    Path("/sandbox/.openclaw/identity/device.json").read_text(encoding="utf-8")
)
device_id = str(identity.get("deviceId") or "").strip()
matches = [
    device
    for device in paired
    if isinstance(device, dict)
    and str(device.get("deviceId") or "").strip() == device_id
    and device.get("clientId") == "cli"
    and device.get("clientMode") == "cli"
]
if len(matches) != 1:
    raise SystemExit(f"expected one paired local CLI device, found {len(matches)}")
approved = {
    str(scope).strip()
    for scope in (matches[0].get("approvedScopes") or matches[0].get("scopes") or [])
    if str(scope).strip()
}
if approved != {"operator.pairing"}:
    raise SystemExit(f"initial paired local CLI scopes are not bounded: {sorted(approved)}")
PY

gateway_log=/tmp/gateway.log
before_runs="$(grep -Ec '\[agent\] run [^ ]+ ended with stopReason=' "$gateway_log" 2>/dev/null || true)"
agent_log=/tmp/nemoclaw-6113-gateway-agent.log
session_id="nemoclaw-6113-packaged-$(date +%s)-$$"
if ! openclaw agent --agent main --json --thinking off --session-id "$session_id" \
  -m 'Use the available tools to inspect the current nodes and briefly report their status.' \
  >"$agent_log" 2>&1; then
  echo "PACKAGED_GATEWAY_AGENT_FAILED" >&2
  cat "$agent_log" >&2
  exit 24
fi
if grep -Eiq 'EMBEDDED FALLBACK|gateway connect failed|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' "$agent_log"; then
  echo "PACKAGED_GATEWAY_AGENT_FELL_BACK" >&2
  cat "$agent_log" >&2
  exit 25
fi
if [ ! -s "$agent_log" ]; then
  echo "PACKAGED_GATEWAY_AGENT_EMPTY" >&2
  exit 26
fi
after_runs="$(grep -Ec '\[agent\] run [^ ]+ ended with stopReason=' "$gateway_log" 2>/dev/null || true)"
if [ "$after_runs" -le "$before_runs" ]; then
  echo "PACKAGED_GATEWAY_RUN_NOT_RECORDED before=$before_runs after=$after_runs" >&2
  cat "$agent_log" >&2
  exit 27
fi
echo "NEMOCLAW_6113_PACKAGED_BOOTSTRAP_OK"
`),
    {
      artifactName: "phase-2-packaged-initial-cli-pairing",
      env: env(),
      timeoutMs: 300_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout).toContain("NEMOCLAW_6113_PACKAGED_BOOTSTRAP_OK");
}

function publicInstallRef(): string {
  return process.env.NEMOCLAW_PUBLIC_INSTALL_REF || process.env.GITHUB_SHA || "main";
}

test("cloud onboard: public installer creates healthy sandbox with security checks", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
  const hosted = requireHostedInferenceConfig(secrets);
  const ref = publicInstallRef();
  const installUrl =
    process.env.NEMOCLAW_INSTALL_SCRIPT_URL ??
    `https://raw.githubusercontent.com/NVIDIA/NemoClaw/${ref}/install.sh`;
  const installCwd = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-public-install-"));
  const redactionValues = [hosted.apiKey];

  await artifacts.target.declare({
    id: "cloud-onboard",
    sandboxName: SANDBOX_NAME,
    installUrl,
    installRef: ref,
    checksDir: CHECKS_DIR,
    contracts: [
      "public curl installer uses GitHub clone path for the requested ref",
      "sandbox appears healthy after cloud onboarding",
      "packaged OpenClaw approves the gated initial CLI pairing request",
      "devices list and a real gateway agent run succeed without embedded fallback",
      "cloud split checks cover inference.local, security leak checks, and Landlock/read-only behavior",
      "cleanup verifies sandbox removal",
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

  cleanupRegistry.add("remove cloud-onboard sandbox", () =>
    cleanup(host, sandbox, { label: "cleanup", verify: true }),
  );
  await cleanup(host, sandbox, { label: "pre-cleanup", verify: false });

  const install = await host.command(
    "bash",
    ["-lc", `cd '${installCwd}' && curl -fsSL '${installUrl}' | bash`],
    {
      artifactName: "phase-1-public-install",
      env: env({
        ...hosted.env,
        NVIDIA_INFERENCE_API_KEY: hosted.apiKey,
        NEMOCLAW_INSTALL_REF: ref,
        NEMOCLAW_INSTALL_TAG: ref,
        NEMOCLAW_INSTALL_SCRIPT_URL: installUrl,
      }),
      redactionValues,
      timeoutMs: 25 * 60_000,
    },
  );
  expect(install.exitCode, resultText(install)).toBe(0);
  expect(resultText(install)).toContain("Installing NemoClaw from GitHub");
  expect(resultText(install)).toContain("Cloning NemoClaw source");
  if (ref !== "main") expect(resultText(install)).toContain(`Resolved install ref: ${ref}`);

  await assertPackagedInitialCliPairing(sandbox);

  const cliProbe = await host.command(
    "bash",
    [
      "-lc",
      'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v nemoclaw; command -v openshell; nemoclaw --help >/dev/null',
    ],
    { artifactName: "phase-2-cli-path-probe", env: env(), timeoutMs: 60_000 },
  );
  expect(cliProbe.exitCode, resultText(cliProbe)).toBe(0);

  const list = await host.command("bash", ["-lc", "nemoclaw list"], {
    artifactName: "phase-2-nemoclaw-list",
    env: env(),
    timeoutMs: 60_000,
  });
  expect(list.exitCode, resultText(list)).toBe(0);
  expect(list.stdout).toContain(SANDBOX_NAME);

  const checkScripts = fs
    .readdirSync(CHECKS_DIR)
    .filter((name) => name.endsWith(".sh"))
    .sort();
  expect(checkScripts.length).toBeGreaterThan(0);
  for (const scriptName of checkScripts) {
    const result = await host.command("bash", [path.join(CHECKS_DIR, scriptName)], {
      artifactName: `phase-3-check-${scriptName.replace(/\.sh$/, "")}`,
      cwd: REPO_ROOT,
      env: env({
        ...hosted.env,
        CLOUD_EXPERIMENTAL_MODEL: hosted.model,
        COMPATIBLE_API_KEY: hosted.apiKey,
        NEMOCLAW_E2E_CLOUD_API_KEY_ENV: "COMPATIBLE_API_KEY",
        REPO: REPO_ROOT,
        SANDBOX_NAME,
      }),
      redactionValues,
      timeoutMs: 180_000,
    });
    expect(result.exitCode, `${scriptName}: ${resultText(result)}`).toBe(0);
  }

  await cleanup(host, sandbox, { label: "final-cleanup", verify: true });
  await artifacts.target.complete({ id: "cloud-onboard", status: "passed" });
});
