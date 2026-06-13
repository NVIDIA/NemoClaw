// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "../../src/lib/actions/sandbox/connect-autopair-budget";
import { testTimeoutOptions } from "../helpers/timeouts";
import {
  decodeWrappedSandboxScript,
  extractApprovalPassScript,
  runApprovalPassScript,
  runConnect,
  setupFixture,
} from "./helpers";

function findApprovalExec(sandboxExecCalls: string[][]): string[] | undefined {
  // The approval-pass payload is base64-wrapped so it survives OpenShell exec's
  // no-newline-in-args rule (wrapSandboxShellScript), so identify the call by
  // its decoded payload rather than literal segments.
  return sandboxExecCalls.find((call) => {
    if (!call.includes("--")) return false;
    const inner = decodeWrappedSandboxScript(call[call.length - 1] || "");
    return inner.includes("openclaw") && inner.includes("devices") && inner.includes("approve");
  });
}

describe("sandbox connect auto-pair approval pass (#4263)", () => {
  it(
    "runs a bounded openclaw devices approval pass before opening SSH",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "approval-pass-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

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
          name: "approval-pass-policy",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);
      const script = extractApprovalPassScript(stateFile, sandboxName);
      // Disallowed/malformed/unknown requests are skipped by the policy before
      // an approve is even attempted (they `continue` before the attempt
      // counter increments), so they do not consume the MAX_APPROVALS=1 budget
      // (#4504). They are ordered first here to prove the rejection path runs;
      // the single allowed request (`ok-cli`) is then approved and exhausts the
      // one-attempt budget, so the trailing duplicate `ok-cli` is never reached.
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
          requestId: "ok-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.read", "operator.write"],
        },
        {
          requestId: "ok-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.read", "operator.write"],
        },
      ]);

      expect(run.result.status).toBe(0);
      // Only the first allowed request is approved — MAX_APPROVALS is 1 (#4504),
      // the realistic single pending CLI/webchat scope upgrade.
      expect(run.approvals).toEqual(["ok-cli"]);
      expect(run.approvalEnv).toEqual(["unset:unset:unset"]);
    },
  );

  it("does not import approval policy from PYTHONPATH", testTimeoutOptions(20_000), () => {
    const { tmpDir, stateFile, sandboxName } = setupFixture(
      {
        name: "approval-pass-tmp-tamper",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic-prod",
        gpuEnabled: false,
        policies: [],
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
    expect(result.status).toBe(0);
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
          name: "approval-pass-tolerant",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      // Force the approval-pass sandbox-exec to fail with exit status 7
      // (simulated via the NEMOCLAW_TEST_FAIL_APPROVAL_PASS hook in the
      // fake openshell). The connect flow must still reach SSH handoff —
      // the approval pass is best-effort and must not surface failures.
      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_TEST_FAIL_APPROVAL_PASS: "1",
      });
      expect(result.status).toBe(0);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Approval-pass exec was attempted (and the fake openshell exited
      // non-zero for it, per the hook above).
      const approvalExec = (state.sandboxExecCalls as string[][]).find((call) => {
        if (!call.includes("--")) return false;
        // The payload is base64-wrapped for OpenShell exec; decode to identify it.
        const inner = decodeWrappedSandboxScript(call[call.length - 1] || "");
        return inner.includes("openclaw") && inner.includes("devices") && inner.includes("approve");
      });
      expect(approvalExec).toBeDefined();
      // Despite the approval-pass failure, SSH handoff still happens.
      expect(state.sandboxConnectCalls).toContainEqual(["sandbox", "connect", sandboxName]);
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
describe("sandbox connect scope-upgrade approval on recover/probe (#4504)", () => {
  it(
    "runs the approval pass on the --probe-only (recover) path",
    testTimeoutOptions(20_000),
    () => {
      // The probe takes the wasRunning branch (the fake openshell health probe
      // reports RUNNING), so the recover path must run the sweep — and must NOT
      // open an SSH session.
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-approval-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const approvalExec = findApprovalExec(state.sandboxExecCalls as string[][]);
      expect(approvalExec).toBeDefined();
      expect(approvalExec).toContain("sandbox");
      expect(approvalExec).toContain("exec");
      expect(approvalExec).toContain("--name");
      expect(approvalExec).toContain(sandboxName);
      // probe-only never opens an SSH connect session.
      expect(state.sandboxConnectCalls).toEqual([]);
    },
  );

  it(
    "does not fail the recover path when the probe approval pass errors",
    testTimeoutOptions(20_000),
    () => {
      // Best-effort: even when the in-sandbox approval exec exits non-zero, the
      // probe-only flow must still succeed.
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-approval-tolerant",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName, { NEMOCLAW_TEST_FAIL_APPROVAL_PASS: "1" }, [
        "--probe-only",
      ]);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const approvalExec = findApprovalExec(state.sandboxExecCalls as string[][]);
      expect(approvalExec).toBeDefined();
    },
  );

  it(
    "does not run the approval pass when the probe fails (gateway down, recovery fails)",
    testTimeoutOptions(20_000),
    () => {
      // The sweep is wired only into the wasRunning and recovered success
      // branches — never the not-running failure exit, where the gateway is
      // down. Force the health probe to report STOPPED and let recovery fail so
      // the probe lands on the failure branch; the approval pass must NOT run.
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-gateway-down",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName, { NEMOCLAW_TEST_GATEWAY_DOWN: "1" }, [
        "--probe-only",
      ]);
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const approvalExec = findApprovalExec(state.sandboxExecCalls as string[][]);
      expect(approvalExec).toBeUndefined();
      // And it never opens an SSH session on the failure path.
      expect(state.sandboxConnectCalls).toEqual([]);
    },
  );

  it(
    "approve child strips the full gateway env triplet on the probe path (#4462)",
    testTimeoutOptions(20_000),
    () => {
      // The probe-path approve must drop OPENCLAW_GATEWAY_URL/_PORT/_TOKEN via
      // the shared policy's gateway_approval_env so the local pairing fallback
      // cannot re-pin to the gateway and hit the #4462 self-defeat. Render the
      // probe-path script, then actually run it and assert the approve child
      // saw none of the triplet.
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-env-strip-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const script = extractApprovalPassScript(stateFile, sandboxName);
      expect(script).toContain("approve_env = gateway_approval_env(os.environ)");
      expect(script).toContain("env=approve_env");

      const run = runApprovalPassScript(script, [
        {
          requestId: "probe-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.read", "operator.write"],
        },
      ]);
      expect(run.result.status).toBe(0);
      expect(run.approvals).toEqual(["probe-cli"]);
      // The approve child saw none of the gateway env triplet (#4462).
      expect(run.approvalEnv).toEqual(["unset:unset:unset"]);
    },
  );

  it(
    "approve timeout matches the watcher (10s), list keeps 2s, and stays within the outer cap",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "approve-budget-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "anthropic-prod",
        "claude-sonnet-4-20250514",
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const script = extractApprovalPassScript(stateFile, sandboxName);
      // The rendered script interpolates the exported budget constants, tying
      // runtime behaviour to the values the invariant below asserts on (no
      // source-text scraping — numbers come from the imported constants).
      expect(script).toContain("[OPENCLAW, 'devices', 'list', '--json']");
      expect(script).toContain(`timeout=${CONNECT_AUTO_PAIR_LIST_TIMEOUT_S},`);
      expect(script).toContain(`timeout=${CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S},`);
      expect(script).toContain(`MAX_APPROVALS = ${CONNECT_AUTO_PAIR_MAX_APPROVALS}`);

      // Approve budget matches the in-sandbox watcher RUN_TIMEOUT_SECS = 10;
      // list budget is 2s.
      expect(CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S).toBe(10);
      expect(CONNECT_AUTO_PAIR_LIST_TIMEOUT_S).toBe(2);

      // Budget invariant: the inner worst case (list + approve × MAX_APPROVALS)
      // must stay STRICTLY below the outer spawnSync cap. The outer timer starts
      // when `sh` is spawned — before shell startup, sourcing the proxy env, the
      // python3 launch, and `devices list` even begin — so the cap must leave
      // slack above the inner budget, or a legitimate slow 10s approve is killed
      // mid-loop and the allowlisted request is stranded (#4504).
      const innerBudgetSeconds =
        CONNECT_AUTO_PAIR_LIST_TIMEOUT_S +
        CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S * CONNECT_AUTO_PAIR_MAX_APPROVALS;
      expect(innerBudgetSeconds).toBeLessThan(CONNECT_AUTO_PAIR_TIMEOUT_MS / 1000);
    },
  );
});
