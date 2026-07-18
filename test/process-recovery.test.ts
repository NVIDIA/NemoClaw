// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses: checkAndRecoverSandboxProcessesImpl } = requireSource(
  "../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/process-recovery.js");
const { ensureSandboxPortForwardForPort } = requireSource(
  "../src/lib/actions/sandbox/forward-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/forward-recovery.js");

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

function decodeSandboxExecShellPayload(payload: string): string {
  const match = payload.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d \| sh/);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : payload;
}

function getSandboxExecShellCommand(rawArgs: unknown): string {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  return decodeSandboxExecShellPayload(String(args.at(-1) ?? ""));
}

function withFakeOpenshellBinary<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
  const bin = path.join(dir, "openshell");
  const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.NEMOCLAW_OPENSHELL_BIN = bin;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = previous;
    }
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

describe("checkAndRecoverSandboxProcesses", () => {
  it("does not attempt gateway recovery for terminal agents", () => {
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      runtime: { kind: "terminal" },
    } as never);

    expect(checkAndRecoverSandboxProcesses("terminal-box", { quiet: true })).toEqual({
      checked: true,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
      runtime: "terminal",
    });
  });

  it("scopes forward stop to the target sandbox when restarting a dead forward", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const deadForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  dead`;
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`;
    let forwardStarted = false;
    let postStartListCalls = 0;

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("validate-hermes-env-secret-boundary.py")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSECRET_BOUNDARY_OK\n",
            stderr: "",
          } as never;
        }
        return {
          status: 0,
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
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => forwardStarted);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs : [];
      expect(args).toEqual(["forward", "list"]);
      postStartListCalls += Number(forwardStarted);
      return {
        status: 0,
        output: forwardStarted && postStartListCalls >= 2 ? runningForward : deadForward,
      };
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        forwardStarted = forwardStarted || (args[0] === "forward" && args[1] === "start");
        return { status: 0 } as never;
      });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "beta"], {
      ignoreError: true,
      stdio: "ignore",
    });
    expect(
      runOpenshell.mock.calls.some(
        ([args]) =>
          Array.isArray(args) && args[0] === "forward" && args[1] === "stop" && args.length === 3,
      ),
    ).toBe(false);
  });

  it.each([
    { dashboardBind: "0.0.0.0", isWsl: false, requirement: "remote bind" },
    { dashboardBind: "", isWsl: true, requirement: "WSL" },
  ])("restarts a loopback forward when $requirement requires all interfaces (#6024)", ({
    dashboardBind,
    isWsl,
  }) => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    let forwardStarted = false;

    vi.stubEnv("NEMOCLAW_DASHBOARD_BIND", dashboardBind);
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
      dashboardRemoteBindPrepared: true,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output:
        "SANDBOX  BIND  PORT  PID  STATUS\n" +
        `beta  ${forwardStarted ? "0.0.0.0" : "127.0.0.1"}  18789  12345  running`,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        forwardStarted ||= args[0] === "forward" && args[1] === "start";
        return { status: 0 } as never;
      });

    expect(
      withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("beta", { isWsl, quiet: true }),
      ),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "0.0.0.0:18789", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("waits for a stopped forward listener to release before starting its replacement", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const events: string[] = [];
    let staleListenerProbes = 2;
    let forwardStarted = false;

    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "1000");
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: forwardStarted
        ? "SANDBOX  BIND  PORT  PID  STATUS\nbeta  127.0.0.1  8642  23456  running"
        : "",
    }));
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => {
      const staleListenerReachable = !forwardStarted && staleListenerProbes > 0;
      staleListenerProbes -= Number(staleListenerReachable);
      forwardStarted || events.push(staleListenerReachable ? "stale-listener" : "released");
      return forwardStarted || staleListenerReachable;
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const startingForward = args[0] === "forward" && args[1] === "start";
        startingForward && events.push("start");
        forwardStarted ||= startingForward;
        return { status: 0 } as never;
      });

    expect(ensureSandboxPortForwardForPort("beta", 8642)).toBe(true);
    expect(events).toEqual(["stale-listener", "stale-listener", "released", "start"]);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "8642", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("fails closed after start reconciliation when a listener remains unowned", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");

    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "25");
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({ status: 0, output: "" });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        return { status: Number(args[0] === "forward" && args[1] === "start") } as never;
      });

    expect(ensureSandboxPortForwardForPort("beta", 8642)).toBe(false);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "8642", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("checkAndRecoverSandboxProcesses re-establishes an active Teams messaging host forward from a compact plan when the dashboard forward is healthy", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const dashboardForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`;
    const dashboardAndTeamsForwards = `${dashboardForward}
beta  127.0.0.1  3978  12346  running`;
    let teamsForwardStarted = false;

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
      (port: unknown) => Number(port) === 18789 || teamsForwardStarted,
    );
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: teamsForwardStarted ? dashboardAndTeamsForwards : dashboardForward,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        teamsForwardStarted =
          teamsForwardStarted ||
          (args[0] === "forward" &&
            args[1] === "start" &&
            args.includes("--background") &&
            args.includes("3978") &&
            args.includes("beta"));
        return { status: 0 } as never;
      });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });
    expect(teamsForwardStarted).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "3978", "beta"], {
      ignoreError: true,
      stdio: "ignore",
    });
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "3978", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("checkAndRecoverSandboxProcesses reports messaging webhook recovery failure without claiming forwardRecovered", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const dashboardForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`;

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
      output: dashboardForward,
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        return {
          status: args[0] === "forward" && args[1] === "start" && args.includes("3978") ? 1 : 0,
        } as never;
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
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "3978", "beta"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("waits for stopped Hermes recovery after managed OpenShell control succeeds", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running`;
    const previousWaitSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const previousPollInterval = process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
    const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
    const commands: string[] = [];
    let restarted = false;
    const requestGatewaySupervisorAction = vi.fn(() => {
      restarted = true;
      return { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" };
    });

    // The gateway retry is under test; host-forward readiness is fully mocked.
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "2";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "0";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";

    try {
      vi.spyOn(childProcess, "spawnSync").mockImplementation(
        (command: unknown, rawArgs: unknown) => {
          const shellCommand = getSandboxExecShellCommand(rawArgs);
          const isHealthProbe = shellCommand.includes("HTTP_CODE=$(curl");
          const probeStatus = restarted ? "RUNNING" : "STOPPED";
          const stdout = isHealthProbe
            ? `__NEMOCLAW_SANDBOX_EXEC_STARTED__\n${probeStatus}\n`
            : "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n";
          commands.push(String(command));
          return { status: 0, stdout, stderr: "" } as never;
        },
      );
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
        name: "hermes",
        displayName: "Hermes Agent",
        binary_path: "/usr/local/bin/hermes",
        gateway_command: "hermes gateway run",
        forwardPort: 18789,
        forward_ports: [18789, 8642],
        healthProbe: { url: "http://127.0.0.1:8642/health", port: 8642, timeout_seconds: 5 },
        configPaths: {
          dir: "/sandbox/.hermes",
          configFile: "/sandbox/.hermes/config.yaml",
          envFile: "/sandbox/.hermes/.env",
          format: "yaml",
        },
      });
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "hermes-box",
        agent: "hermes",
        dashboardPort: 18789,
      });
      vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
      vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
        status: 0,
        output: runningForward,
      });
      vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

      const result = withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("hermes-box", {
          quiet: true,
          requestGatewaySupervisorAction,
        }),
      );
      expect(result.recovered).toBe(true);
      expect(result.wasRunning).toBe(false);
      expect(commands).not.toContain("ssh");
      expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
      expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
    } finally {
      previousWaitSeconds === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = previousWaitSeconds);
      previousPollInterval === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = previousPollInterval);
      previousSettleSeconds === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = previousSettleSeconds);
    }
  });

  it.each([
    ["a recovery marker from a failed action", "GATEWAY_PID=4242\n", "dashboard recovery failed"],
    ["an unavailable managed supervisor", "", "SUPERVISOR_UNAVAILABLE"],
    [
      "a staged unavailable managed supervisor",
      "",
      "SUPERVISOR_UNAVAILABLE\nNEMOCLAW_CONTROL_STAGE=await-replacement",
    ],
    ["a non-exact self-recovery marker", "", "prefix SUPERVISOR_UNAVAILABLE suffix"],
    ["an extra self-recovery error", "", "SUPERVISOR_UNAVAILABLE\nGATEWAY_FAILED"],
    ["a self-recovery marker on stdout", "SUPERVISOR_UNAVAILABLE", ""],
  ])("does not accept %s for Hermes", (_label, stdout, stderr) => {
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout,
      stderr,
    }));

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
            stderr: "",
          } as never;
        }
        return { status: 1, stdout: "", stderr: "unexpected command" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      displayName: "Hermes Agent",
      binary_path: "/usr/local/bin/hermes",
      gateway_command: "hermes gateway run",
      forwardPort: 8642,
      healthProbe: {
        url: "http://127.0.0.1:8642/health",
        port: 8642,
        timeout_seconds: 90,
      },
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });

    expect(
      withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("hermes-box", {
          quiet: true,
          requestGatewaySupervisorAction,
        }),
      ),
    ).toEqual({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
  });

  it("leaves enabled Hermes dashboard recovery to the PID 1 supervisor", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const previousWaitSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const previousPollInterval = process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
    const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
    const sshCommands: string[] = [];
    let restarted = false;
    const requestGatewaySupervisorAction = vi.fn(() => {
      restarted = true;
      return { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" };
    });

    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "0";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "0";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";

    try {
      vi.spyOn(openshellRuntime, "captureSandboxSshConfig").mockReturnValue({
        status: 0,
        output: "Host openshell-hermes-box\n  HostName 127.0.0.1\n",
      } as never);
      vi.spyOn(childProcess, "spawnSync").mockImplementation(
        (command: unknown, rawArgs: unknown) => {
          if (command === "ssh") {
            sshCommands.push(getSandboxExecShellCommand(rawArgs));
            return { status: 0, stdout: "DASHBOARD_PID=5252\n", stderr: "" } as never;
          }
          const shellCommand = getSandboxExecShellCommand(rawArgs);
          if (shellCommand.includes("HTTP_CODE=$(curl")) {
            return {
              status: 0,
              stdout: `__NEMOCLAW_SANDBOX_EXEC_STARTED__\n${restarted ? "RUNNING" : "STOPPED"}\n`,
              stderr: "",
            } as never;
          }
          return { status: 1, stdout: "", stderr: "unexpected command" } as never;
        },
      );
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
        name: "hermes",
        displayName: "Hermes Agent",
        binary_path: "/usr/local/bin/hermes",
        gateway_command: "hermes gateway run",
        forwardPort: 18789,
        healthProbe: {
          url: "http://127.0.0.1:8642/health",
          port: 8642,
          timeout_seconds: 90,
        },
      });
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "hermes-box",
        agent: "hermes",
        dashboardPort: 18789,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 9119,
        hermesDashboardInternalPort: 19119,
      });
      vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
      vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
        status: 0,
        output:
          "SANDBOX  BIND  PORT  PID  STATUS\n" +
          "hermes-box  127.0.0.1  18789  12345  running\n" +
          "hermes-box  127.0.0.1  9119  12346  running",
      });
      vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

      expect(
        withFakeOpenshellBinary(() =>
          checkAndRecoverSandboxProcesses("hermes-box", {
            quiet: true,
            requestGatewaySupervisorAction,
          }),
        ),
      ).toEqual({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      });
      expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
      expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
      expect(sshCommands).toHaveLength(0);
    } finally {
      previousWaitSeconds === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = previousWaitSeconds);
      previousPollInterval === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = previousPollInterval);
      previousSettleSeconds === undefined
        ? delete process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS
        : (process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = previousSettleSeconds);
    }
  });

  it("keeps quiet stopped-Hermes recovery failures off stderr", () => {
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      agent: "hermes",
      dashboardPort: 18789,
      name: "hermes-box",
    });

    withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("hermes-box", { quiet: true }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("re-establishes manifest-declared non-primary forward ports when only the primary is healthy", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const onlyPrimaryForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running`;
    const bothForwards = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running
hermes-box  127.0.0.1  8642  12346  running`;
    let secondaryStarted = false;
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 8642],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation((port: unknown) => {
      if (Number(port) === 18789) return true;
      if (Number(port) === 8642) return secondaryStarted;
      return false;
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: secondaryStarted ? bothForwards : onlyPrimaryForward,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        if (args[0] === "forward" && args[1] === "start" && args.includes("8642")) {
          secondaryStarted = true;
        }
        return { status: 0 } as never;
      });

    expect(
      withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("hermes-box", {
          quiet: true,
          requestGatewaySupervisorAction,
        }),
      ),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");

    const startedNonPrimary = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return (
        args[0] === "forward" &&
        args[1] === "start" &&
        args.includes("--background") &&
        args.includes("8642") &&
        args.includes("hermes-box")
      );
    });
    expect(startedNonPrimary).toBe(true);

    const startedPrimary = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return (
        args[0] === "forward" &&
        args[1] === "start" &&
        args.includes("--background") &&
        args.includes("18789") &&
        args.includes("hermes-box")
      );
    });
    expect(startedPrimary).toBe(false);
  });

  it("leaves a non-primary forward owned by another sandbox alone instead of taking it over", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const occupiedForwardList = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running
sibling-box  127.0.0.1  8642  99999  running`;
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 8642],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(
      (port: unknown) => Number(port) === 18789,
    );
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: occupiedForwardList,
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result.checked).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.forwardRecovered).toBe(false);
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();

    const touchedSecondary = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return args[0] === "forward" && args.includes("8642");
    });
    expect(touchedSecondary).toBe(false);
  });

  it("ignores invalid forward_ports entries and never invokes openshell forward start for them", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const primaryOnlyForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running`;
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 0, -1, 1.5, 1023, 70000, "8642" as unknown as number],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: primaryOnlyForward,
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );

    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    const issuedForwardStart = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return args[0] === "forward" && args[1] === "start";
    });
    expect(issuedForwardStart).toBe(false);
  });

  it("reports forward recovery failure when one declared secondary recovers and another fails", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const partialForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running
hermes-box  127.0.0.1  8642  12346  running`;
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));

    // Forward visibility is fixed by mocks, so the production settle window is unnecessary.
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 8642, 9100],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    let port9100Started = false;
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation((port: unknown) => {
      if (Number(port) === 18789) return true;
      if (Number(port) === 8642) return true;
      if (Number(port) === 9100) return port9100Started;
      return false;
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: partialForward,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      if (args[0] === "forward" && args[1] === "start" && args.includes("9100")) {
        return { status: 0 } as never;
      }
      return { status: 0 } as never;
    });

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    void port9100Started;
    expect(result.checked).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.forwardRecovered).toBe(false);
    expect(result.forwardRecoveryFailed).toBe(true);
    expect(result.forwardRecoveryFailureDetail).toContain("agent-declared host forwards");
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
  });

  it("refuses recovery of a running Hermes gateway when /sandbox/.hermes/.env contains raw secret-shaped values", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let forwardListCalls = 0;
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "SECRET_BOUNDARY_REFUSED\n",
      stderr:
        "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env contains raw secret-shaped values\n[SECURITY] TELEGRAM_BOT_TOKEN (line 3)",
    }));

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "stdout: __NEMOCLAW_SANDBOX_EXEC_STARTED__\nstdout: RUNNING\n",
            stderr: "",
          } as never;
        }
        return { status: 0, stdout: "", stderr: "" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 8642,
      displayName: "Hermes Agent",
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockImplementation(() => {
        forwardListCalls += 1;
        return {
          status: 0,
          output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  18789  12345  running`,
        };
      });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      secretBoundaryRefused: true,
      secretBoundaryReason: "raw-secret",
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
    expect(forwardListCalls).toBe(0);
    expect(captureOpenshell).not.toHaveBeenCalled();
    expect(
      runOpenshell.mock.calls.some(([rawArgs]) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        return args[0] === "forward";
      }),
    ).toBe(false);
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "[SECURITY] Refusing Hermes startup because /sandbox/.hermes/.env contains raw secret-shaped values",
    );
    expect(errorOutput).toContain("[SECURITY] TELEGRAM_BOT_TOKEN (line 3)");
  });

  it("fails safe on a running Hermes sandbox when the agent definition cannot be loaded", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let forwardListCalls = 0;
    const requestGatewaySupervisorAction = vi.fn();

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
            stderr: "",
          } as never;
        }
        return { status: 0, stdout: "", stderr: "" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockImplementation(() => {
        forwardListCalls += 1;
        return {
          status: 0,
          output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  18789  12345  running`,
        };
      });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      secretBoundaryRefused: true,
      secretBoundaryReason: "agent-missing",
    });
    expect(requestGatewaySupervisorAction).not.toHaveBeenCalled();
    expect(forwardListCalls).toBe(0);
    expect(captureOpenshell).not.toHaveBeenCalled();
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Hermes agent definition could not be loaded for sandbox 'hermes-box'",
    );
  });

  it.each([
    ["PID 1 supervisor", { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" }],
    ["OpenShell managed controller", { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" }],
  ])("falls through when the Hermes $label reports a healthy gateway", (_label, supervisorResult) => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const requestGatewaySupervisorAction = vi.fn(() => supervisorResult);

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "stdout: __NEMOCLAW_SANDBOX_EXEC_STARTED__\nstdout: RUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 8642,
      displayName: "Hermes Agent",
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  8642  12346  running\nhermes-box  127.0.0.1  18789  12345  running`,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);
    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
  });

  it("falls through to the forward-refresh path when the Hermes secret-boundary check passes", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    let forwardStarted = false;
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 0,
      stdout: "GATEWAY_PID=4242\n",
      stderr: "",
    }));

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
            stderr: "",
          } as never;
        }
        return { status: 0, stdout: "", stderr: "" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      displayName: "Hermes Agent",
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(() => forwardStarted);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  18789  12345  ${forwardStarted ? "running" : "dead"}`,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        if (args[0] === "forward" && args[1] === "start" && args.includes("18789")) {
          forwardStarted = true;
        }
        return { status: 0 } as never;
      });

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "18789", "hermes-box"],
      { ignoreError: true, stdio: "ignore" },
    );
  });

  it("refuses recovery when the Hermes secret-boundary validator is absent on an older sandbox image", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "SECRET_BOUNDARY_VALIDATOR_MISSING\n",
      stderr: "[gateway-recovery] ERROR: secret-boundary validator script missing",
    }));

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
            stderr: "",
          } as never;
        }
        return { status: 0, stdout: "", stderr: "" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 8642,
      displayName: "Hermes Agent",
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  18789  12345  running`,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      secretBoundaryRefused: true,
      secretBoundaryReason: "validator-missing",
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("[gateway-recovery] ERROR");
    expect(errorOutput).toContain(
      "Hermes secret-boundary validator missing in sandbox 'hermes-box'",
    );
    expect(errorOutput).toContain("Re-image the sandbox with a current Hermes build.");
  });

  it("does not invoke the Hermes PID 1 supervisor path for a running OpenClaw sandbox", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const requestGatewaySupervisorAction = vi.fn();

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
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS\nbeta  127.0.0.1  18789  12345  running`,
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("beta", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(requestGatewaySupervisorAction).not.toHaveBeenCalled();
    expect(
      runOpenshell.mock.calls.some(
        ([rawArgs]) => Array.isArray(rawArgs) && rawArgs[0] === "forward" && rawArgs[1] === "start",
      ),
    ).toBe(false);
  });

  it("fails safe on a running Hermes gateway when the supervisor channel is unreachable", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let forwardListCalls = 0;
    const requestGatewaySupervisorAction = vi.fn(() => null);

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
            stderr: "",
          } as never;
        }
        return { status: 0, stdout: "", stderr: "" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 8642,
      displayName: "Hermes Agent",
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockImplementation(() => {
        forwardListCalls += 1;
        return {
          status: 0,
          output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  18789  12345  running`,
        };
      });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      secretBoundaryRefused: true,
      secretBoundaryReason: "exec-failed",
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
    expect(forwardListCalls).toBe(0);
    expect(captureOpenshell).not.toHaveBeenCalled();
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Secret-boundary check could not run against the Hermes gateway in 'hermes-box'",
    );
  });

  it("treats a non-zero boundary check without the REFUSED marker as unexpected, not raw-secret", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 2,
      stdout: "",
      stderr: "python3: validator crashed: ImportError: no module named foo",
    }));

    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        if (shellCommand.includes("HTTP_CODE=$(curl")) {
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
            stderr: "",
          } as never;
        }
        return { status: 0, stdout: "", stderr: "" } as never;
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 8642,
      displayName: "Hermes Agent",
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS\nhermes-box  127.0.0.1  18789  12345  running`,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );
    expect(result).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      secretBoundaryRefused: true,
      secretBoundaryReason: "unexpected-marker",
    });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledOnce();
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("hermes-box", "recover");
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("python3: validator crashed: ImportError: no module named foo");
    expect(errorOutput).toContain(
      "Secret-boundary check did not complete cleanly for Hermes gateway in 'hermes-box'",
    );
  });
});
