// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { OpenShellGatewayObservation } from "../../adapters/openshell/gateway-observer";

type GatewayStateModule = typeof import("./gateway-state");

function gatewayObservation(
  state: OpenShellGatewayObservation["state"],
  diagnostic = "Gateway is not connected.",
  activeGateway = "nemoclaw",
): OpenShellGatewayObservation {
  return {
    state,
    diagnostic,
    activeGateway,
    recoveryBlocked: false,
    unavailable: state === "named_unhealthy" || state === "named_unreachable",
  };
}

const requireDist = createRequire(import.meta.url);

describe("printGatewayLifecycleHint multi-instance hints", () => {
  let gatewayState: GatewayStateModule;
  let captureOpenshellSpy: MockInstance;
  let getNamedGatewayLifecycleStateSpy: MockInstance;
  let getSandboxSpy: MockInstance;
  let findSandboxAcrossGatewayRootsSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;

  function mockSandboxPhase(phase: string): void {
    captureOpenshellSpy.mockImplementation((args: string[]) =>
      args[0] === "policy"
        ? { status: 0, output: "version: 1\nnetwork_policies: {}" }
        : {
            status: 0,
            output: `Sandbox:\n  Name: instance-a\n  Phase: ${phase}`,
          },
    );
  }

  beforeEach(async () => {
    const gatewayStatePath = requireDist.resolve("./gateway-state.js");
    delete require.cache[gatewayStatePath];
    const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const registry = requireDist("../../state/registry.js");
    const crossPortRegistry = requireDist("../../state/registry/cross-port.js");
    const gatewaySelect = requireDist("./gateway-select.js");
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockResolvedValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockResolvedValue(null);
    captureOpenshellSpy = vi.spyOn(openshellRuntime, "captureOpenshell");
    mockSandboxPhase("Ready");
    getNamedGatewayLifecycleStateSpy = vi
      .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
      .mockResolvedValue(gatewayObservation("healthy_named", "Connected to gateway nemoclaw."));
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: false });
    getSandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "instance-a",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    });
    findSandboxAcrossGatewayRootsSpy = vi
      .spyOn(crossPortRegistry, "findSandboxAcrossGatewayRoots")
      .mockImplementation((name: unknown) => {
        const entry = registry.getSandbox(String(name));
        return entry
          ? { entry, gatewayPort: entry.gatewayPort ?? null, registryFile: "/test/sandboxes.json" }
          : null;
      });
    vi.spyOn(gatewaySelect, "selectSandboxOwningGateway").mockReturnValue({
      outcome: "selected",
      gatewayName: "nemoclaw",
    });
    gatewayState = requireDist("./gateway-state.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve("./gateway-state.js")];
  });

  it("surfaces a switch-gateway hint when the underlying gRPC error is `sandbox has no spec`", () => {
    const lines: string[] = [];
    gatewayState.printGatewayLifecycleHint(
      'status: Internal, message: "sandbox has no spec", details: []',
      "instance-a",
      (msg: string) => lines.push(msg),
    );

    const combined = lines.join("\n");
    expect(combined).toContain("instance-a");
    expect(combined).toContain("nemoclaw");
    expect(combined).toContain("openshell gateway select");
    expect(getSandboxSpy).toHaveBeenCalledWith("instance-a");
    expect(findSandboxAcrossGatewayRootsSpy).toHaveBeenCalledWith("instance-a");
  });

  it("uses the sandbox's per-port gateway name in the hint for a non-default `NEMOCLAW_GATEWAY_PORT`", () => {
    getSandboxSpy.mockReturnValue({
      name: "instance-b",
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
    });
    const lines: string[] = [];
    gatewayState.printGatewayLifecycleHint("sandbox has no spec", "instance-b", (msg: string) =>
      lines.push(msg),
    );

    const combined = lines.join("\n");
    expect(combined).toContain("nemoclaw-8081");
    expect(combined).toContain("openshell gateway select nemoclaw-8081");
  });

  it("does not match the new clause on unrelated gateway lifecycle output", () => {
    const lines: string[] = [];
    gatewayState.printGatewayLifecycleHint("No gateway configured", "instance-a", (msg: string) =>
      lines.push(msg),
    );

    const combined = lines.join("\n");
    expect(combined).not.toContain("sandbox has no spec");
    expect(combined).toContain("no longer configured or its metadata/runtime has been lost");
    expect(combined).toContain("Start the gateway again with `nemoclaw onboard`.");
  });

  it.each([
    {
      label: "transport",
      output: "\u001b[31mError: trans\u001b[0mport error: Connec\u001b[33mtion refused\u001b[0m",
      expected: "current gateway/runtime is not reachable",
    },
    {
      label: "authentication",
      output: "\u001b[31mMissing gateway auth\u001b[0m token",
      expected: "Verify the active gateway and retry after re-establishing the runtime.",
    },
  ])("matches ANSI-decorated $label lifecycle errors", ({ output, expected }) => {
    const lines: string[] = [];

    gatewayState.printGatewayLifecycleHint(output, "instance-a", (line: string) =>
      lines.push(line),
    );

    expect(lines.join("\n")).toContain(expected);
  });

  it.each([
    {
      label: "unreachable transport",
      result: { status: 1, output: "Connection refused credential-value" },
      expected: "gateway 'nemoclaw' is not reachable",
    },
    {
      label: "gateway identity",
      result: { status: 1, output: "handshake verification failed credential-value" },
      expected: "gateway identity drift after restart",
    },
    {
      label: "authentication",
      result: { status: 1, output: "authentication failed credential-value" },
      expected: "restore its authentication before retrying",
    },
    {
      label: "timeout",
      result: {
        status: null,
        output: "credential-value",
        error: Object.assign(new Error("credential-value"), { code: "ETIMEDOUT" }),
      },
      expected: "did not answer before the sandbox observation timeout",
    },
  ])(
    "prints typed $label guidance without raw diagnostics (#9803)",
    async ({ result, expected }) => {
      captureOpenshellSpy.mockReturnValue(result);
      const lines: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line = "") => {
        lines.push(String(line));
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never);

      await expect(
        gatewayState.ensureLiveSandboxOrExit("instance-a", { gatewayRecovery: "observe" }),
      ).rejects.toThrow("process.exit(1)");

      expect(lines.join("\n")).toContain(expected);
      expect(lines.join("\n")).not.toContain("credential-value");
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("classifies a failed post-recovery handshake as identity drift", async () => {
    recoverNamedGatewayRuntimeSpy.mockResolvedValue({ recovered: true, via: "start" });
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "gateway_error", output: "transport error" })
      .mockResolvedValueOnce({
        state: "gateway_error",
        output: "The selected gateway identity does not match the recorded identity.",
        transportReason: "identity_mismatch",
      });

    const lookup = await gatewayState.getReconciledSandboxGatewayState("instance-a", { getState });

    expect(lookup).toEqual(
      expect.objectContaining({
        state: "identity_drift",
        recoveredGateway: true,
        recoveryVia: "start",
      }),
    );
  });

  it.each([
    {
      phase: "Stopped",
      expected: "Sandbox 'instance-a' is stopped.",
      rejected: "rebuild --yes",
    },
    {
      phase: "Error",
      expected: "nemoclaw instance-a start",
      rejected: "docker unpause",
    },
    {
      phase: "Failed",
      expected: "nemoclaw instance-a rebuild --yes",
      rejected: "docker unpause",
    },
  ])("uses the OpenShell $phase phase for recovery guidance", async (testCase) => {
    mockSandboxPhase(testCase.phase);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line = "") => {
      lines.push(String(line));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    await expect(gatewayState.ensureLiveSandboxOrExit("instance-a")).rejects.toThrow(
      "process.exit(1)",
    );

    const output = lines.join("\n");
    expect(output).toContain(testCase.expected);
    expect(output).not.toContain(testCase.rejected);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      lifecycle: gatewayObservation("named_unreachable", "Gateway is unreachable."),
      expectedState: "gateway_unreachable_after_restart",
      expectedGatewayRecoveryFailed: undefined,
    },
    {
      lifecycle: gatewayObservation("named_unhealthy"),
      expectedState: "gateway_unreachable_after_restart",
      expectedGatewayRecoveryFailed: undefined,
    },
    {
      lifecycle: gatewayObservation("missing_named", "No gateway configured"),
      expectedState: "gateway_missing_after_restart",
      expectedGatewayRecoveryFailed: undefined,
    },
    {
      lifecycle: gatewayObservation(
        "connected_other",
        "Connected to another gateway.",
        "openshell",
      ),
      expectedState: "gateway_error",
      expectedGatewayRecoveryFailed: true,
    },
  ])(
    "maps failed gateway recovery to $expectedState",
    async ({ lifecycle, expectedState, expectedGatewayRecoveryFailed }) => {
      getNamedGatewayLifecycleStateSpy.mockResolvedValue(lifecycle);

      const lookup = await gatewayState.getReconciledSandboxGatewayState("instance-a", {
        getState: async () => ({ state: "gateway_error", output: "transport error" }),
      });

      expect(lookup.state).toBe(expectedState);
      expect(lookup.gatewayRecoveryFailed).toBe(expectedGatewayRecoveryFailed);
    },
  );

  it("preserves restart guidance from an unhealthy recovery observation", async () => {
    recoverNamedGatewayRuntimeSpy.mockResolvedValue({
      recovered: false,
      after: gatewayObservation("named_unhealthy"),
    });
    const lookup = await gatewayState.getReconciledSandboxGatewayState("instance-a", {
      getState: async () => ({ state: "gateway_error", output: "transport error" }),
    });
    expect(lookup).toMatchObject({
      state: "gateway_unreachable_after_restart",
      output: "Gateway is not connected.",
    });
  });

  it("prints reconnect and recreate guidance when identity drift persists", async () => {
    captureOpenshellSpy.mockReturnValue({
      status: 1,
      output: "Error: transport error: handshake verification failed",
    });
    recoverNamedGatewayRuntimeSpy.mockResolvedValue({ recovered: true, via: "start" });
    const lines: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line = "") => {
      lines.push(String(line));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    await expect(gatewayState.ensureLiveSandboxOrExit("instance-a")).rejects.toThrow(
      "process.exit(1)",
    );

    const output = lines.join("\n");
    expect(output).toContain("Could not reconnect to sandbox 'instance-a'");
    expect(output).toContain("Recreate this sandbox");
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it.each([
    {
      state: "named_unreachable" as const,
      observation: gatewayObservation("named_unreachable", "Gateway is unreachable."),
    },
    {
      state: "named_unhealthy" as const,
      observation: gatewayObservation("named_unhealthy"),
    },
  ])("prints restart guidance when the named gateway remains $state", async ({ observation }) => {
    captureOpenshellSpy.mockReturnValue({
      status: 1,
      output: "Error: transport error: Connection refused",
    });
    getNamedGatewayLifecycleStateSpy.mockResolvedValue(observation);
    const lines: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line = "") => {
      lines.push(String(line));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    await expect(gatewayState.ensureLiveSandboxOrExit("instance-a")).rejects.toThrow(
      "process.exit(1)",
    );

    const output = lines.join("\n");
    expect(output).toContain("gateway is still refusing connections after restart");
    expect(output).toContain("If the gateway never becomes healthy");
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("names a command that exists when a sandbox-scoped command observes a stopped gateway", async () => {
    captureOpenshellSpy.mockReturnValue({
      status: 1,
      output: "transport error\ntcp connect error\nConnection refused (os error 61)",
    });
    const lines: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line = "") => {
      lines.push(String(line));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    await expect(
      gatewayState.ensureLiveSandboxOrExit("instance-a", { gatewayRecovery: "observe" }),
    ).rejects.toThrow("process.exit(1)");

    const output = lines.join("\n");
    expect(output).toContain(
      "This sandbox-scoped command will not restart the shared host gateway",
    );
    expect(output).toContain("Start the gateway again with `nemoclaw onboard`.");
    expect(output).not.toContain("openshell gateway start");
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
