// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses } = requireSource(
  "../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/process-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
});

function getSandboxExecShellCommand(rawArgs: unknown): string {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  return String(args.at(-1) ?? "");
}

function restoreEnvValue(name: string, previous: string | undefined): void {
  previous === undefined ? delete process.env[name] : (process.env[name] = previous);
}

type SpawnMockResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function openshellExecResult(rawArgs: unknown, recovered: boolean): SpawnMockResult {
  const shellCommand = getSandboxExecShellCommand(rawArgs);
  const status = shellCommand.includes("HTTP_CODE=$(curl")
    ? recovered
      ? "RUNNING"
      : "STOPPED"
    : "";
  return {
    status: 0,
    stdout: `__NEMOCLAW_SANDBOX_EXEC_STARTED__\n${status}\n`,
    stderr: "",
  };
}

function sshExecResult(
  rawArgs: unknown,
  sshCommands: string[],
  currentRecovered: boolean,
  setRecovered: (value: boolean) => void,
): SpawnMockResult {
  const sshCommand = getSandboxExecShellCommand(rawArgs);
  const isHealthProbe = sshCommand.includes("HTTP_CODE=$(curl");
  const launchRecovered = sshCommand.includes('"$AGENT_BIN" gateway run --port 19000');
  const nextRecovered = isHealthProbe ? currentRecovered : launchRecovered;
  sshCommands.push(sshCommand);
  setRecovered(nextRecovered);
  return {
    status: 0,
    stdout: isHealthProbe
      ? currentRecovered
        ? "RUNNING"
        : "STOPPED"
      : launchRecovered
        ? "GATEWAY_PID=5150"
        : "",
    stderr: "",
  };
}

function spawnResultForCommand(
  command: unknown,
  rawArgs: unknown,
  sshCommands: string[],
  recovered: boolean,
  setRecovered: (value: boolean) => void,
): SpawnMockResult {
  return String(command).endsWith("openshell")
    ? openshellExecResult(rawArgs, recovered)
    : command === "ssh"
      ? sshExecResult(rawArgs, sshCommands, recovered, setRecovered)
      : { status: 1, stdout: "", stderr: "" };
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
    restoreEnvValue("NEMOCLAW_OPENSHELL_BIN", previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkAndRecoverSandboxProcesses custom agent recovery", () => {
  it("retains SSH health-probe compatibility for an explicitly loaded custom gateway agent", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.ts");
    const childProcess = requireSource("node:child_process");
    const sshCommands: string[] = [];

    vi.spyOn(openshellRuntime, "captureSandboxSshConfig").mockReturnValue({
      status: 0,
      output: "Host openshell-custom-box\n  HostName 127.0.0.1\n",
    } as never);
    vi.spyOn(childProcess, "spawnSync").mockImplementation((command: unknown, rawArgs: unknown) => {
      const sshCommand = getSandboxExecShellCommand(rawArgs);
      sshCommands.push(...(command === "ssh" ? [sshCommand] : []));
      return (
        String(command).endsWith("openshell")
          ? { status: 1, stdout: "", stderr: "sandbox exec unavailable" }
          : command === "ssh"
            ? { status: 0, stdout: "RUNNING\n", stderr: "" }
            : { status: 1, stdout: "", stderr: "" }
      ) as never;
    });
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "custom-agent",
      displayName: "Custom Agent",
      binary_path: "/usr/local/bin/custom-agent",
      gateway_command: "custom-agent gateway run",
      forwardPort: 19000,
      healthProbe: { url: "http://127.0.0.1:19000/health", port: 19000 },
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "custom-box",
      agent: "custom-agent",
      dashboardPort: 19000,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS
custom-box  127.0.0.1  19000  12345  running`,
    });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("custom-box", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
    });
    expect(sshCommands).toHaveLength(1);
    expect(sshCommands[0]).toContain("HTTP_CODE=$(curl");
    expect(sshCommands[0]).not.toContain("gateway run");
  });

  it("recovers a stopped custom gateway agent over SSH fallback", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.ts");
    const childProcess = requireSource("node:child_process");
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
custom-box  127.0.0.1  19000  12345  running`;
    const sshCommands: string[] = [];
    const previousWaitSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const previousPollInterval = process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
    const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
    let recovered = false;
    let healthProbeCalls = 0;

    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "2";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "0";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";

    try {
      vi.spyOn(openshellRuntime, "captureSandboxSshConfig").mockReturnValue({
        status: 0,
        output: "Host openshell-custom-box\n  HostName 127.0.0.1\n",
      } as never);
      vi.spyOn(childProcess, "spawnSync").mockImplementation(
        (command: unknown, rawArgs: unknown) => {
          healthProbeCalls += Number(
            String(command).endsWith("openshell") &&
              getSandboxExecShellCommand(rawArgs).includes("HTTP_CODE=$(curl"),
          );
          const setRecovered = (value: boolean): void => {
            recovered = value;
          };
          return spawnResultForCommand(
            command,
            rawArgs,
            sshCommands,
            recovered,
            setRecovered,
          ) as never;
        },
      );
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
        name: "custom-agent",
        displayName: "Custom Agent",
        binary_path: "/usr/local/bin/custom-agent",
        gateway_command: "custom-agent gateway run",
        forwardPort: 19000,
        healthProbe: { url: "http://127.0.0.1:19000/health", port: 19000 },
      });
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "custom-box",
        agent: "custom-agent",
        dashboardPort: 19000,
      });
      vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
      vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
        status: 0,
        output: runningForward,
      });
      vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

      expect(
        withFakeOpenshellBinary(() =>
          checkAndRecoverSandboxProcesses("custom-box", { quiet: true }),
        ),
      ).toEqual({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      });
      expect(sshCommands.some((command) => command.includes('"$AGENT_BIN" gateway run'))).toBe(
        true,
      );
      expect(healthProbeCalls).toBe(2);
      expect(recovered).toBe(true);
    } finally {
      restoreEnvValue("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", previousWaitSeconds);
      restoreEnvValue("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", previousPollInterval);
      restoreEnvValue("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", previousSettleSeconds);
    }
  });

  it("fails closed when a persisted non-OpenClaw manifest cannot be loaded", () => {
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const childProcess = requireSource("node:child_process");
    const commands: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.spyOn(childProcess, "spawnSync").mockImplementation((command: unknown, rawArgs: unknown) => {
      commands.push(`${String(command)} ${getSandboxExecShellCommand(rawArgs)}`);
      return {
        status: 0,
        stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
        stderr: "",
      } as never;
    });
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "custom-box",
      agent: "missing-custom-agent",
      dashboardPort: 19000,
    });

    expect(
      withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("custom-box", { quiet: false }),
      ),
    ).toEqual({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });

    expect(commands.join("\n")).not.toContain("openclaw gateway run");
    expect(commands.some((command) => command.startsWith("ssh "))).toBe(false);
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("unsupported agent");
    expect(errorOutput).toContain("missing-custom-agent agent definition could not be loaded");
    expect(errorOutput).toContain("nemoclaw 'custom-box' recover");
    expect(errorOutput).not.toContain("nemoclaw 'custom-box' gateway restart");
    expect(errorOutput).toContain("nemoclaw 'custom-box' rebuild --yes");
    expect(errorOutput).not.toContain("nohup");
    const logOutput = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logOutput).toContain("missing-custom-agent gateway is not running");
    expect(logOutput).not.toContain("OpenClaw gateway");
  });
});
