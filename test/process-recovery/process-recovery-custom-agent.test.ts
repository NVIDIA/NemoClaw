// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenShellForwardAdapter } from "../../src/lib/adapters/openshell/forward";

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses: checkAndRecoverSandboxProcessesImpl } = requireSource(
  "../../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/process-recovery.js");
function mockForwardOwned(): NonNullable<
  NonNullable<
    Parameters<typeof checkAndRecoverSandboxProcessesImpl>[1]
  >["forwardAdapterForAuthority"]
> {
  return vi.fn(() => ({
    observeForwards: vi.fn<OpenShellForwardAdapter["observeForwards"]>(async ({ forwards }) =>
      forwards.map((forward) => ({ state: "owned" as const, forward })),
    ),
    startForward: vi.fn(),
    retireLegacyForward: vi.fn(),
    verifyForwardRelease: vi.fn(async () => ({ state: "released" as const })),
  }));
}

function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: Parameters<typeof checkAndRecoverSandboxProcessesImpl>[1] = {},
) {
  return checkAndRecoverSandboxProcessesImpl(sandboxName, {
    ensureSandboxPortForwardImpl: async () => true,
    isWsl: false,
    withLifecycleLock: async (_name, operation) => await operation(),
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unsupported custom gateway recovery", () => {
  it("reports the missing recovery contract without SSH or a privileged mutation", async () => {
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const native = requireSource("../../src/lib/adapters/openshell/sandbox-command-cli.ts");
    const privileged = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    const subprocess = vi.spyOn(native, "runCliOpenShellBufferedCommand");
    const privilegedExecutor = vi.spyOn(privileged, "executePrivilegedSandboxCommand");
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
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });
    const result = await checkAndRecoverSandboxProcesses("custom-box", {
      quiet: true,
      forwardAdapterForAuthority: mockForwardOwned(),
      isSandboxGatewayRunningImpl: async () => false,
    });
    expect(result.recovered).toBe(false);
    expect(result.recoveryFailureDetail).toContain(
      "does not declare a supported gateway recovery contract",
    );
    expect(result.recoveryFailureDetail).toContain("will not launch a custom gateway over SSH");
    expect(subprocess).not.toHaveBeenCalled();
    expect(privilegedExecutor).not.toHaveBeenCalled();
  });
  it("fails closed when a persisted non-OpenClaw manifest cannot be loaded", async () => {
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const commandCli = requireSource("../../src/lib/adapters/openshell/sandbox-command-cli.ts");
    const privileged = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    const subprocess = vi.spyOn(commandCli, "runCliOpenShellBufferedCommand");
    const privilegedExecutor = vi.spyOn(privileged, "executePrivilegedSandboxCommand");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "custom-box",
      agent: "missing-custom-agent",
      dashboardPort: 19000,
    });
    await expect(
      checkAndRecoverSandboxProcesses("custom-box", {
        quiet: false,
        isSandboxGatewayRunningImpl: async () => false,
      }),
    ).resolves.toEqual({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    expect(subprocess).not.toHaveBeenCalled();
    expect(privilegedExecutor).not.toHaveBeenCalled();
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
