// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellForwardAdapter } from "../../src/lib/adapters/openshell/forward";

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses: checkAndRecoverSandboxProcessesImpl } = requireSource(
  "../../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/process-recovery.js");

const forwardRuntime = requireSource(
  "../../src/lib/adapters/openshell/forward-runtime.ts",
) as typeof import("../../src/lib/adapters/openshell/forward-runtime.js");
const gatewayTeardownAuthority = requireSource(
  "../../src/lib/onboard/gateway-teardown-authority.ts",
) as typeof import("../../src/lib/onboard/gateway-teardown-authority.js");

const startForward = vi.fn();

function mockForwardObservation(state: "owned" | "foreign" | "indeterminate" = "owned"): void {
  startForward.mockReset();
  vi.spyOn(forwardRuntime, "createOpenShellForwardAdapterForAuthority").mockReturnValue({
    observeForwards: vi.fn<OpenShellForwardAdapter["observeForwards"]>(async ({ forwards }) => {
      const observedState = state === "owned" ? "owned" : "foreign";
      return forwards.map((forward) =>
        state === "indeterminate"
          ? {
              state,
              forward,
              error: {
                kind: "ownership" as const,
                message: "NemoClaw could not prove OpenShell forward ownership." as const,
              },
            }
          : { state: observedState, forward },
      );
    }),
    startForward,
    retireLegacyForward: vi.fn(),
    verifyForwardRelease: vi.fn(async () => ({ state: "released" })),
  } as never);
}

beforeEach(() => {
  mockForwardObservation();
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayForwardAuthority").mockImplementation(
    ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  );
});

function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: Parameters<typeof checkAndRecoverSandboxProcessesImpl>[1] = {},
) {
  return checkAndRecoverSandboxProcessesImpl(sandboxName, {
    isWsl: false,
    withLifecycleLock: async (_name, operation) => await operation(),
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withFakeOpenshellBinary<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
  const bin = path.join(dir, "openshell");
  const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.NEMOCLAW_OPENSHELL_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("recover with a dashboard port held by a listener the sandbox does not own (#11149)", () => {
  it.each([
    ["returns false", (): boolean => false],
    [
      "throws",
      (): boolean => {
        throw new Error("ownership proof unavailable");
      },
    ],
  ] as const)(
    "reports the occupied port and never relaunches when ownership proof %s",
    async (_case, proveOwner) => {
      const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.js");
      const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
      const registry = requireSource("../../src/lib/state/registry.js");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "beta",
        agent: "openclaw",
        dashboardPort: 18789,
      });
      let observationState: "foreign" | "indeterminate" = "foreign";
      try {
        proveOwner();
      } catch {
        observationState = "indeterminate";
      }
      mockForwardObservation(observationState);
      const forwardList = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
        status: 0,
        output: "SANDBOX  BIND  PORT  PID  STATUS\n",
      });
      const runOpenshell = vi
        .spyOn(openshellRuntime, "runOpenshell")
        .mockReturnValue({ status: 0 } as never);

      const result = await withFakeOpenshellBinary(() =>
        checkAndRecoverSandboxProcesses("beta", {
          quiet: false,
          isSandboxGatewayRunningImpl: async () => true,
        }),
      );

      expect(result).toMatchObject({
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: expect.stringContaining(
          "host port 18789 is held by a listener that NemoClaw cannot attribute",
        ),
      });
      expect(startForward).not.toHaveBeenCalled();
      // Direct process identity decides; the legacy forward registry is not ownership evidence.
      expect(
        forwardList.mock.calls.filter(
          ([rawArgs]) =>
            Array.isArray(rawArgs) && rawArgs[0] === "forward" && rawArgs[1] === "list",
        ),
      ).toHaveLength(0);
      expect(
        runOpenshell.mock.calls.some(
          ([rawArgs]) => Array.isArray(rawArgs) && rawArgs[0] === "forward",
        ),
      ).toBe(false);
      const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(output).not.toContain("missing or dead");
      expect(output).toContain("held by a listener whose ownership NemoClaw cannot prove");
      const errors = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(errors).toContain("Host port 18789 for 'beta' is held by a listener");
    },
  );
});

describe("native gateway inspection failure", () => {
  const transport = requireSource(
    "../../src/lib/adapters/sandbox/command-transport.ts",
  ) as typeof import("../../src/lib/adapters/sandbox/command-transport.js");
  function arrangeFailure(error: Error) {
    const agentRuntime = requireSource("../../src/lib/agent/runtime.js");
    const registry = requireSource("../../src/lib/state/registry.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha", agent: "openclaw" });
    return vi.spyOn(transport, "executeSandboxExecCommand").mockRejectedValue(error);
  }

  it.each(["cancelled", "timeout", "capture", "invocation", "unavailable", "malformed"] as const)(
    "returns inconclusive recovery without mutation after %s",
    async (kind) => {
      const execute = arrangeFailure(new transport.SandboxCommandTransportError(kind));
      const privileged = requireSource("../../src/lib/sandbox/privileged-exec.ts");
      const executePrivileged = vi.spyOn(privileged, "executePrivilegedSandboxCommand");
      const commandCli = requireSource("../../src/lib/adapters/openshell/sandbox-command-cli.ts");
      const runCommand = vi.spyOn(commandCli, "runCliOpenShellBufferedCommand");
      await expect(checkAndRecoverSandboxProcesses("alpha", { quiet: true })).resolves.toEqual({
        checked: false,
        wasRunning: null,
        recovered: false,
        forwardRecovered: false,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(startForward).not.toHaveBeenCalled();
      expect(executePrivileged).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it("propagates unexpected gateway authority errors", async () => {
    const error = new Error("gateway authority refused");
    const execute = arrangeFailure(error);
    await expect(checkAndRecoverSandboxProcesses("alpha", { quiet: true })).rejects.toBe(error);
    expect(execute).toHaveBeenCalledOnce();
    expect(startForward).not.toHaveBeenCalled();
  });
});
