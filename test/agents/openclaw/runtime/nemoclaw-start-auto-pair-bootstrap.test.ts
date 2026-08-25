// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "../../..", "scripts", "nemoclaw-start.sh");
const APPROVAL_POLICY_DIR = path.join(import.meta.dirname, "../../..", "scripts", "lib");

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

  it("approves an initial CLI pairing request when device list is itself gated (#6113)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-bootstrap-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const devicesDir = path.join(stateDir, "devices");
    const identityDir = path.join(stateDir, "identity");
    const pendingFile = path.join(devicesDir, "pending.json");
    const pairedFile = path.join(devicesDir, "paired.json");
    const authFile = path.join(identityDir, "device-auth.json");
    const approveLog = path.join(tmpDir, "approve-env.json");
    const agentOutput = path.join(tmpDir, "agent-output.txt");
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
          scopes: ["operator.pairing"],
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
    cat <<'JSON'
{"pending":[],"paired":[{"deviceId":${JSON.stringify(deviceId)},"publicKey":${JSON.stringify(publicKey)},"clientId":"cli","clientMode":"cli","scopes":["operator.pairing"],"approvedScopes":["operator.pairing"]}]}
JSON
    exit 0
  fi
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  cat > ${JSON.stringify(approveLog)} <<'JSON'
{"url":null,"port":null,"token":null,"args":["devices","approve","request-1","--json"]}
JSON
  cat > ${JSON.stringify(pairedFile)} <<'JSON'
{${JSON.stringify(deviceId)}:{"deviceId":${JSON.stringify(deviceId)},"publicKey":${JSON.stringify(publicKey)},"clientId":"cli","clientMode":"cli","scopes":["operator.pairing"],"approvedScopes":["operator.pairing"]}}
JSON
  exit 0
fi
if [ "\${1:-}" = "agent" ]; then
  if [ ! -s ${JSON.stringify(pairedFile)} ]; then
    echo "EMBEDDED FALLBACK: gateway unavailable"
    exit 0
  fi
  printf 'tool:file-write-ok\\n' > ${JSON.stringify(agentOutput)}
  echo "gateway agent completed"
  exit 0
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
      expect(run.stdout).toContain("[auto-pair] stage=listing failed reason=pairing-required");
      expect(run.stdout).toContain("[auto-pair] stage=request-creation observed request=request-1");
      expect(run.stdout).toContain(
        "[auto-pair] stage=validation accepted request=request-1 reason=allowlisted-initial-cli",
      );
      expect(run.stdout).toContain("[auto-pair] stage=approval attempting request=request-1");
      expect(run.stdout).toContain("[auto-pair] approved initial CLI pairing request=request-1");
      expect(JSON.parse(fs.readFileSync(approveLog, "utf-8"))).toEqual({
        url: null,
        port: null,
        token: null,
        args: ["devices", "approve", "request-1", "--json"],
      });
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      expect(Object.keys(paired)).toEqual([deviceId]);
      expect(paired[deviceId]).toMatchObject({
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
      });
      expect(fs.existsSync(authFile)).toBe(false);
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toHaveProperty("request-1");

      const agent = spawnSync(fakeOpenclaw, ["agent", "run", "write-file"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });
      expect(agent.status).toBe(0);
      expect(`${agent.stdout}\n${agent.stderr}`).not.toContain("EMBEDDED FALLBACK");
      expect(fs.readFileSync(agentOutput, "utf-8")).toBe("tool:file-write-ok\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it.each([
    ["mismatched embedded requestId", { requestId: "request-2" }],
    ["missing embedded requestId", { requestId: "" }],
    ["mismatched public key", { publicKey: "wrong" }],
    ["non-cli client id", { clientId: "browser" }],
    ["non-cli client mode", { clientMode: "webchat" }],
    ["non-operator role", { role: "viewer", roles: ["viewer"] }],
    ["empty role", { role: "" }],
    ["malformed roles", { roles: "operator" }],
    ["empty role entry", { roles: ["operator", ""] }],
    ["malformed scopes", { scopes: "operator.pairing" }],
    ["empty scopes", { scopes: [] }],
    ["duplicate scopes", { scopes: ["operator.pairing", "operator.pairing"] }],
    ["extra allowed scope", { scopes: ["operator.pairing", "operator.write"] }],
    ["disallowed scope", { scopes: ["operator.pairing", "admin.write"] }],
    ["missing pairing scope", { scopes: ["operator.write"] }],
  ])(
    "rejects %s before initial CLI approve (#6113)",
    (_name, override) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-reject-"));
      const fakeOpenclaw = path.join(tmpDir, "openclaw");
      const stateDir = path.join(tmpDir, "state");
      const devicesDir = path.join(stateDir, "devices");
      const identityDir = path.join(stateDir, "identity");
      const pendingFile = path.join(devicesDir, "pending.json");
      const approveLog = path.join(tmpDir, "approve-called");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(identityDir, { recursive: true });
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
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
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            ts: 100,
            ...override,
          },
        }),
      );
      fs.writeFileSync(
        fakeOpenclaw,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approveLog)}
  exit 0
