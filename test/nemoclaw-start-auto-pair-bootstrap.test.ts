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

  it("retries a transient initial CLI approve failure on the next gated-list poll (#6113)", () => {
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
    echo "gateway restarting" >&2
    exit 1
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
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1",
        },
        timeout: 30_000,
      });

      expect(run.status).toBe(0);
      expect(fs.readFileSync(approveCount, "utf-8")).toBe("2");
      expect(run.stdout).toContain(
        "[auto-pair] initial CLI approve failed request=request-1: gateway restarting",
      );
      expect(run.stdout).toContain("[auto-pair] approved initial CLI pairing request=request-1");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);

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
});
