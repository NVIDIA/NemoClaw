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
    return (
      inner.includes("local_pairing_list") &&
      inner.includes("approve_allowlisted_request") &&
      inner.includes("prune_cli_pairing_only_devices")
    );
  });
}

function findGatewayControlExec(dockerCalls: string[][]): string[] | undefined {
  return dockerCalls.find((call) => {
    const userIndex = call.indexOf("--user");
    return (
      call[0] === "exec" &&
      userIndex > 1 &&
      call.includes("LD_PRELOAD=") &&
      call.includes("PYTHONUSERBASE=") &&
      call.includes("PYTHONNOUSERSITE=1") &&
      call[userIndex + 1] === "root" &&
      call[userIndex + 3] === "/usr/local/bin/nemoclaw-gateway-control" &&
      call[userIndex + 4] === "recover" &&
      call.length === userIndex + 6
    );
  });
}

describe("sandbox connect auto-pair approval pass (#4263)", () => {
  it(
    "runs a bounded local-state approval pass before opening SSH",
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
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const approvalExec = findApprovalExec(state.sandboxExecCalls as string[][]);
      expect(approvalExec).toBeDefined();

      const script = extractApprovalPassScript(stateFile, sandboxName);
      // Hardened script content: source the proxy env, require python3,
      // and execute the trusted helper payload in memory instead of importing
      // authorization code from predictable shared temp storage.
      expect(script).toContain("/tmp/nemoclaw-proxy-env.sh");
      expect(script).toContain("command -v python3");
      expect(script).toContain("NEMOCLAW_APPROVAL_POLICY_B64=");
      expect(script).toContain("base64.b64decode");
      expect(script).toContain("exec(compile(policy_source");
      expect(script).toContain("local_pairing_list(STATE_DIR)");
      expect(script).toContain("decision = approval_request_decision(device, paired)");
      expect(script).toContain("if not decision['allowed']:");
      expect(script).toContain("approve_allowlisted_request(request_id, STATE_DIR, device)");
      expect(script).toContain("prune_cli_pairing_only_devices(STATE_DIR)");
      expect(script).not.toContain("/tmp/openclaw_device_approval_policy.py");
      expect(script).not.toContain("sys.path.insert(0, '/tmp')");
      expect(script).not.toContain("[OPENCLAW, 'devices'");
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
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const script = extractApprovalPassScript(stateFile, sandboxName);
      // Disallowed/malformed/unknown/first-time CLI requests are skipped by
      // the policy before an approve is attempted (they `continue` before the
      // counter increments), so they do not consume the MAX_APPROVALS=1 budget
      // (#4504). They are ordered first here to prove the rejection path runs;
      // the single allowed request (`ok-cli`) is then approved and exhausts the
      // one-attempt budget, so the trailing duplicate `ok-cli` is never reached.
      const run = runApprovalPassScript(
        script,
        [
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
            requestId: "first-cli",
            deviceId: "first-cli",
            publicKey: "first-cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.write"],
          },
          {
            requestId: "ok-cli",
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
          {
            requestId: "ok-cli",
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
        ],
        {},
        [
          {
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
          },
        ],
      );

      expect(run.result.status).toBe(0);
      // Only the first allowed request is approved — MAX_APPROVALS is 1 (#4504),
      // the realistic single pending CLI/webchat scope upgrade.
      expect(run.approvals).toEqual(["ok-cli"]);
      expect(run.approvalEnv).toEqual([]);
      expect(run.pendingAfter).toHaveProperty("first-cli");
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
      "def local_pairing_list(_state_dir=None):",
      "    return {'pending': [], 'paired': []}",
      "",
      "def approve_allowlisted_request(_request_id, _state_dir=None, _original_request=None):",
      "    raise RuntimeError('malicious helper used')",
      "",
      "def prune_cli_pairing_only_devices(_state_dir=None):",
      "    return []",
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
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Approval-pass exec was attempted (and the fake openshell exited
      // non-zero for it, per the hook above).
      const approvalExec = findApprovalExec(state.sandboxExecCalls as string[][]);
      expect(approvalExec).toBeDefined();
      // Despite the approval-pass failure, SSH handoff still happens.
      expect(state.sandboxConnectCalls).toContainEqual(["sandbox", "connect", sandboxName]);
    },
  );
});