fi
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
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
            NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          },
          timeout: 30_000,
        });

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain("approved initial CLI pairing");
        expect(run.stdout).toContain(
          "[auto-pair] stage=validation rejected request=request-1 reason=not-allowlisted",
        );
        expect(fs.existsSync(approveLog)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it.each([
    [
      "multiple request ids",
      "pairing required: device is not approved yet requestId: request-1 requestId: request-2",
    ],
    ["missing request id", "pairing required: device is not approved yet"],
    [
      "overlong request id",
      `pairing required: device is not approved yet requestId: ${"r".repeat(129)}`,
    ],
    [
      "overlong request id with pending prefix",
      `pairing required: device is not approved yet requestId: ${"p".repeat(129)}`,
    ],
    [
      "whitespace request id",
      "pairing required: device is not approved yet (requestId: request 1)",
    ],
    [
      "whitespace request id with pending prefix",
      "pairing required: device is not approved yet requestId: request 1",
    ],
    [
      "quoted request id with trailing text",
      'pairing required: device is not approved yet requestId: "request" 1',
    ],
    ["option-like request id", "pairing required: device is not approved yet requestId: --help"],
  ])(
    "rejects %s from gated-list errors before initial CLI approve (#6113)",
    (_name, listError) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-requestid-"));
      const fakeOpenclaw = path.join(tmpDir, "openclaw");
      const stateDir = path.join(tmpDir, "state");
      const devicesDir = path.join(stateDir, "devices");
      const identityDir = path.join(stateDir, "identity");
      const pendingFile = path.join(devicesDir, "pending.json");
      const approveLog = path.join(tmpDir, "approve-called");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(identityDir, { recursive: true });
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      const validRequest = {
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing"],
        ts: 100,
      };
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
          deviceId,
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
        }),
      );
      fs.writeFileSync(
        pendingFile,
        JSON.stringify({
          "request-1": { requestId: "request-1", ...validRequest },
          "request-2": { requestId: "request-2", ...validRequest },
          ["r".repeat(129)]: { requestId: "r".repeat(129), ...validRequest },
          ["p".repeat(128)]: { requestId: "p".repeat(128), ...validRequest },
          "request 1": { requestId: "request 1", ...validRequest },
          request: { requestId: "request", ...validRequest },
          "--help": { requestId: "--help", ...validRequest },
        }),
      );
      fs.writeFileSync(
        fakeOpenclaw,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' ${JSON.stringify(listError)}
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approveLog)}
  exit 0
