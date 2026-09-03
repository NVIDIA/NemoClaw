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
  "../../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/process-recovery.js");
const { ensureSandboxPortForwardForPort } = requireSource(
  "../../src/lib/actions/sandbox/forward-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/forward-recovery.js");
const { createProbeTimingRecorder } = requireSource(
  "../../src/lib/actions/sandbox/probe/timing.ts",
) as typeof import("../../src/lib/actions/sandbox/probe/timing.js");

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
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
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

  it("waits for stopped Hermes recovery after managed OpenShell control succeeds", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
    const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.js");
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
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
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
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
    const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.js");
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
        output: "SANDBOX  BIND  PORT  PID  STATUS",
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
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
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

  it("refuses recovery of a running Hermes gateway when /sandbox/.hermes/.env contains raw secret-shaped values", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
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
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
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
  ])(
    "falls through when the Hermes $label reports a healthy gateway",
    (_label, supervisorResult) => {
      const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
      const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
      const registry = requireSource("../../src/lib/state/registry.js");
      const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.js");
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
        output: "SANDBOX  BIND  PORT  PID  STATUS",
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
    },
  );

  it("refuses recovery when the Hermes secret-boundary validator is absent on an older sandbox image", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
    const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.js");
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
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
    const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.js");
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
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
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
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
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
    expect(errorOutput).toMatch(/Secret-boundary check did not complete cleanly.*hermes-box/);
  });
});
