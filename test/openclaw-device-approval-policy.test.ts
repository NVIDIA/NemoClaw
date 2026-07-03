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
  childUmask: string | null = null,
) {
  const script = `
import importlib.util
import json
import os
import sys

policy_path, state_dir, request_id, approve_output, original_json, child_umask = sys.argv[1:7]
if child_umask:
    os.umask(int(child_umask, 8))
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_request = json.loads(original_json)
result = module.recover_failed_scope_approval(request_id, state_dir, approve_output, original_request)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync(
    "python3",
    [
      "-",
      POLICY_PATH,
      stateDir,
      requestId,
      approveOutput,
      JSON.stringify(originalRequest),
      childUmask ?? "",
    ],
    {
      encoding: "utf-8",
      input: script,
      timeout: 10_000,
    },
  );
}

function runConcurrentRecovery(stateDir: string) {
  const script = `
import importlib.util
import json
import pathlib
import sys
import threading

policy_path, state_dir, approve_output, original_json = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_request = json.loads(original_json)
devices_dir = pathlib.Path(state_dir) / "devices"
real_open = module.os.open
opened = threading.Barrier(2)

def synchronized_open(path, flags, mode=0o777):
    fd = real_open(path, flags, mode)
    if str(path).endswith(".tmp"):
        opened.wait(timeout=5)
    return fd

module.os.open = synchronized_open
results = []
errors = []

def recover():
    try:
        results.append(
            module.recover_failed_scope_approval(
                "request-1", state_dir, approve_output, original_request
            )
        )
    except BaseException as error:
        errors.append(f"{type(error).__name__}: {error}")

threads = [threading.Thread(target=recover) for _ in range(2)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join(timeout=10)

print(json.dumps({
    "alive": [thread.name for thread in threads if thread.is_alive()],
    "errors": errors,
    "results": results,
    "pending": json.loads((devices_dir / "pending.json").read_text(encoding="utf-8")),
    "paired": json.loads((devices_dir / "paired.json").read_text(encoding="utf-8")),
    "temps": sorted(path.name for path in devices_dir.glob(".*.tmp")),
}, sort_keys=True))
`;
  return spawnSync(
    "python3",
    ["-", POLICY_PATH, stateDir, COMPAT_APPROVE_OUTPUT, JSON.stringify(originalRequest())],
    {
      encoding: "utf-8",
      input: script,
      timeout: 20_000,
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

function adminRepairReplacement(requestId = "request-2"): Record<string, unknown> {
  return {
    requestId,
    deviceId: "device-1",
    publicKey: "public-key-1",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.admin"],
    isRepair: true,
  };
}

function persistApprovedScopes(stateDir: string): void {
  const pairedFile = path.join(stateDir, "devices", "paired.json");
  const paired = JSON.parse(fs.readFileSync(pairedFile, "utf8"));
  const approved = ["operator.pairing", "operator.read", "operator.write"];
  paired["device-1"].scopes = approved;
  paired["device-1"].approvedScopes = approved;
  paired["device-1"].tokens.operator.scopes = approved;
  fs.writeFileSync(pairedFile, JSON.stringify(paired));
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

  it("preserves non-world-readable device state modes under a permissive umask", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.chmodSync(pendingFile, 0o660);
      fs.chmodSync(pairedFile, 0o600);

      const result = runRecovery(
        stateDir,
        "request-1",
        COMPAT_APPROVE_OUTPUT,
        originalRequest(),
        "0022",
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe("openclaw-approve-recovered-original");
      const pendingMode = fs.statSync(pendingFile).mode & 0o777;
      const pairedMode = fs.statSync(pairedFile).mode & 0o777;
      expect(pendingMode).toBe(0o660);
      expect(pairedMode).toBe(0o600);
      expect(pendingMode & 0o007).toBe(0);
      expect(pairedMode & 0o007).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses isolated temporary files for concurrent recovery writers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);

      const result = runConcurrentRecovery(stateDir);

      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.alive).toEqual([]);
      expect(payload.errors).toEqual([]);
      expect(payload.results).toHaveLength(2);
      expect(payload.pending).toEqual({});
      expect(payload.paired["device-1"].approvedScopes).toEqual([
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]);
      expect(payload.temps).toEqual([]);
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

  it.each([
    ["missing client identity", { ...originalRequest(), clientId: undefined }],
    ["admin repair scopes", { ...originalRequest(), scopes: ["operator.admin"], isRepair: true }],
  ])("rejects a still-pending original with %s", (_case, currentOriginal) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, { original: currentOriginal });
      const pendingFile = path.join(stateDir, "devices", "pending.json");
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(stateDir, "request-1", COMPAT_APPROVE_OUTPUT, originalRequest());

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
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

  it("recovers one exact mentioned replacement while the original is still pending", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, {
        original: originalRequest(),
        replacement: sameScopeReplacement(),
      });

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-2)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-coexisting-same-scope-replacement",
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "pending.json"), "utf8")),
      ).toEqual({});
      expect(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8")).not.toContain(
        "operator.admin",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers the sole output-mentioned OpenClaw admin repair without granting admin", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, { replacement: adminRepairReplacement() });

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-2)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-replacement",
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

  it("rejects a marked admin repair after unrelated opaque output", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, { replacement: adminRepairReplacement() });
      const pendingFile = path.join(stateDir, "devices", "pending.json");
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(stateDir, "request-1", "authorization denied", originalRequest());

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves an unrelated entry whose map key equals the original request ID", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      const unrelated = { requestId: "other-request", deviceId: "other-device" };
      writeReplacementState(stateDir, {
        replacement: sameScopeReplacement(),
        "request-1": unrelated,
      });

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-2)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "devices", "pending.json"), "utf8")),
      ).toEqual({ "request-1": unrelated });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes the exact replacement after approved scopes already persisted", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, { replacement: sameScopeReplacement() });
      persistApprovedScopes(stateDir);

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
      expect(fs.readFileSync(path.join(stateDir, "devices", "paired.json"), "utf8")).not.toContain(
        "operator.admin",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept an unmentioned replacement after approved scopes persisted", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeReplacementState(stateDir, { replacement: sameScopeReplacement() });
      persistApprovedScopes(stateDir);
      const pendingFile = path.join(stateDir, "devices", "pending.json");
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-9)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept a divergent mentioned replacement after approved scopes persisted", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      const replacement = {
        ...sameScopeReplacement(),
        scopes: ["operator.pairing"],
      };
      writeReplacementState(stateDir, { replacement });
      persistApprovedScopes(stateDir);
      const pendingFile = path.join(stateDir, "devices", "pending.json");
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-2)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept a mentioned admin residual beside an exact persisted replacement", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      const replacement = sameScopeReplacement();
      const admin = {
        ...originalRequest(),
        requestId: "request-admin",
        scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
      };
      writeReplacementState(stateDir, { replacement, admin });
      persistApprovedScopes(stateDir);
      const pendingFile = path.join(stateDir, "devices", "pending.json");
      const pairedFile = path.join(stateDir, "devices", "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf8");

      const result = runRecovery(
        stateDir,
        "request-1",
        "GatewayClientRequestError: scope upgrade pending approval (requestId: request-admin)",
        originalRequest(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
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
      "missing client identity",
      { replacement: { ...sameScopeReplacement(), clientId: undefined } },
      "request-2",
      originalRequest(),
    ],
    [
      "missing client mode",
      { replacement: { ...sameScopeReplacement(), clientMode: undefined } },
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
      "duplicate original requests beside a replacement",
      {
        original: originalRequest(),
        duplicate: originalRequest(),
        replacement: sameScopeReplacement(),
      },
      "request-2",
      originalRequest(),
    ],
    [
      "admin fallback without the OpenClaw repair marker",
      { replacement: { ...adminRepairReplacement(), isRepair: false } },
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
