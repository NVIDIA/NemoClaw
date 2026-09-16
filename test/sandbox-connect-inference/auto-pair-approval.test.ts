// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../helpers/timeouts";
import {
  extractApprovalPassScript,
  runApprovalPassScript,
  runConnect,
  setupFixture,
} from "./helpers";

function findApprovalExec(state: {
  sandboxExecCalls: string[][];
  sandboxExecInputs: string[];
}): string[] | undefined {
  const approvalIndex = state.sandboxExecInputs.findIndex(
    (input) => input.includes("openclaw") && input.includes("devices") && input.includes("approve"),
  );
  return state.sandboxExecCalls[approvalIndex];
}

describe("sandbox connect auto-pair approval pass (#4263)", () => {
  it(
    "runs a bounded openclaw devices approval pass before opening SSH",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "approval-pass-sb",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const script = extractApprovalPassScript(stateFile, sandboxName);
      // Hardened script content: source the proxy env, require local tools,
      // and execute the trusted helper payload in memory instead of importing
      // authorization code from predictable shared temp storage.
      expect(script).toContain("/tmp/nemoclaw-proxy-env.sh");
      expect(script).toContain("command -v openclaw");
      expect(script).toContain("command -v python3");
      expect(script).toContain("devices");
      expect(script).toContain("list");
      expect(script).toContain("approve");
      expect(script).toContain("NEMOCLAW_APPROVAL_POLICY_B64=");
      expect(script).toContain("base64.b64decode");
      expect(script).toContain("exec(compile(policy_source");
      expect(script).toContain("decision = approval_request_decision(device)");
      expect(script).toContain("if not decision['allowed']:");
      expect(script).toContain("approve_env = gateway_approval_env(os.environ)");
      expect(script).toContain("env=approve_env");
      expect(script).toContain("if approve_proc.returncode == 0");
      expect(script).not.toContain("/tmp/openclaw_device_approval_policy.py");
      expect(script).not.toContain("sys.path.insert(0, '/tmp')");
      expect(script.indexOf("[OPENCLAW, 'devices', 'list', '--json']")).toBeLessThan(
        script.indexOf("approve_env = gateway_approval_env(os.environ)"),
      );
    },
  );

  it(
    "rejects malformed and disallowed scope requests when the approval pass runs",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "approval-pass-pol",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const script = extractApprovalPassScript(stateFile, sandboxName);
      // Disallowed/malformed/unknown requests are skipped by the policy before
      // an approve is even attempted (they `continue` before the attempt
      // counter increments), so they do not consume the bounded approval
      // budget (#4504). They are ordered first here to prove the rejection path
      // runs. The initial CLI pairing and its write-scope upgrade are then both
      // approved, while the trailing distinct request proves the two-approval
      // cap stops the pass.
      const run = runApprovalPassScript(script, [
        {
          requestId: "admin-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.admin"],
        },
        {
          requestId: "malformed-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          requestedScopes: "operator.write",
        },
        {
          requestId: "unknown-client",
          clientId: "evil-client",
          clientMode: "unknown",
          scopes: ["operator.read"],
        },
        {
          requestId: "initial-cli-pairing",
          clientId: "cli",
          clientMode: "cli",
          scopes: ["operator.pairing"],
        },
        {
          requestId: "cli-write-upgrade",
          clientId: "cli",
          clientMode: "cli",
          scopes: ["operator.pairing", "operator.write"],
        },
        {
          requestId: "later-webchat-upgrade",
          clientId: "openclaw-control-ui",
          clientMode: "webchat",
          scopes: ["operator.read", "operator.write"],
        },
      ]);

      expect(run.result.status).toBe(0);
      expect(run.approvals).toEqual(["initial-cli-pairing", "cli-write-upgrade"]);
      expect(run.approvalEnv).toEqual(["unset:unset:unset", "unset:unset:unset"]);
    },
  );

  it("does not import approval policy from PYTHONPATH", testTimeoutOptions(20_000), () => {
    const { tmpDir, stateFile, sandboxName } = setupFixture(
      {
        name: "approval-tmp-tamper",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic-prod",
        gpuEnabled: false,
      },
      "anthropic-prod",
      "claude-sonnet-4-20250514",
    );
    const maliciousPolicy = [
      "def approval_request_decision(_device):",
      "    return {'allowed': True, 'reason': 'allowlisted', 'client_id': 'evil', 'client_mode': 'cli', 'scopes': set()}",
      "",
      "def gateway_approval_env(source_env=None):",
      "    return dict(source_env or {})",
      "",
    ].join("\n");
    const maliciousPythonPath = path.join(tmpDir, "malicious-pythonpath");

    fs.mkdirSync(maliciousPythonPath);
    fs.writeFileSync(
      path.join(maliciousPythonPath, "openclaw_device_approval_policy.py"),
      maliciousPolicy,
    );

    const result = runConnect(tmpDir, sandboxName);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const script = extractApprovalPassScript(stateFile, sandboxName);
    const run = runApprovalPassScript(
      script,
      [
        {
          requestId: "admin-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.admin"],
        },
      ],
      { PYTHONPATH: maliciousPythonPath },
    );

    expect(run.result.status).toBe(0);
    expect(run.approvals).toEqual([]);
  });

  it(
    "does not block connect when the in-sandbox approval pass cannot run",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "approval-tolerant",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      // Force the approval-pass sandbox-exec to fail with exit status 7
      // (simulated via the OPENSHELL_TEST_FAIL_APPROVAL_PASS hook in the
      // fake openshell). The connect flow must still reach SSH handoff —
      // the approval pass is best-effort and must not surface failures.
      const result = runConnect(tmpDir, sandboxName, {
        OPENSHELL_TEST_FAIL_APPROVAL_PASS: "1",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Approval-pass exec was attempted (and the fake openshell exited
      // non-zero for it, per the hook above).
      const approvalExec = findApprovalExec(state);
      expect(approvalExec).toBeDefined();
      // Despite the approval-pass failure, the interactive exec handoff still happens.
      expect(state.sandboxConnectCalls).toEqual([]);
      expect(state.sandboxExecCalls).toContainEqual([
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        "--tty",
        "--",
        "/bin/bash",
        "-i",
      ]);
    },
  );
});

// The #4504 fix also wires the approval pass into the `nemoclaw recover` /
// `connect --probe-only` path (defect A) — the gateway-up branches only, never
// the gateway-down failure exit — and re-uses the shared policy's
// gateway_approval_env so a scope-upgrade approve drops the full gateway env
// triplet (#4462) on the watcher's 10s budget while staying within the outer
// spawnSync cap (defect B). The interactive-connect cases above cover the
// allowlist and best-effort semantics; these add the probe-path wiring,
// gateway-down negative, and the budget invariant on the real constants.
