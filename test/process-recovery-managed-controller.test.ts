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
});

function getSandboxExecShellCommand(rawArgs: unknown): string {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  const payload = String(args.at(-1) ?? "");
  const match = payload.match(/printf '%s' '([A-Za-z0-9+\/=]+)' \| base64 -d \| sh/);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : payload;
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

describe("managed gateway recovery controller", () => {
  const recoveredGateway = {
    checked: true,
    wasRunning: false,
    recovered: true,
    forwardRecovered: true,
  };
  const unrecoveredGateway = {
    checked: true,
    wasRunning: false,
    recovered: false,
    forwardRecovered: false,
  };
  const successfulControl = { status: 0, stdout: "GATEWAY_PID=123\n", stderr: "" };
  const successfulProbe = { status: 0, stdout: "ALREADY_RUNNING\n", stderr: "" };

  it.each([
    {
      label: "PID 1 supervisor",
      recoverResults: [successfulControl],
      expectedResult: recoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "OpenShell managed controller",
      recoverResults: [successfulControl],
      managedProbeResult: successfulProbe,
      expectedResult: recoveredGateway,
      expectedActions: ["recover", "probe"],
      settleSeconds: "1",
    },
    {
      label: "two transient controller races followed by authenticated recovery",
      recoverResults: [
        { status: 1, stdout: "", stderr: "SUPERVISOR_UNAVAILABLE" },
        { status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" },
        successfulControl,
      ],
      expectedResult: recoveredGateway,
      expectedActions: ["recover", "recover", "recover"],
      settleSeconds: "0",
    },
    {
      label: "persistent exact unavailable controller result",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_UNAVAILABLE" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover", "recover", "recover"],
      settleSeconds: "0",
    },
    {
      label: "busy controller marker on stdout",
      recoverResults: [{ status: 1, stdout: "SUPERVISOR_BUSY", stderr: "" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "OpenShell managed controller wedge",
      recoverResults: [successfulControl],
      managedProbeResult: { status: 1, stdout: "", stderr: "GATEWAY_HEALTH_TIMEOUT" },
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover", "probe"],
      settleSeconds: "1",
    },
    {
      label: "non-exact unavailable marker",
      recoverResults: [{ status: 1, stdout: "", stderr: "prefix SUPERVISOR_UNAVAILABLE suffix" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "unavailable marker with another error line",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_UNAVAILABLE\nGATEWAY_FAILED" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "unavailable marker with a nonstandard status",
      recoverResults: [{ status: 2, stdout: "", stderr: "SUPERVISOR_UNAVAILABLE" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "unsafe controller directory refusal",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_UNSAFE_CONTROL_DIR" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "invalid controller status refusal",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_INVALID_STATUS" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "controller rebuild requirement",
      recoverResults: [{ status: 127, stdout: "", stderr: "SUPERVISOR_REBUILD_REQUIRED" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "missing controller result",
      recoverResults: [null],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
  ])("waits for $label recovery before declaring success", ({
    recoverResults,
    expectedResult,
    expectedActions,
    managedProbeResult,
    settleSeconds,
  }) => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireSource("../src/lib/agent/runtime.js");
    const registry = requireSource("../src/lib/state/registry.js");
    const childProcess = requireSource("node:child_process");
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`;
    const previousWaitSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const previousPollInterval = process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
    const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
    let recoveryActionCalls = 0;
    const requestGatewaySupervisorAction = vi.fn(
      (_sandboxName: string, action: "restart" | "recover" | "probe") => {
        const isProbe = action === "probe";
        const result = isProbe
          ? (managedProbeResult ?? successfulProbe)
          : recoverResults[Math.min(recoveryActionCalls, recoverResults.length - 1)];
        recoveryActionCalls += Number(!isProbe);
        return result;
      },
    );
    let healthProbeCalls = 0;
    const spawnedCommands: string[] = [];

    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "2";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "0";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = settleSeconds;

    try {
      vi.spyOn(childProcess, "spawnSync").mockImplementation(
        (command: unknown, rawArgs: unknown) => {
          spawnedCommands.push(String(command));
          const isHealthProbe = getSandboxExecShellCommand(rawArgs).includes("HTTP_CODE=$(curl");
          healthProbeCalls += Number(isHealthProbe);
          return (
            isHealthProbe
              ? {
                  status: 0,
                  stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSTOPPED\n",
                  stderr: "",
                }
              : { status: 0, stdout: "", stderr: "" }
          ) as never;
        },
      );
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "beta",
        agent: "openclaw",
        dashboardPort: 18789,
      });
      vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
        status: 0,
        output: runningForward,
      });

      const result = withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("beta", {
          quiet: true,
          requestGatewaySupervisorAction,
        }),
      );
      expect(result).toEqual(expectedResult);
      expect(requestGatewaySupervisorAction.mock.calls).toEqual(
        expectedActions.map((action) => ["beta", action]),
      );
      expect(healthProbeCalls).toBe(1);
      expect(spawnedCommands).not.toContain("ssh");
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
});
