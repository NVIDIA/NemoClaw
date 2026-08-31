// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as forwardHealth from "../../src/lib/actions/sandbox/forward-health.js";
import { ensureSandboxPortForwardForPort } from "../../src/lib/actions/sandbox/forward-recovery.js";
import * as openshellRuntime from "../../src/lib/adapters/openshell/runtime.js";
import * as registry from "../../src/lib/state/registry.js";

const SANDBOX_NOT_READY_DIAGNOSTIC = `Error:   × code: 'The system is not in a state required for the operation's
   │ execution', message: "sandbox is not ready"
`;
const LISTENER_DIAGNOSTIC = "ssh exited before local forward listener opened";
const FORWARD_LIST_HEADER = "SANDBOX  BIND  PORT  PID  STATUS";

type ForwardStartStubState = {
  attempts: number;
  started: boolean;
};

function forwardListOutput(owner: string | null, port: number): string {
  return owner === null
    ? FORWARD_LIST_HEADER
    : `${FORWARD_LIST_HEADER}\n${owner}  127.0.0.1  ${port}  12345  running`;
}

function stubForwardStart(options: {
  diagnostic: string;
  failures: number;
  owner?: () => string | null;
  port?: number;
  sandboxName?: string;
}): ForwardStartStubState {
  const sandboxName = options.sandboxName ?? "beta";
  const port = options.port ?? 18791;
  const state: ForwardStartStubState = { attempts: 0, started: false };

  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => state.started);
  vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
    status: 0,
    output: forwardListOutput(options.owner?.() ?? (state.started ? sandboxName : null), port),
  }));
  vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation(
    (rawArgs: unknown, rawOpts: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      const isForwardStart = args[0] === "forward" && args[1] === "start";
      state.attempts += Number(isForwardStart);
      const succeeded = isForwardStart && state.attempts > options.failures;
      state.started ||= succeeded;
      const stdio = (rawOpts as { stdio?: unknown })?.stdio;
      const handle = Array.isArray(stdio) ? stdio[1] : undefined;
      isForwardStart &&
        !succeeded &&
        typeof handle === "number" &&
        fs.writeSync(handle, options.diagnostic);
      return { status: Number(isForwardStart && !succeeded) } as never;
    },
  );
  return state;
}

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses: checkAndRecoverSandboxProcessesImpl } = requireSource(
  "../../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/process-recovery.js");

function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: Parameters<typeof checkAndRecoverSandboxProcessesImpl>[1] = {},
) {
  return checkAndRecoverSandboxProcessesImpl(sandboxName, { isWsl: false, ...options });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function withFakeOpenshellBinary<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
  const bin = path.join(dir, "openshell");
  const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
  const restoreEnv =
    previous === undefined
      ? () => {
          delete process.env.NEMOCLAW_OPENSHELL_BIN;
        }
      : () => {
          process.env.NEMOCLAW_OPENSHELL_BIN = previous;
        };
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.NEMOCLAW_OPENSHELL_BIN = bin;
  try {
    return fn();
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function compactTeamsMessagingPlan(port = "3978") {
  return {
    schemaVersion: 1,
    sandboxName: "beta",
    agent: "openclaw",
    workflow: "onboard",
    disabledChannels: [],
    networkPolicy: {
      presets: ["teams"],
      entries: [
        {
          channelId: "teams",
          presetName: "teams",
          policyKeys: ["teams"],
          source: "manifest",
        },
      ],
    },
    channels: [
      {
        channelId: "teams",
        active: true,
        configured: true,
        disabled: false,
        inputs: [
          { inputId: "allowedUsers", value: "00000000-0000-0000-0000-000000000001" },
          { inputId: "appId", value: "test-teams-app-id" },
          { inputId: "clientSecret", credentialAvailable: true },
          { inputId: "requireMention", value: "1" },
          { inputId: "tenantId", value: "test-teams-tenant-id" },
          { inputId: "webhookPort", value: port },
        ],
      },
    ],
    credentialBindings: [],
  };
}

describe("checkAndRecoverSandboxProcesses primary forward failure", () => {
  it("fails closed when OpenShell forward state is unavailable", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const childProcess = requireSource("node:child_process");

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 1,
      output: "OpenShell forward state unavailable",
    });
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell");

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the primary dashboard/API host forward could not be verified because OpenShell forward state was unavailable",
    });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports failure when a messaging forward cannot recover even if the primary is healthy", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.ts");
    const childProcess = requireSource("node:child_process");

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
      messaging: { schemaVersion: 1, plan: compactTeamsMessagingPlan() },
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(
      (port: unknown) => Number(port) === 18789,
    );
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return { status: args[0] === "forward" && args[1] === "start" ? 1 : 0 } as never;
    });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the messaging webhook host forward could not be re-established",
    });
  });

  it("reports failure when the primary forward cannot recover even if secondary forwards recover", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.ts");
    const childProcess = requireSource("node:child_process");
    let teamsForwardStarted = false;

    // Forward visibility is fixed by mocks, so the production settle window is unnecessary.
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
      messaging: { schemaVersion: 1, plan: compactTeamsMessagingPlan() },
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: teamsForwardStarted
        ? `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  3978  12346  running`
        : `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  dead`,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        const startsTeamsForward = isForwardStart && args.includes("3978");
        teamsForwardStarted = teamsForwardStarted || startsTeamsForward;
        return { status: isForwardStart && args.includes("18789") ? 1 : 0 } as never;
      });
    const onForwardRecoveryFailure = vi.fn();

    expect(
      withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("beta", { quiet: true, onForwardRecoveryFailure }),
      ),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the primary dashboard/API host forward for sandbox 'beta' on port 18789 did not recover because OpenShell rejected the start",
    });
    expect(onForwardRecoveryFailure).toHaveBeenCalledWith({
      port: 18789,
      reason: "forward-start-failure",
      sandboxName: "beta",
    });
    expect(teamsForwardStarted).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "3978", "beta", "--gateway", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
  });
});

