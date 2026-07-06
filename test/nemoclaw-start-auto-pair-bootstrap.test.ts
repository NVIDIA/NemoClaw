// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const APPROVAL_POLICY_DIR = path.join(import.meta.dirname, "..", "scripts", "lib");

function startScriptHeredoc(src: string, marker: string): string {
  const match = src.match(new RegExp(`<<'${marker}'[^\\n]*\\n([\\s\\S]*?)\\n${marker}`));
  expect(match).not.toBeNull();
  return match![1];
}

function trustedApprovalPolicyFile(tmpDir: string): string {
  const helperPath = path.join(tmpDir, "openclaw_device_approval_policy.py");
  fs.copyFileSync(path.join(APPROVAL_POLICY_DIR, "openclaw_device_approval_policy.py"), helperPath);
  fs.chmodSync(helperPath, 0o444);
  return helperPath;
}

function autoPairPythonScript(src: string, tmpDir: string): string {
  return startScriptHeredoc(src, "PYAUTOPAIR")
    .replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(trustedApprovalPolicyFile(tmpDir))}`,
    )
    .replaceAll("time.time()", "_nemoclaw_test_time()")
    .replaceAll("time.sleep(", "_nemoclaw_test_sleep(")
    .replace(
      "import time",
      `import time
_nemoclaw_test_clock = [time.time()]
_nemoclaw_test_time = lambda: _nemoclaw_test_clock[0]
def _nemoclaw_test_sleep(seconds): _nemoclaw_test_clock.__setitem__(0, _nemoclaw_test_clock[0] + min(max(float(seconds), 0), 0.25))
`,
    );
}

describe("nemoclaw-start initial CLI auto-pair bootstrap (#6113)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("seeds an initial CLI pairing request when device list is itself gated", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-bootstrap-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const devicesDir = path.join(stateDir, "devices");
    const identityDir = path.join(stateDir, "identity");
    const pendingFile = path.join(devicesDir, "pending.json");
    const pairedFile = path.join(devicesDir, "paired.json");
    const authFile = path.join(identityDir, "device-auth.json");
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
    const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
    fs.writeFileSync(
      path.join(identityDir, "device.json"),
      JSON.stringify({
        version: 1,
        deviceId,
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
      }),
    );
    fs.writeFileSync(
      pendingFile,
      JSON.stringify({
        "request-1": {
          requestId: "request-1",
          deviceId,
          publicKey,
          platform: "linux",
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.pairing", "operator.write"],
          remoteIp: "10.200.0.2",
          ts: 100,
        },
      }),
    );
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -s ${JSON.stringify(pairedFile)} ]; then
    node -e 'const fs=require("fs"); const paired=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify({pending:[], paired:Object.values(paired)})+"\\n")' ${JSON.stringify(pairedFile)}
    exit 0
  fi
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "3",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] seeded initial CLI pairing request=request-1");
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      const auth = JSON.parse(fs.readFileSync(authFile, "utf-8"));
      expect(Object.keys(paired)).toEqual([deviceId]);
      expect(paired[deviceId]).toMatchObject({
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
      });
      expect(paired[deviceId].tokens.operator.token).toBeTruthy();
      expect(paired[deviceId].tokens.operator.token).not.toBe("gateway-token");
      expect(auth).toMatchObject({
        version: 1,
        deviceId,
        tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
      });
      expect(auth.tokens.operator.token).toBe(paired[deviceId].tokens.operator.token);
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("does not seed when device list fails for a non-pairing error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-nonpairing-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const devicesDir = path.join(stateDir, "devices");
    const identityDir = path.join(stateDir, "identity");
    const pairedFile = path.join(devicesDir, "paired.json");
    const authFile = path.join(identityDir, "device-auth.json");
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
    const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
    fs.writeFileSync(
      path.join(identityDir, "device.json"),
      JSON.stringify({
        version: 1,
        deviceId,
        publicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
      }),
    );
    fs.writeFileSync(
      path.join(devicesDir, "pending.json"),
      JSON.stringify({
        "request-1": {
          requestId: "request-1",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.pairing"],
          ts: 100,
        },
      }),
    );
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"ok":false,"error":{"reason":"gateway unavailable"}}'
exit 1
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_STATE_DIR: stateDir,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("seeded initial CLI pairing");
      expect(fs.existsSync(pairedFile)).toBe(false);
      expect(fs.existsSync(authFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);
});
