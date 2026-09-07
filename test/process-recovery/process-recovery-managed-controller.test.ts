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

function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: Parameters<typeof checkAndRecoverSandboxProcessesImpl>[1] = {},
) {
  return checkAndRecoverSandboxProcessesImpl(sandboxName, { isWsl: false, ...options });
}

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
  const timedOutGateway = {
    ...unrecoveredGateway,
    recoveryFailureDetail:
      "the recovered gateway did not become responsive before the recovery timeout",
  };
  const controllerNonce = "a".repeat(64);
  const restartingContainerId = "b".repeat(64);
  const successfulControl = { status: 0, stdout: "GATEWAY_PID=123\n", stderr: "" };
  const successfulProbe = { status: 0, stdout: "ALREADY_RUNNING\n", stderr: "" };
  const restartingContainer = {
    status: 1,
    stdout: "",
    stderr: `Error response from daemon: Container ${restartingContainerId} is restarting, wait until the container is running`,
    managedControlRestartingContainerId: restartingContainerId,
  } as const;

  it.each([
    {
      label: "PID 1 supervisor",
      recoverResults: [successfulControl],
      expectedResult: recoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "exact controller restart",
      recoverResults: [
        {
          status: 0,
          stdout: `v1 ${controllerNonce} complete ok 0 123\nGATEWAY_PID=123`,
          stderr: "",
        },
      ],
      expectedResult: {
        ...recoveredGateway,
        managedControlCompletion: { disposition: "ok", oldPid: 0, newPid: 123 },
      },
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "PID 1 auto-respawn before controller recovery",
      recoverResults: [
        {
          status: 0,
          stdout: `v1 ${controllerNonce} complete already-running 123 456\nGATEWAY_PID=456`,
          stderr: "",
        },
      ],
      expectedResult: {
        ...recoveredGateway,
        managedControlCompletion: {
          disposition: "already-running",
          oldPid: 123,
          newPid: 456,
        },
      },
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "malformed structured controller completion",
      recoverResults: [
        {
          status: 0,
          stdout: `v1 ${controllerNonce} complete already-running 123 123\nGATEWAY_PID=456`,
          stderr: "",
        },
      ],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "structured recovery after numeric PID reuse",
      recoverResults: [
        {
          status: 0,
          stdout: `v1 ${controllerNonce} complete ok 123 123\nGATEWAY_PID=123`,
          stderr: "",
        },
      ],
      expectedResult: {
        ...recoveredGateway,
        managedControlCompletion: { disposition: "ok", oldPid: 123, newPid: 123 },
      },
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "OpenShell managed controller",
      recoverResults: [successfulControl],
      managedProbeResult: successfulProbe,
      expectedResult: recoveredGateway,
      expectedActions: ["recover", "probe", "probe"],
      settleSeconds: "1",
    },
    {
      label: "transient post-settle controller contention",
      recoverResults: [successfulControl],
      managedProbeResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" }, successfulProbe],
      expectedResult: recoveredGateway,
      expectedActions: ["recover", "probe", "probe"],
      settleSeconds: "1",
    },
    {
      label: "persistent post-settle controller contention",
      recoverResults: [successfulControl],
      managedProbeResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" }],
      expectedResult: timedOutGateway,
      expectedActions: ["recover", "probe", "probe"],
      settleSeconds: "1",
    },
    {
      label: "post-settle controller contention followed by terminal failure",
      recoverResults: [successfulControl],
      managedProbeResults: [
        { status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" },
        { status: 1, stdout: "", stderr: "GATEWAY_HEALTH_TIMEOUT" },
      ],
      expectedResult: timedOutGateway,
      expectedActions: ["recover", "probe", "probe"],
      settleSeconds: "1",
    },
    {
      label: "two transient controller contentions followed by authenticated recovery",
      recoverResults: [
        { status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" },
        { status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" },
        successfulControl,
      ],
      expectedResult: recoveredGateway,
      expectedActions: ["recover", "recover", "recover"],
      settleSeconds: "0",
    },
    {
      label: "persistent controller contention",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_BUSY" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover", "recover", "recover"],
      settleSeconds: "0",
    },
    {
      label: "status 137 with no output followed by authenticated recovery",
      recoverResults: [
        { status: 137, stdout: "", stderr: "" },
        {
          status: 0,
          stdout: `v1 ${controllerNonce} complete already-running 123 456\nGATEWAY_PID=456`,
          stderr: "",
        },
      ],
      expectedResult: {
        ...recoveredGateway,
        managedControlCompletion: {
          disposition: "already-running",
          oldPid: 123,
          newPid: 456,
        },
      },
      expectedActions: ["recover", "recover"],
      settleSeconds: "0",
    },
    {
      label: "persistent status 137 with no output",
      recoverResults: [{ status: 137, stdout: "", stderr: "" }],
      expectedResult: unrecoveredGateway,
      expectedActions: Array.from({ length: 11 }, () => "recover"),
      settleSeconds: "0",
    },
    {
      label: "status 137 and Docker restart transitions followed by authenticated recovery",
      recoverResults: [
        { status: 137, stdout: "", stderr: "" },
        restartingContainer,
        {
          status: 0,
          stdout: `v1 ${controllerNonce} complete already-running 123 456\nGATEWAY_PID=456`,
          stderr: "",
        },
      ],
      expectedResult: {
        ...recoveredGateway,
        managedControlCompletion: {
          disposition: "already-running",
          oldPid: 123,
          newPid: 456,
        },
      },
      expectedActions: ["recover", "recover", "recover"],
      settleSeconds: "0",
    },
    {
      label: "persistent Docker restart response",
      recoverResults: [restartingContainer],
      expectedResult: unrecoveredGateway,
      expectedActions: Array.from({ length: 11 }, () => "recover"),
      settleSeconds: "0",
    },
    {
      label: "unbound Docker restart diagnostic",
      recoverResults: [
        {
          status: 1,
          stdout: "",
          stderr: restartingContainer.stderr,
        },
      ],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "status 137 with diagnostic output",
      recoverResults: [{ status: 137, stdout: "", stderr: "container stopped" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "exact unavailable controller result",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_UNAVAILABLE" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
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
      expectedResult: timedOutGateway,
      expectedActions: ["recover", "probe"],
      settleSeconds: "1",
    },
    {
      label: "non-exact busy marker",
      recoverResults: [{ status: 1, stdout: "", stderr: "prefix SUPERVISOR_BUSY suffix" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "busy marker with another error line",
      recoverResults: [{ status: 1, stdout: "", stderr: "SUPERVISOR_BUSY\nGATEWAY_FAILED" }],
      expectedResult: unrecoveredGateway,
      expectedActions: ["recover"],
      settleSeconds: "0",
    },
    {
      label: "busy marker with a nonstandard status",
      recoverResults: [{ status: 2, stdout: "", stderr: "SUPERVISOR_BUSY" }],
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
  ])(
    "enforces managed recovery for $label",
    ({
      label,
      recoverResults,
      expectedResult,
      expectedActions,
      managedProbeResult,
      managedProbeResults,
      settleSeconds,
    }) => {
      const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
      const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
      const forwardHealth = requireSource("../../src/lib/actions/sandbox/forward-health.ts");
      const registry = requireSource("../../src/lib/state/registry.js");
      const childProcess = requireSource("node:child_process");
      const runningForward = "SANDBOX  BIND  PORT  PID  STATUS";
      const previousWaitSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
      const previousPollInterval = process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
      const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
      let recoveryActionCalls = 0;
      let managedProbeCalls = 0;
      const requestGatewaySupervisorAction = vi.fn(
        (_sandboxName: string, action: "restart" | "recover" | "probe") => {
          const isProbe = action === "probe";
          const probeResults = managedProbeResults ?? [managedProbeResult ?? successfulProbe];
          const result = isProbe
            ? probeResults[Math.min(managedProbeCalls, probeResults.length - 1)]
            : recoverResults[Math.min(recoveryActionCalls, recoverResults.length - 1)];
          recoveryActionCalls += Number(!isProbe);
          managedProbeCalls += Number(isProbe);
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
        vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
        vi.spyOn(registry, "getSandbox").mockReturnValue({
          name: "beta",
          agent: "openclaw",
          dashboardPort: 18789,
          ...(label === "PID 1 supervisor" ? { openshellDriver: "podman" } : {}),
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
    },
  );
});