describe("ensureSandboxPortForwardForPort already-forwarded idempotency (#7085)", () => {
  it("reconciles a reachable ownerless listener with a nonzero recovery wait", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "25");
    let started = false;

    // The pre-start list remains ownerless for the full stop-settle window,
    // while OpenShell's idempotent start refreshes the authoritative owner row.
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: started
        ? `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18791  12345  running`
        : "SANDBOX  BIND  PORT  PID  STATUS",
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        started ||= isForwardStart;
        return { status: Number(isForwardStart) } as never;
      });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, { expectedBind: "127.0.0.1" }),
      ),
    ).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18791", "beta", "--gateway", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("accepts an already-active target-owned forward when `forward start` exits non-zero", () => {
    // Forward visibility is fixed by mocks, so the production settle window is unnecessary.
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");

    // The port is listening throughout; OpenShell's forward list only shows the
    // live owner after the (idempotent) start, modelling the stale-list drift
    // that makes recovery attempt a stop -> start on an already-active forward.
    let started = false;
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: started
        ? `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18791  12345  running`
        : `SANDBOX  BIND  PORT  PID  STATUS`,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        started ||= isForwardStart;
        // OpenShell exits non-zero because the port is already forwarded.
        return { status: Number(isForwardStart) } as never;
      });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, { expectedBind: "127.0.0.1" }),
      ),
    ).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18791", "beta", "--gateway", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("still fails when `forward start` exits non-zero and no target-owned forward is active", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");

    // No live owner row ever appears: a genuine start failure must not be
    // masked by the idempotency re-probe.
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS",
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return { status: args[0] === "forward" && args[1] === "start" ? 1 : 0 } as never;
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, { expectedBind: "127.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("rejects a reachable listener that never gains authoritative ownership", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "25");

    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    const captureOpenshell = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "SANDBOX  BIND  PORT  PID  STATUS",
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        return { status: Number(isForwardStart) } as never;
      });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, { expectedBind: "127.0.0.1" }),
      ),
    ).toBe(false);
    expect(captureOpenshell.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18791", "beta", "--gateway", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("waits for delayed target ownership after a non-zero `forward start`", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "250");
    let started = false;
    let postStartProbes = 0;

    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => started);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => {
      postStartProbes += Number(started);
      return {
        status: 0,
        output:
          postStartProbes >= 2
            ? `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18791  12345  running`
            : "SANDBOX  BIND  PORT  PID  STATUS",
      };
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      const isForwardStart = args[0] === "forward" && args[1] === "start";
      started ||= isForwardStart;
      return { status: Number(isForwardStart) } as never;
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, { expectedBind: "127.0.0.1" }),
      ),
    ).toBe(true);
    expect(postStartProbes).toBe(2);
  });

  it("rejects delayed ownership by another sandbox after a non-zero `forward start`", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "250");
    let started = false;
    let postStartProbes = 0;

    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => started);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => {
      postStartProbes += Number(started);
      return {
        status: 0,
        output:
          postStartProbes >= 2
            ? `SANDBOX  BIND  PORT  PID  STATUS
gamma  127.0.0.1  18791  12345  running`
            : "SANDBOX  BIND  PORT  PID  STATUS",
      };
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      const isForwardStart = args[0] === "forward" && args[1] === "start";
      started ||= isForwardStart;
      return { status: Number(isForwardStart) } as never;
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, { expectedBind: "127.0.0.1" }),
      ),
    ).toBe(false);
    expect(postStartProbes).toBe(2);
  });
});