// The #4504 fix also wires the approval pass into the `nemoclaw recover` /
// `connect --probe-only` path — the gateway-up branches only, never the
// gateway-down failure exit. The interactive-connect cases above cover the
// allowlist and best-effort semantics; these add the probe-path wiring,
// gateway-down negative, and the state-only timeout invariant.
describe("sandbox connect scope-upgrade approval on recover/probe (#4504)", () => {
  it(
    "runs the approval pass on the --probe-only (recover) path",
    testTimeoutOptions(20_000),
    () => {
      // The probe starts with a stopped gateway, recovers it through the
      // root-only PID 1 control helper, then runs the sweep without opening an
      // SSH session.
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
        { gatewaySupervisorRecovery: true },
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const controlExec = findGatewayControlExec(state.dockerCalls as string[][]);
      const userIndex = controlExec?.indexOf("--user") ?? -1;
      expect(controlExec?.slice(userIndex, userIndex + 5)).toEqual([
        "--user",
        "root",
        `openshell-${sandboxName}-fixture`,
        "/usr/local/bin/nemoclaw-gateway-control",
        "recover",
      ]);
      expect(controlExec).toContain("LD_PRELOAD=");
      expect(controlExec).toContain("PYTHONUSERBASE=");
      expect(controlExec).toContain("PYTHONNOUSERSITE=1");
      expect(controlExec?.[userIndex + 5]).toMatch(/^[0-9a-f]{64}$/);
      expect(state.gatewayRunning).toBe(true);
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
        { gatewaySupervisorRecovery: true },
      );

      const result = runConnect(tmpDir, sandboxName, { NEMOCLAW_TEST_FAIL_APPROVAL_PASS: "1" }, [
        "--probe-only",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

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
    "probe path approves local state without invoking OpenClaw as the CLI device (#5324)",
    testTimeoutOptions(20_000),
    () => {
      // Render the probe-path script, then run it against local state. The
      // approved request proves the recovery path no longer needs an
      // `openclaw devices approve` CLI subprocess that would pair the shared
      // CLI identity with pairing-only scope.
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
        { gatewaySupervisorRecovery: true },
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const script = extractApprovalPassScript(stateFile, sandboxName);
      expect(script).toContain("local_pairing_list(STATE_DIR)");
      expect(script).toContain("approve_allowlisted_request(request_id, STATE_DIR, device)");
      expect(script).not.toContain("'devices', 'approve'");

      const run = runApprovalPassScript(
        script,
        [
          {
            requestId: "probe-cli",
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
        ],
        {},
        [
          {
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
          },
        ],
      );
      expect(run.result.status).toBe(0);
      expect(run.approvals).toEqual(["probe-cli"]);
      expect(run.approvalEnv).toEqual([]);
      expect(run.pairedAfter["cli-1"].approvedScopes).toEqual([
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]);
    },
  );

  it(
    "state-only approval keeps historical budgets inert and stays within the outer cap",
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
        { gatewaySupervisorRecovery: true },
      );

      const result = runConnect(tmpDir, sandboxName, {}, ["--probe-only"]);
      expect(result.status).toBe(0);

      const script = extractApprovalPassScript(stateFile, sandboxName);
      // Historical list/approve budgets remain on the options object for
      // compatibility, but the rendered script no longer uses them for
      // OpenClaw subprocesses.
      expect(script).not.toContain("[OPENCLAW, 'devices', 'list', '--json']");
      expect(script).not.toContain(`timeout=${CONNECT_AUTO_PAIR_LIST_TIMEOUT_S},`);
      expect(script).not.toContain(`timeout=${CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S},`);
      expect(script).toContain(`MAX_APPROVALS = ${CONNECT_AUTO_PAIR_MAX_APPROVALS}`);

      // The historical constants are preserved for API compatibility.
      expect(CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S).toBe(10);
      expect(CONNECT_AUTO_PAIR_LIST_TIMEOUT_S).toBe(2);

      // The only active wall-clock cap is the outer sandbox-exec timeout.
      expect(CONNECT_AUTO_PAIR_TIMEOUT_MS).toBeGreaterThan(0);
    },
  );
});
