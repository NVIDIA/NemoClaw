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

function runRecovery(
  stateDir: string,
  requestId = "request-1",
  approveOutput = COMPAT_APPROVE_OUTPUT,
  originalRequest: Record<string, unknown> | null = null,
) {
  const script = `
import importlib.util
import json
import sys

policy_path, state_dir, request_id, approve_output, original_json = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_request = json.loads(original_json)
result = module.recover_failed_scope_approval(request_id, state_dir, approve_output, original_request)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync(
    "python3",
    ["-", POLICY_PATH, stateDir, requestId, approveOutput, JSON.stringify(originalRequest)],
    {
      encoding: "utf-8",
      input: script,
      timeout: 10_000,
    },
  );
}

function originalRequest(): Record<string, unknown> {
  return {
    requestId: "request-1",
    deviceId: "device-1",
    publicKey: "public-key-1",
    clientId: "openclaw-cli",
    clientMode: "cli",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.write"],
  };
}

function writeOriginalPendingState(stateDir: string): void {
  const devicesDir = path.join(stateDir, "devices");
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.writeFileSync(
    path.join(devicesDir, "pending.json"),
    JSON.stringify({ original: originalRequest() }),
  );
  fs.writeFileSync(
    path.join(devicesDir, "paired.json"),
    JSON.stringify({
      "device-1": {
        deviceId: "device-1",
        publicKey: "public-key-1",
        clientId: "openclaw-cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
        tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
      },
    }),
  );
}

function writeReplacementState(
  stateDir: string,
  replacements: Record<string, Record<string, unknown>>,
): void {
  writeOriginalPendingState(stateDir);
  fs.writeFileSync(path.join(stateDir, "devices", "pending.json"), JSON.stringify(replacements));
}

function sameScopeReplacement(requestId = "request-2"): Record<string, unknown> {
  return {
    ...originalRequest(),
    requestId,
    scopes: ["operator.pairing", "operator.read", "operator.write"],
  };
}

describe("openclaw device approval policy (#4462)", () => {
  it("recovers allowlisted upgrades when the failed approve leaves the original request pending", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
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
  });

  it("does not recover original pending requests after unrelated approve errors", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
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

  it("recovers the exact output-mentioned same-identity scope replacement", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, { replacement: sameScopeReplacement() });

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-2)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-same-scope-replacement",
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "pending.json"), "utf8")),
      ).toEqual({});
      const paired = JSON.parse(
        fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8"),
      );
      expect(paired["device-1"].approvedScopes).toEqual([
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "different public key",
      { replacement: { ...sameScopeReplacement(), publicKey: "attacker-key" } },
      "request-2",
      originalRequest(),
    ],
    [
      "different client identity",
      { replacement: { ...sameScopeReplacement(), clientId: "other-client" } },
      "request-2",
      originalRequest(),
    ],
    [
      "different operator role",
      {
        replacement: {
          ...sameScopeReplacement(),
          role: "observer",
          roles: ["observer"],
        },
      },
      "request-2",
      originalRequest(),
    ],
    [
      "different canonical target scopes",
      { replacement: { ...sameScopeReplacement(), scopes: ["operator.pairing"] } },
      "request-2",
      originalRequest(),
    ],
    [
      "divergent scope views",
      {
        replacement: {
          ...sameScopeReplacement(),
          requestedScopes: ["operator.pairing"],
        },
      },
      "request-2",
      originalRequest(),
    ],
    [
      "ambiguous replacements",
      { first: sameScopeReplacement(), second: sameScopeReplacement("request-3") },
      "request-2",
      originalRequest(),
    ],
    [
      "coexisting original and replacement requests",
      { original: originalRequest(), replacement: sameScopeReplacement() },
      "request-2",
      originalRequest(),
    ],
    [
      "unmentioned replacement",
      { replacement: sameScopeReplacement() },
      "request-9",
      originalRequest(),
    ],
    [
      "mismatched original request id",
      { replacement: sameScopeReplacement() },
      "request-2",
      { ...originalRequest(), requestId: "stale-request" },
    ],
  ])("rejects a same-scope replacement with %s", (_case, replacements, mentionedId, original) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, replacements);
      const pendingFile = path.join(stateDir, "devices", "pending.json");
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(
        stateDir,
        "request-1",
        `GatewayClientRequestError: scope upgrade pending approval (requestId: ${mentionedId})`,
        original,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched original snapshot even when paired scopes already changed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, {});
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf8"));
      const approved = ["operator.pairing", "operator.read", "operator.write"];
      paired["device-1"].scopes = approved;
      paired["device-1"].approvedScopes = approved;
      paired["device-1"].tokens.operator.scopes = approved;
      fs.writeFileSync(pairedFile, JSON.stringify(paired));
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(stateDir, "request-1", COMPAT_APPROVE_OUTPUT, {
        ...originalRequest(),
        requestId: "stale-request",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