describe("ensureSandboxPortForwardForPort readiness-handoff retries after stop (#10640)", () => {
  it("scopes every recovery operation to the sandbox gateway", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "25");
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      gatewayPort: 18080,
      name: "beta",
    } as NonNullable<ReturnType<typeof registry.getSandbox>>);
    const state = stubForwardStart({
      diagnostic: SANDBOX_NOT_READY_DIAGNOSTIC,
      failures: 2,
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, {
          expectedBind: "127.0.0.1",
          sleepMs: () => {},
        }),
      ),
    ).toBe(true);

    const listCalls = vi.mocked(openshellRuntime.captureOpenshell).mock.calls;
    expect(listCalls.length).toBeGreaterThan(0);
    expect(
      listCalls.every(([args]) => args.join(" ") === "forward list --gateway nemoclaw-18080"),
    ).toBe(true);
    const recoveryCalls = vi
      .mocked(openshellRuntime.runOpenshell)
      .mock.calls.map(([args]) => args.map(String));
    expect(recoveryCalls).toContainEqual([
      "forward",
      "stop",
      "18791",
      "beta",
      "--gateway",
      "nemoclaw-18080",
    ]);
    expect(recoveryCalls.filter((args) => args[0] === "forward" && args[1] === "start")).toEqual([
      ["forward", "start", "--background", "18791", "beta", "--gateway", "nemoclaw-18080"],
      ["forward", "start", "--background", "18791", "beta", "--gateway", "nemoclaw-18080"],
      ["forward", "start", "--background", "18791", "beta", "--gateway", "nemoclaw-18080"],
    ]);
    expect(state.attempts).toBe(3);
  });

  it("recovers the dashboard forward when OpenShell rejects the first starts as not ready", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "25");
    const state = stubForwardStart({
      diagnostic: SANDBOX_NOT_READY_DIAGNOSTIC,
      failures: 2,
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, {
          expectedBind: "127.0.0.1",
          sleepMs: () => {},
        }),
      ),
    ).toBe(true);
    expect(state.attempts).toBe(3);
  });

  it("recovers the dashboard forward when ssh exits before its listener opens", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "25");
    const state = stubForwardStart({ diagnostic: LISTENER_DIAGNOSTIC, failures: 1 });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, {
          expectedBind: "127.0.0.1",
          sleepMs: () => {},
        }),
      ),
    ).toBe(true);
    expect(state.attempts).toBe(2);
  });

  it("fails without retrying when OpenShell reports an unrelated forward failure", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    const state = stubForwardStart({
      diagnostic: "Error: gateway authentication failed",
      failures: 99,
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, {
          expectedBind: "127.0.0.1",
          sleepMs: () => {},
        }),
      ),
    ).toBe(false);
    expect(state.attempts).toBe(1);
  });

  it("stops retrying when OpenShell forward state becomes unavailable", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    let attempts = 0;
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() =>
      attempts === 0
        ? { status: 0, output: FORWARD_LIST_HEADER }
        : { status: 1, output: "OpenShell forward state unavailable" },
    );
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation(
      (rawArgs: unknown, rawOpts: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        attempts += Number(isForwardStart);
        const stdio = (rawOpts as { stdio?: unknown })?.stdio;
        const handle = Array.isArray(stdio) ? stdio[1] : undefined;
        isForwardStart &&
          typeof handle === "number" &&
          fs.writeSync(handle, SANDBOX_NOT_READY_DIAGNOSTIC);
        return { status: Number(isForwardStart) } as never;
      },
    );

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, {
          expectedBind: "127.0.0.1",
          sleepMs: () => {},
        }),
      ),
    ).toBe(false);
    expect(attempts).toBe(1);
  });

  it("stops retrying when another sandbox takes the port during the readiness settle", () => {
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    let owner: string | null = null;
    const state = stubForwardStart({
      diagnostic: SANDBOX_NOT_READY_DIAGNOSTIC,
      failures: 99,
      owner: () => owner,
    });

    expect(
      withFakeOpenshellBinary(() =>
        ensureSandboxPortForwardForPort("beta", 18791, {
          expectedBind: "127.0.0.1",
          sleepMs: () => {
            owner = "gamma";
          },
        }),
      ),
    ).toBe(false);
    expect(state.attempts).toBe(1);
  });

  it("reports when the OpenShell readiness retry limit is reached", () => {
    const sourceForwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.ts");
    const sourceOpenshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const childProcess = requireSource("node:child_process");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    let attempts = 0;
    vi.spyOn(sourceForwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(sourceOpenshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: FORWARD_LIST_HEADER,
    });
    vi.spyOn(sourceOpenshellRuntime, "runOpenshell").mockImplementation(
      (rawArgs: unknown, rawOpts: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        attempts += Number(isForwardStart);
        const stdio = (rawOpts as { stdio?: unknown })?.stdio;
        const handle = Array.isArray(stdio) ? stdio[1] : undefined;
        isForwardStart &&
          typeof handle === "number" &&
          fs.writeSync(handle, SANDBOX_NOT_READY_DIAGNOSTIC);
        return { status: Number(isForwardStart) } as never;
      },
    );
    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isLocalPortProbe = args[0] === "-e" && args[1]?.includes("net.createConnection");
        return {
          status: isLocalPortProbe ? 1 : 0,
          stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
          stderr: "",
        } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
    });

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("beta", { quiet: true }),
    );

    expect(attempts).toBe(13);
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the primary dashboard/API host forward for sandbox 'beta' on port 18789 reached the OpenShell readiness retry limit",
    });
  });
});
