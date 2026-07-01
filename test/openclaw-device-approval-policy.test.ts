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

function hasPython3(): boolean {
  return spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;
}

function callDecision(device: unknown) {
  const script = `
import importlib.util
import json
import sys

policy_path = sys.argv[1]
device = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.approval_request_decision(device)
result["scopes"] = sorted(result["scopes"])
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync("python3", ["-", POLICY_PATH, JSON.stringify(device)], {
    encoding: "utf-8",
    input: script,
    timeout: 10_000,
  });
}

function callGatewayEnv(sourceEnv: Record<string, string>) {
  const script = `
import importlib.util
import json
import sys

policy_path = sys.argv[1]
source_env = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.gateway_approval_env(source_env)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync("python3", ["-", POLICY_PATH, JSON.stringify(sourceEnv)], {
    encoding: "utf-8",
    input: script,
    timeout: 10_000,
  });
}

function decisionOf(device: unknown) {
  const proc = callDecision(device);
  expect(proc.status).toBe(0);
  return JSON.parse(proc.stdout);
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

describe("openclaw device approval policy (#4462)", () => {
  it("recovers allowlisted upgrades when the failed approve leaves the original request pending", () => {
    if (!hasPython3()) {
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
    if (!hasPython3()) {
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
});

describe("approval_request_decision scope-upgrade gate (#4462)", () => {
  it("allows a known client requesting the exact operator allowlist", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowlisted");
    expect(decision.scopes).toEqual(["operator.pairing", "operator.read", "operator.write"]);
  });

  it("allows an allowlisted client mode even when the client id is unknown", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "some-other-ui",
      clientMode: "cli",
      scopes: ["operator.read"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowlisted");
  });

  it("rejects an unknown client with a disallowed mode", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "rogue-client",
      clientMode: "ssh",
      scopes: ["operator.read"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown-client");
    expect(decision.scopes).toEqual([]);
  });

  it("rejects a scope superset that exceeds the allowlist", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.pairing", "operator.read", "operator.write", "operator.delete"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("disallowed-scopes");
  });

  it("allows a scope subset of the allowlist", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.read"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowlisted");
    expect(decision.scopes).toEqual(["operator.read"]);
  });

  it("rejects malformed non-list scopes", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: "operator.read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("malformed-scopes");
  });

  it("rejects any operator.admin escalation from a known client", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("disallowed-scopes");
  });

  it("rejects an operator.admin-only request from a known client", () => {
    if (!hasPython3()) {
      return;
    }
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.admin"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("disallowed-scopes");
  });
});

describe("gateway_approval_env sanitization (#4462)", () => {
  it("strips the three gateway keys and preserves everything else", () => {
    if (!hasPython3()) {
      return;
    }
    const proc = callGatewayEnv({
      OPENCLAW_GATEWAY_URL: "http://gateway:8080",
      OPENCLAW_GATEWAY_PORT: "8080",
      OPENCLAW_GATEWAY_TOKEN: "secret-token",
      PATH: "/usr/bin",
      OPENCLAW_STATE_DIR: "/sandbox/.openclaw",
      HOME: "/home/agent",
    });
    expect(proc.status).toBe(0);
    const env = JSON.parse(proc.stdout);
    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_URL");
    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_PORT");
    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_STATE_DIR: "/sandbox/.openclaw",
      HOME: "/home/agent",
    });
  });

  it("is a no-op when no gateway keys are present", () => {
    if (!hasPython3()) {
      return;
    }
    const proc = callGatewayEnv({ PATH: "/usr/bin", HOME: "/home/agent" });
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toEqual({ PATH: "/usr/bin", HOME: "/home/agent" });
  });
});

describe("recover_failed_scope_approval rejection paths (#4462)", () => {
  function runRejectionCase(
    mutate: (devicesDir: string) => void,
    requestId = "request-1",
    approveOutput = COMPAT_APPROVE_OUTPUT,
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      mutate(devicesDir);
      const pendingBefore = fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8");
      const pairedBefore = fs.readFileSync(path.join(devicesDir, "paired.json"), "utf-8");

      const result = runRecovery(stateDir, requestId, approveOutput);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8")).toBe(pendingBefore);
      expect(fs.readFileSync(path.join(devicesDir, "paired.json"), "utf-8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("rejects recovery when the paired device is not found", () => {
    if (!hasPython3()) {
      return;
    }
    runRejectionCase((devicesDir) => {
      fs.writeFileSync(path.join(devicesDir, "paired.json"), JSON.stringify({}));
    });
  });

  it("rejects recovery when the requested scopes include operator.admin", () => {
    if (!hasPython3()) {
      return;
    }
    runRejectionCase((devicesDir) => {
      fs.writeFileSync(
        path.join(devicesDir, "pending.json"),
        JSON.stringify({
          original: {
            requestId: "request-1",
            deviceId: "device-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            scopes: ["operator.write", "operator.admin"],
          },
        }),
      );
    });
  });

  it("rejects recovery when the requested scopes are malformed (empty)", () => {
    if (!hasPython3()) {
      return;
    }
    runRejectionCase((devicesDir) => {
      fs.writeFileSync(
        path.join(devicesDir, "pending.json"),
        JSON.stringify({
          original: {
            requestId: "request-1",
            deviceId: "device-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            scopes: [],
          },
        }),
      );
    });
  });

  it("upholds the auth-file-persists-without-admin invariant when the device lacks operator.pairing", () => {
    if (!hasPython3()) {
      return;
    }
    runRejectionCase((devicesDir) => {
      fs.writeFileSync(
        path.join(devicesDir, "paired.json"),
        JSON.stringify({
          "device-1": {
            deviceId: "device-1",
            scopes: [],
            approvedScopes: [],
            tokens: { operator: { role: "operator", scopes: [] } },
          },
        }),
      );
    });
  });
});
