// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
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
    previous === undefined
      ? delete process.env.NEMOCLAW_OPENSHELL_BIN
      : (process.env.NEMOCLAW_OPENSHELL_BIN = previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkAndRecoverSandboxProcesses supervisor relaunch", () => {
  it("directs a supervisor-gone recovery to rebuild when relaunch cannot start", () => {
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_UNAVAILABLE",
    }));

    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH", "1");
    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        return shellCommand.includes("HTTP_CODE=$(curl")
          ? ({
              status: 0,
              stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
              stderr: "",
            } as never)
          : ({ status: 1, stdout: "", stderr: "unexpected command" } as never);
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      forwardPort: 18789,
      healthProbe: {
        url: "http://127.0.0.1:18789/health",
        port: 18789,
        timeout_seconds: 30,
      },
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "clone-test",
      agent: "openclaw",
      dashboardPort: 18789,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("clone-test", {
        quiet: false,
        requestGatewaySupervisorAction,
      }),
    );

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
    const errorLines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(errorLines).toContainEqual(
      expect.stringContaining("Failure layer: supervisor not running"),
    );
    expect(errorLines).toContainEqual(
      expect.stringContaining("The in-sandbox supervisor is not running"),
    );
    expect(errorLines).toContainEqual(expect.stringContaining("rebuild --yes"));
    expect(errorLines).not.toContainEqual(
      expect.stringContaining("Retry the managed restart from the host"),
    );
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("clone-test", "recover");
  });

  it("relaunches the gone supervisor as the sandbox user with a secret-free env", () => {
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const requestGatewaySupervisorAction = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "SUPERVISOR_UNAVAILABLE",
    }));

    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS", "CUSTOM_PROVIDER_CREDENTIAL");
    vi.stubEnv("CUSTOM_PROVIDER_CREDENTIAL", "s3cr3t-token");
    vi.stubEnv("HTTPS_PROXY", "http://proxyuser:proxypass@proxy.example:8080");

    const spawnSyncSpy = vi
      .spyOn(childProcess, "spawnSync")
      .mockImplementation((_command: unknown, rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const lastArg = args.at(-1) ?? "";
        const isRelaunch = lastArg.includes("nemoclaw-start") && lastArg.includes("setsid");
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        return isRelaunch
          ? ({ status: 0, stdout: "NEMOCLAW_SUPERVISOR_RELAUNCHED\n", stderr: "" } as never)
          : shellCommand.includes("HTTP_CODE=$(curl")
            ? ({
                status: 0,
                stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
                stderr: "",
              } as never)
            : ({ status: 1, stdout: "", stderr: "unexpected command" } as never);
      });
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      forwardPort: 18789,
      healthProbe: { url: "http://127.0.0.1:18789/health", port: 18789, timeout_seconds: 30 },
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "restarted-box",
      agent: "openclaw",
      dashboardPort: 18789,
    });

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("restarted-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });

    const relaunchCall = spawnSyncSpy.mock.calls.find((call) => {
      const args = Array.isArray(call[1]) ? (call[1] as string[]) : [];
      return args.some((arg) => arg.includes("nemoclaw-start") && arg.includes("setsid"));
    });
    expect(relaunchCall).toBeDefined();
    const argv = (relaunchCall?.[1] as string[]) ?? [];
    expect(argv.slice(0, 5)).toEqual(["sandbox", "exec", "--name", "restarted-box", "--"]);
    const daemonCommand = argv.at(-1) ?? "";
    expect(daemonCommand).toContain("setsid nohup env ");
    expect(daemonCommand).toContain("NEMOCLAW_DASHBOARD_PORT=18789");
    expect(daemonCommand).toContain("nemoclaw-start");
    expect(daemonCommand).not.toContain("s3cr3t-token");
    expect(daemonCommand).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
    expect(daemonCommand).not.toContain("proxypass");
  });

  it("reaches a healthy recovery once the relaunched supervisor answers managed probes", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.js");
    const childProcess = requireSource("node:child_process");
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
recovered-box  127.0.0.1  18789  12345  running`;
    const requestGatewaySupervisorAction = vi.fn((_name: string, action: string) =>
      action === "recover"
        ? { status: 1, stdout: "", stderr: "SUPERVISOR_UNAVAILABLE" }
        : { status: 0, stdout: "GATEWAY_PID=4242\n", stderr: "" },
    );

    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "2");
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
    vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
    vi.spyOn(childProcess, "spawnSync").mockImplementation(
      (_command: unknown, rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const lastArg = args.at(-1) ?? "";
        const isRelaunch = lastArg.includes("nemoclaw-start") && lastArg.includes("setsid");
        const shellCommand = getSandboxExecShellCommand(rawArgs);
        return isRelaunch
          ? ({ status: 0, stdout: "NEMOCLAW_SUPERVISOR_RELAUNCHED\n", stderr: "" } as never)
          : shellCommand.includes("HTTP_CODE=$(curl")
            ? ({
                status: 0,
                stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
                stderr: "",
              } as never)
            : ({ status: 1, stdout: "", stderr: "unexpected command" } as never);
      },
    );
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "openclaw",
      displayName: "OpenClaw",
      forwardPort: 18789,
      healthProbe: { url: "http://127.0.0.1:18789/health", port: 18789, timeout_seconds: 30 },
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "recovered-box",
      agent: "openclaw",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: runningForward,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("recovered-box", {
        quiet: true,
        requestGatewaySupervisorAction,
      }),
    );

    expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: true });
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("recovered-box", "recover");
    expect(requestGatewaySupervisorAction).toHaveBeenCalledWith("recovered-box", "probe");
  });
});
