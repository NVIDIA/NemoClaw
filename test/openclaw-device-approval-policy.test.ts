// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const POLICY_PATH = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "openclaw_device_approval_policy.py",
);

const COMPAT_APPROVE_OUTPUT =
  "GatewayClientRequestError: scope upgrade pending approval for requestId request-1";
const pythonAvailable =
  spawnSync("sh", ["-c", "command -v python3"], {
    stdio: "ignore",
  }).status === 0;
const itWithPython = pythonAvailable ? it : it.skip;

function runRecovery(
  stateDir: string,
  requestId = "request-1",
  approveOutput = COMPAT_APPROVE_OUTPUT,
) {
  const script = `
import importlib.util
import json
import sys

policy_path, state_dir, request_id, approve_output = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.recover_failed_scope_approval(request_id, state_dir, approve_output, None)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync("python3", ["-", POLICY_PATH, stateDir, requestId, approveOutput], {
    encoding: "utf-8",
    input: script,
    timeout: 10_000,
  });
}

function writeOriginalPendingState(stateDir: string) {
  const devicesDir = path.join(stateDir, "devices");
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.writeFileSync(
    path.join(devicesDir, "pending.json"),
    JSON.stringify({
      original: {
        requestId: "request-1",
        deviceId: "device-1",
        clientId: "openclaw-cli",
        clientMode: "cli",
        scopes: ["operator.write"],
      },
    }),
  );
  fs.writeFileSync(
    path.join(devicesDir, "paired.json"),
    JSON.stringify({
      "device-1": {
        deviceId: "device-1",
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
        tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
      },
    }),
  );
}

function runPolicySnippet(script: string, args: string[] = []) {
  return spawnSync("python3", ["-", POLICY_PATH, ...args], {
    encoding: "utf-8",
    input: `
import importlib.util
import json
import sys

policy_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
${script}
`,
    timeout: 10_000,
  });
}

describe("openclaw device approval policy (#4462)", () => {
  itWithPython(
    "denies first-time CLI approval but allows existing CLI write upgrades (#5324)",
    () => {
      const result = runPolicySnippet(`
first = module.approval_request_decision({
  "requestId": "first-cli",
  "deviceId": "cli-1",
  "publicKey": "cli-key",
  "clientId": "cli",
  "clientMode": "cli",
  "scopes": ["operator.write"],
}, [])
upgrade = module.approval_request_decision({
  "requestId": "upgrade-cli",
  "deviceId": "cli-1",
  "publicKey": "cli-key",
  "clientId": "cli",
  "clientMode": "cli",
  "scopes": ["operator.write"],
}, [{
  "deviceId": "cli-1",
  "publicKey": "cli-key",
  "clientId": "cli",
  "clientMode": "cli",
  "approvedScopes": ["operator.pairing"],
  "tokens": {"operator": {"role": "operator", "scopes": ["operator.pairing"]}},
}])
pairing_only = module.approval_request_decision({
  "requestId": "pairing-only",
  "deviceId": "cli-1",
  "publicKey": "cli-key",
  "clientId": "cli",
  "clientMode": "cli",
  "scopes": ["operator.pairing"],
}, [{
  "deviceId": "cli-1",
  "publicKey": "cli-key",
  "clientId": "cli",
  "clientMode": "cli",
  "approvedScopes": ["operator.pairing"],
  "tokens": {"operator": {"role": "operator", "scopes": ["operator.pairing"]}},
}])
print(json.dumps({
  "first": first["reason"],
  "upgrade": upgrade["allowed"],
  "pairing_only": pairing_only["reason"],
}, sort_keys=True))
`);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        first: "cli-first-pairing",
        pairing_only: "cli-pairing-only",
        upgrade: true,
      });
    },
  );

  itWithPython("approves allowlisted requests directly in local pairing state (#5324)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-state-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      fs.writeFileSync(path.join(devicesDir, ".pending.json.tmp"), "stale interrupted write");
      fs.writeFileSync(path.join(devicesDir, ".paired.json.tmp"), "stale interrupted write");

      const result = runPolicySnippet(
        `
state_dir, request_id = sys.argv[2:4]
print(json.dumps(module.approve_allowlisted_request(request_id, state_dir), sort_keys=True))
`,
        [stateDir, "request-1"],
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe("nemoclaw-local-state-approve");
      expect(JSON.parse(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8"))).toEqual(
        {},
      );
      const paired = JSON.parse(fs.readFileSync(path.join(devicesDir, "paired.json"), "utf-8"));
      expect(paired["device-1"].approvedScopes).toEqual(["operator.pairing", "operator.write"]);
      expect(paired["device-1"].tokens.operator.scopes).toEqual([
        "operator.pairing",
        "operator.write",
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itWithPython(
    "prunes stale CLI pairing-only devices and clears matching local device auth (#5324)",
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-prune-"));
      try {
        const stateDir = path.join(tmpDir, "state");
        const devicesDir = path.join(stateDir, "devices");
        const identityDir = path.join(stateDir, "identity");
        fs.mkdirSync(devicesDir, { recursive: true });
        fs.mkdirSync(identityDir, { recursive: true });
        fs.writeFileSync(path.join(devicesDir, "pending.json"), JSON.stringify({}));
        fs.writeFileSync(
          path.join(devicesDir, "paired.json"),
          JSON.stringify({
            "cli-1": {
              deviceId: "cli-1",
              clientId: "cli",
              clientMode: "cli",
              role: "operator",
              roles: ["operator"],
              approvedScopes: ["operator.pairing"],
              tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
            },
          }),
        );
        fs.writeFileSync(
          path.join(identityDir, "device-auth.json"),
          JSON.stringify({
            version: 1,
            deviceId: "cli-1",
            tokens: { operator: { token: "old", role: "operator", scopes: ["operator.pairing"] } },
          }),
        );

        const result = runPolicySnippet(
          `
state_dir = sys.argv[2]
print(json.dumps(module.prune_cli_pairing_only_devices(state_dir), sort_keys=True))
`,
          [stateDir],
        );

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(["cli-1"]);
        expect(JSON.parse(fs.readFileSync(path.join(devicesDir, "paired.json"), "utf-8"))).toEqual(
          {},
        );
        expect(
          JSON.parse(fs.readFileSync(path.join(identityDir, "device-auth.json"), "utf-8")).tokens,
        ).toEqual({});
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itWithPython(
    "recovers allowlisted upgrades when the failed approve leaves the original request pending",
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
      try {
        const stateDir = path.join(tmpDir, "state");
        writeOriginalPendingState(stateDir);
        const devicesDir = path.join(stateDir, "devices");
        const pendingFile = path.join(devicesDir, "pending.json");
        const pairedFile = path.join(devicesDir, "paired.json");

        const result = runRecovery(stateDir);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).compatibility).toBe("openclaw-approve-recovered-original");
        expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toEqual({});
        const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
        const expectedScopes = ["operator.pairing", "operator.read", "operator.write"];
        expect(paired["device-1"].approvedScopes).toEqual(expectedScopes);
        expect(paired["device-1"].tokens.operator.scopes).toEqual(expectedScopes);
        expect(JSON.stringify(paired)).not.toContain("operator.admin");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itWithPython("does not recover original pending requests after unrelated approve errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf-8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf-8");

      const result = runRecovery(stateDir, "request-1", "authorization denied");

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf-8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf-8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
