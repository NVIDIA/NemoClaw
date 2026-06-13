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

function runRecovery(stateDir: string, requestId = "request-1") {
  const script = `
import importlib.util
import json
import sys

policy_path, state_dir, request_id = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.recover_failed_scope_approval(request_id, state_dir, "gateway connect failed", None)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync("python3", ["-", POLICY_PATH, stateDir, requestId], {
    encoding: "utf-8",
    input: script,
    timeout: 10_000,
  });
}

describe("openclaw device approval policy (#4462)", () => {
  it("recovers allowlisted upgrades when the failed approve leaves the original request pending", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(
        pendingFile,
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
        pairedFile,
        JSON.stringify({
          "device-1": {
            deviceId: "device-1",
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
          },
        }),
      );

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
  });
});
