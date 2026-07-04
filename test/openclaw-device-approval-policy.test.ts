// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_PATH = path.join(REPO_ROOT, "scripts", "lib", "openclaw_device_approval_policy.py");

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

describe("OpenClaw device approval policy", () => {
  it("keeps allowlisting and gateway-environment stripping pure", () => {
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