fi
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
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
            NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          },
          timeout: 30_000,
        });

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain("approved initial CLI pairing");
        expect(run.stdout).not.toContain("--help");
        expect(fs.existsSync(approveLog)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it.each([
    ["missing identity device id", { deviceId: undefined }],
    ["missing identity public key", { publicKeyPem: undefined }],
    [
      "malformed identity public key PEM",
      { publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnot-base64\n-----END PUBLIC KEY-----\n" },
    ],
    ["mismatched identity device id", { deviceId: "not-the-device" }],
    ["short identity public key", { publicKey: "short" }],
    [
      "identity public key with wrong hash",
      { publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ],
  ])(
    "rejects %s before initial CLI approve (#6113)",
    (_name, identityOverride) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-identity-"));
      const fakeOpenclaw = path.join(tmpDir, "openclaw");
      const stateDir = path.join(tmpDir, "state");
      const devicesDir = path.join(stateDir, "devices");
      const identityDir = path.join(stateDir, "identity");
      const approveLog = path.join(tmpDir, "approve-called");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(identityDir, { recursive: true });
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
          deviceId,
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
          ...identityOverride,
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
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approveLog)}
  exit 0
fi
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
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
            NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          },
          timeout: 30_000,
        });

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain("approved initial CLI pairing");
        expect(fs.existsSync(approveLog)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it("fails closed for malformed identity public keys without terminating the watcher (#6113)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-bad-identity-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const devicesDir = path.join(stateDir, "devices");
    const identityDir = path.join(stateDir, "identity");
    const approveLog = path.join(tmpDir, "approve-called");
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(identityDir, "device.json"),
      JSON.stringify({
        deviceId: "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnot-valid-base64\n-----END PUBLIC KEY-----\n",
      }),
    );
    fs.writeFileSync(
      path.join(devicesDir, "pending.json"),
      JSON.stringify({
        "request-1": {
          requestId: "request-1",
          deviceId: "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47",
          publicKey: "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8",
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
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approveLog)}
  exit 0
fi
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
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain("approved initial CLI pairing");
      expect(fs.existsSync(approveLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it.each([
    ["command failure", 'echo "gateway restarting" >&2\n    exit 1', "command-failed", "10"],
    ["timeout", "sleep 1", "timeout", "0.5"],
  ])(
    "retries a transient initial CLI approve %s on the next gated-list poll (#6113)",
    (_name, firstAction, failureReason, runTimeoutSeconds) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-retry-"));
      const fakeOpenclaw = path.join(tmpDir, "openclaw");
      const stateDir = path.join(tmpDir, "state");
      const devicesDir = path.join(stateDir, "devices");
      const identityDir = path.join(stateDir, "identity");
      const pendingFile = path.join(devicesDir, "pending.json");
      const approveCount = path.join(tmpDir, "approve-count");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(identityDir, { recursive: true });
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
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
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  count=0
  if [ -f ${JSON.stringify(approveCount)} ]; then
    count=$(cat ${JSON.stringify(approveCount)})
  fi
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(approveCount)}
  if [ "$count" -eq 1 ]; then
    ${firstAction}
  fi
  exit 0
fi
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
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
            NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: runTimeoutSeconds,
            NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          },
          timeout: 30_000,
        });

        expect(run.status).toBe(0);
        expect(fs.readFileSync(approveCount, "utf-8")).toBe("2");
        expect(run.stdout).toContain(`[auto-pair] stage=approval failed reason=${failureReason}`);
        expect(run.stdout).toContain("[auto-pair] approved initial CLI pairing request=request-1");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it("drops a permanently-failing gated approve to slow-mode instead of 1s-looping to the deadline (#6113)", () => {
    // cv #6330 item 2: the fast->slow transition must be reached even when the
    // gated list/approve path keeps failing and `continue`s. With a near-zero
    // FAST_DEADLINE the first iteration must emit the slow-mode transition
    // (proving the check runs before the failure `continue`), and the watcher
    // must exit within the short deadline rather than busy-polling at 1s.
    // (`_env_seconds` rejects a literal 0 as non-positive, so use a tiny value.)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-permfail-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const devicesDir = path.join(stateDir, "devices");
    const identityDir = path.join(stateDir, "identity");
    const pendingFile = path.join(devicesDir, "pending.json");
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
    const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
    fs.writeFileSync(
      path.join(identityDir, "device.json"),
      JSON.stringify({
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
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\\n' '{"ok":false,"error":{"reason":"pairing required: device is not approved yet (requestId: request-1)"}}'
  exit 1
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "gateway permanently unavailable" >&2
  exit 1
fi
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
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.01",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      // The transition fired on the permanently-failing gated path (loop-top check).
      expect(run.stdout).toContain(
        "[auto-pair] fast-mode deadline reached; switching to slow-mode",
      );
      expect(run.stdout).toContain(
        "[auto-pair] initial CLI approve failed request=request-1: gateway permanently unavailable",
      );
      expect(run.stdout).toContain("[auto-pair] stage=approval failed reason=command-failed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("does not seed when device list fails for a non-pairing error (#6113)", () => {
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
      expect(run.stdout).not.toContain("approved initial CLI pairing");
      expect(fs.existsSync(pairedFile)).toBe(false);
      expect(fs.existsSync(authFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

  it("reports the request-creation stage while a valid device list stays empty (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-empty-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
printf '%s\\n' '{"pending":[],"paired":[]}'
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] stage=request-creation waiting reason=no-request");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["top-level array", "[]"],
    ["non-array pending", '{"pending":{},"paired":[]}'],
    ["non-array paired", '{"pending":[],"paired":"device"}'],
    ["null pending", '{"pending":null,"paired":[]}'],
    ["null paired", '{"pending":[],"paired":null}'],
    ["missing pending", '{"paired":[]}'],
    ["missing paired", '{"pending":[]}'],
  ])("rejects a valid JSON response with %s (#9844)", (_name, response) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-shape-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approvalMarker = path.join(tmpDir, "approval-called");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approvalMarker)}
fi
printf '%s\\n' ${JSON.stringify(response)}
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "0.0001",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] stage=listing failed reason=invalid-response");
      expect(fs.existsSync(approvalMarker)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps forced CLI pairing until a validated paired CLI record appears (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-bootstrap-state-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const listCount = path.join(tmpDir, "list-count");
    const listEnv = path.join(tmpDir, "list-env");
    const approveEnv = path.join(tmpDir, "approve-env");
    const approvalMarker = path.join(tmpDir, "approval-called");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  count=0
  if [ -f ${JSON.stringify(listCount)} ]; then count=$(cat ${JSON.stringify(listCount)}); fi
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(listCount)}
  printf '%s:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING:-}" "\${OPENCLAW_GATEWAY_TOKEN:-}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT:-}" >> ${JSON.stringify(listEnv)}
  if [ "$count" -eq 1 ]; then
    printf '%s\n' '{"pending":null,"paired":[]}'
  elif [ "$count" -eq 2 ]; then
    printf '%s\n' '{"pending":[{"requestId":"request-1","clientId":"cli","clientMode":"cli","role":"operator","roles":["operator"],"scopes":["operator.pairing"]}],"paired":[]}'
  elif [ "$count" -eq 3 ]; then
    printf '%s\n' '{"pending":[],"paired":[{"clientId":"not-cli","clientMode":"cli"}]}'
  else
    printf '%s\n' '{"pending":[],"paired":[{"clientId":"cli","clientMode":"cli"}]}'
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  printf '%s:%s:%s\n' "\${NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING:-}" "\${OPENCLAW_GATEWAY_TOKEN:-}" "\${NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT:-}" >> ${JSON.stringify(approveEnv)}
  touch ${JSON.stringify(approvalMarker)}
  exit 0
fi
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
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("[auto-pair] stage=listing failed reason=invalid-response");
      expect(run.stdout).toContain("[auto-pair] approved request=request-1 client=cli mode=cli");
      expect(run.stdout).toContain("[auto-pair] loopback CLI pairing bootstrap completed");
      expect(fs.existsSync(approvalMarker)).toBe(true);
      const environments = fs.readFileSync(listEnv, "utf-8").trim().split("\n");
      expect(environments.slice(0, 4)).toEqual([
        "1:gateway-token:",
        "1:gateway-token:",
        "1:gateway-token:",
        "1:gateway-token:",
      ]);
      expect(environments[4]).toBe("::1");
      expect(fs.readFileSync(approveEnv, "utf-8").trim()).toBe("::");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["object", { value: "object-request-secret" }, "object-request-secret"],
    ["array", ["array-request-secret"], "array-request-secret"],
    ["number", 927461835, "927461835"],
    ["newline", "line\nnewline-request-secret", "newline-request-secret"],
    ["overlong", "x".repeat(129), "x".repeat(40)],
    ["option-like", "--help", "--help"],
  ])(
    "rejects a malformed %s request ID without approval or disclosure (#9844)",
    (_name, requestId, secretMarker) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-request-id-"));
      const fakeOpenclaw = path.join(tmpDir, "openclaw");
      const approvalMarker = path.join(tmpDir, "approval-called");
      const response = JSON.stringify({
        pending: [
          {
            requestId,
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
          },
        ],
        paired: [],
      });
      fs.writeFileSync(
        fakeOpenclaw,
        `#!/usr/bin/env bash
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approvalMarker)}
fi
printf '%s\n' ${JSON.stringify(response)}
`,
        { mode: 0o755 },
      );

      try {
        const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
          encoding: "utf-8",
          env: {
            ...process.env,
            OPENCLAW_BIN: fakeOpenclaw,
            NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
            NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
          },
          timeout: 10_000,
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain(
          "[auto-pair] stage=validation rejected reason=malformed-request-id",
        );
        expect(run.stdout).toContain(
          "[auto-pair] stage=request-creation waiting reason=no-request",
        );
        expect(`${run.stdout}\n${run.stderr}`).not.toContain(secretMarker);
        expect(fs.existsSync(approvalMarker)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("enters slow mode for a paired CLI record when all pending request IDs are malformed (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-malformed-pending-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const approvalMarker = path.join(tmpDir, "approval-called");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  touch ${JSON.stringify(approvalMarker)}
fi
printf '%s\n' '{"pending":[{"requestId":"--help","clientId":"cli","clientMode":"cli"}],"paired":[{"clientId":"cli","clientMode":"cli"}]}'
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] stage=validation rejected reason=malformed-request-id",
      );
      expect(run.stdout).toContain("[auto-pair] loopback CLI pairing bootstrap completed");
      expect(run.stdout).toContain(
        "[auto-pair] devices paired (1); entering slow-mode approvals=0",
      );
      expect(run.stdout).not.toContain("--help");
      expect(fs.existsSync(approvalMarker)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forgets request diagnostics after the gateway removes the request (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-request-prune-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const listCount = path.join(tmpDir, "list-count");
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f ${JSON.stringify(listCount)} ]; then count=$(cat ${JSON.stringify(listCount)}); fi
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(listCount)}
if [ "$count" -eq 1 ] || [ "$count" -eq 3 ]; then
  printf '%s\n' '{"pending":[{"requestId":"reused-request","clientId":"unknown","clientMode":"unknown","role":"operator","roles":["operator"],"scopes":["operator.pairing"]},{"requestId":{"secret":"malformed-request-secret"},"clientId":"cli","clientMode":"cli"}],"paired":[]}'
else
  printf '%s\n' '{"pending":[],"paired":[]}'
fi
`,
      { mode: 0o755 },
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairPythonScript(src, tmpDir)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 10_000,
      });

      expect(run.status).toBe(0);
      expect(
        run.stdout.match(/stage=request-creation observed request=reused-request/g),
      ).toHaveLength(2);
      expect(
        run.stdout.match(/stage=validation rejected request=reused-request reason=unknown-client/g),
      ).toHaveLength(2);
      expect(
        run.stdout.match(/stage=validation rejected reason=malformed-request-id/g),
      ).toHaveLength(2);
      expect(`${run.stdout}\n${run.stderr}`).not.toContain("malformed-request-secret");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports a fixed watcher-execution stage without raw exception details (#9844)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-exception-"));
    const writablePolicy = path.join(tmpDir, "openclaw_device_approval_policy.py");
    fs.writeFileSync(writablePolicy, "def approval_request_decision(_device): return {}\n", {
      mode: 0o600,
    });
    const script = startScriptHeredoc(src, "PYAUTOPAIR").replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(writablePolicy)}`,
    );

    try {
      const run = spawnSync("python3", ["-c", script], {
        encoding: "utf-8",
        env: { ...process.env, OPENCLAW_BIN: "/bin/false" },
        timeout: 10_000,
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("[auto-pair] stage=watcher-execution failed error=RuntimeError");
      expect(run.stdout).not.toContain(writablePolicy);
      expect(run.stderr).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
