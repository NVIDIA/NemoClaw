// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type GatewayStateModule = typeof import("./gateway-state");

const requireDist = createRequire(import.meta.url);

describe("printGatewayLifecycleHint multi-instance hints", () => {
  let gatewayState: GatewayStateModule;
  let captureOpenshellSpy: MockInstance;
  let getNamedGatewayLifecycleStateSpy: MockInstance;
  let getSandboxSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;

  beforeEach(async () => {
    const gatewayStatePath = requireDist.resolve("./gateway-state.js");
    delete require.cache[gatewayStatePath];
    const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const registry = requireDist("../../state/registry.js");
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
    captureOpenshellSpy = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "Sandbox:\n  Name: instance-a\n  Phase: Ready",
    });
    getNamedGatewayLifecycleStateSpy = vi
      .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
      .mockReturnValue({ state: "healthy_named", status: "Gateway: nemoclaw" });
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: false });
    getSandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "instance-a",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
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
    expect(combined).toContain("openshell gateway start");
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

  it("classifies a failed post-recovery handshake as identity drift", async () => {
    recoverNamedGatewayRuntimeSpy.mockResolvedValue({ recovered: true, via: "start" });
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ state: "gateway_error", output: "transport error" })
      .mockResolvedValueOnce({
        state: "gateway_error",
        output: "transport error: handshake verification failed",
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
      lifecycle: {
        state: "named_unreachable",
        status: "Gateway: nemoclaw\nConnection refused",
      },
      expectedState: "gateway_unreachable_after_restart",
      expectedGatewayRecoveryFailed: undefined,
    },
    {
      lifecycle: { state: "missing_named", status: "No gateway configured" },
      expectedState: "gateway_missing_after_restart",
      expectedGatewayRecoveryFailed: undefined,
    },
    {
      lifecycle: {
        state: "connected_other",
        activeGateway: "openshell",
        status: "Gateway: openshell\nStatus: Connected",
      },
      expectedState: "gateway_error",
      expectedGatewayRecoveryFailed: true,
    },
  ])("maps failed gateway recovery to $expectedState", async ({
    lifecycle,
    expectedState,
    expectedGatewayRecoveryFailed,
  }) => {
    getNamedGatewayLifecycleStateSpy.mockReturnValue(lifecycle);

    const lookup = await gatewayState.getReconciledSandboxGatewayState("instance-a", {
      getState: async () => ({ state: "gateway_error", output: "transport error" }),
    });

    expect(lookup.state).toBe(expectedState);
    expect(lookup.gatewayRecoveryFailed).toBe(expectedGatewayRecoveryFailed);
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

  it("prints restart guidance when the named gateway remains unreachable", async () => {
    captureOpenshellSpy.mockReturnValue({
      status: 1,
      output: "Error: transport error: Connection refused",
    });
    getNamedGatewayLifecycleStateSpy.mockReturnValue({
      state: "named_unreachable",
      status: "Gateway: nemoclaw\nConnection refused",
    });
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
});
