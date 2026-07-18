// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as forwardHealth from "../src/lib/actions/sandbox/forward-health.js";
import { ensureSandboxPortForwardForPort } from "../src/lib/actions/sandbox/forward-recovery.js";
import * as openshellRuntime from "../src/lib/adapters/openshell/runtime.js";

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses: checkAndRecoverSandboxProcessesImpl } = requireSource(
  "../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/process-recovery.js");

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
  it("reports failure when a messaging forward cannot recover even if the primary is healthy", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.ts");
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
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.ts");
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

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the primary dashboard/API host forward could not be re-established",
    });
    expect(teamsForwardStarted).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "3978", "beta"],
      { ignoreError: true, stdio: "ignore" },
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
      ["forward", "start", "--background", "18791", "beta"],
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
      ["forward", "start", "--background", "18791", "beta"],
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
      ["forward", "start", "--background", "18791", "beta"],
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
