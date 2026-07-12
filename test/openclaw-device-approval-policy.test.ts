// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_PATH = path.join(REPO_ROOT, "scripts", "lib", "openclaw_device_approval_policy.py");

function hasPython3(): boolean {
  return spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;
}

const HAS_PYTHON3 = hasPython3();

function evaluatePolicy(devices: unknown[], env: Record<string, string> = {}) {
  const script = `
import importlib.util
import json
import sys

policy_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
devices = json.loads(sys.argv[2])
payload = {
    "decisions": [module.approval_request_decision(device) for device in devices],
    "approval_env": module.gateway_approval_env({
        "OPENCLAW_GATEWAY_URL": "ws://127.0.0.1:18789",
        "OPENCLAW_GATEWAY_PORT": "18789",
        "OPENCLAW_GATEWAY_TOKEN": "secret",
        "KEEP_ME": "yes",
    }),
    "has_recovery": hasattr(module, "recover_failed_scope_approval"),
}
print(json.dumps(payload, default=lambda value: sorted(value)))
`;
  const result = spawnSync("python3", ["-c", script, POLICY_PATH, JSON.stringify(devices)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
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

describe("OpenClaw device approval policy", () => {
  it.skipIf(!HAS_PYTHON3)("keeps allowlisting and gateway-environment stripping pure", () => {
    const payload = evaluatePolicy([
      {
        requestId: "bounded-cli",
        clientId: "cli",
        clientMode: "cli",
        scopes: ["operator.pairing", "operator.write"],
      },
      {
        requestId: "admin-cli",
        clientId: "cli",
        clientMode: "cli",
        scopes: ["operator.admin"],
      },
      {
        requestId: "malformed",
        clientId: "cli",
        clientMode: "cli",
        scopes: "operator.write",
      },
      {
        requestId: "unknown-client",
        clientId: "untrusted",
        clientMode: "untrusted",
        scopes: ["operator.read"],
      },
      {
        requestId: "spoofed-cli-mode",
        clientId: "evil",
        clientMode: "cli",
        scopes: ["operator.write"],
      },
      {
        requestId: "spoofed-webchat-mode",
        clientId: "evil",
        clientMode: "webchat",
        scopes: ["operator.read"],
      },
    ]);

    expect(payload.decisions.map((decision: { reason: string }) => decision.reason)).toEqual([
      "allowlisted",
      "disallowed-scopes",
      "malformed-scopes",
      "unknown-client",
      "unknown-client",
      "unknown-client",
    ]);
    expect(payload.approval_env).toEqual({ KEEP_ME: "yes" });
    expect(payload.has_recovery).toBe(false);
  });
});

describe("approval_request_decision scope-upgrade gate (#4462)", () => {
  it.skipIf(!HAS_PYTHON3)("allows a known client requesting the exact operator allowlist", () => {
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.pairing", "operator.read", "operator.write"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowlisted");
    expect(decision.scopes).toEqual(["operator.pairing", "operator.read", "operator.write"]);
  });

  it.skipIf(!HAS_PYTHON3)("rejects an unknown client regardless of the claimed mode", () => {
    const decision = decisionOf({
      clientId: "rogue-client",
      clientMode: "cli",
      scopes: ["operator.read"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown-client");
    expect(decision.scopes).toEqual([]);
  });

  it.skipIf(!HAS_PYTHON3)("rejects a scope superset that exceeds the allowlist", () => {
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.pairing", "operator.read", "operator.write", "operator.delete"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("disallowed-scopes");
  });

  it.skipIf(!HAS_PYTHON3)("allows a scope subset of the allowlist", () => {
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.read"],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowlisted");
    expect(decision.scopes).toEqual(["operator.read"]);
  });

  it.skipIf(!HAS_PYTHON3)("rejects malformed non-list scopes", () => {
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: "operator.read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("malformed-scopes");
  });

  it.skipIf(!HAS_PYTHON3)("rejects any operator.admin escalation from a known client", () => {
    const decision = decisionOf({
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("disallowed-scopes");
  });

  it.skipIf(!HAS_PYTHON3)("rejects an operator.admin-only request from a known client", () => {
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
  it.skipIf(!HAS_PYTHON3)("strips the three gateway keys and preserves everything else", () => {
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

  it.skipIf(!HAS_PYTHON3)("is a no-op when no gateway keys are present", () => {
    const proc = callGatewayEnv({ PATH: "/usr/bin", HOME: "/home/agent" });
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toEqual({ PATH: "/usr/bin", HOME: "/home/agent" });
  });
});
