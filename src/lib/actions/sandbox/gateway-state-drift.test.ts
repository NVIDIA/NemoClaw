// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { OpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";

type GatewayStateModule = typeof import("../../../../dist/lib/actions/sandbox/gateway-state");

const requireDist = createRequire(import.meta.url);

const driftIssue: OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
}

describe("sandbox gateway state drift guard", () => {
  let gatewayState: GatewayStateModule;
  let exitSpy: ReturnType<typeof mockExit>;
  let errorSpy: MockInstance;
  let spies: MockInstance[];
  let captureOpenshellSpy: MockInstance;
  let captureOpenshellForStatusSpy: MockInstance;
  let detectPreflightIssueSpy: MockInstance;
  let getNamedGatewayLifecycleStateSpy: MockInstance;
  let runOpenshellSpy: MockInstance;
  let removeSandboxSpy: MockInstance;

  beforeEach(async () => {
    spies = [];
    exitSpy = mockExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../../../dist/lib/adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const gatewayRuntime = requireDist("../../../../dist/lib/gateway-runtime-action.js");
    const registry = requireDist("../../../../dist/lib/state/registry.js");

    captureOpenshellSpy = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "Sandbox:\n  Name: alpha\n  Phase: Ready" });
    captureOpenshellForStatusSpy = vi
      .spyOn(openshellRuntime, "captureOpenshellForStatus")
      .mockResolvedValue({ status: 0, output: "Sandbox:\n  Name: alpha\n  Phase: Ready" });
    runOpenshellSpy = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);
    removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockImplementation(() => undefined);

    detectPreflightIssueSpy = vi
      .spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue")
      .mockReturnValue(driftIssue);
    getNamedGatewayLifecycleStateSpy = vi
      .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
      .mockReturnValue({
        state: "healthy_named",
        status: "",
      } as never);

    spies.push(
      detectPreflightIssueSpy,
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      vi.spyOn(gatewayDrift, "formatOpenShellStateRpcIssue").mockReturnValue([
        "",
        "  OpenShell gateway schema preflight failed before checking status.",
        "  No sandbox data was changed.",
      ]),
      captureOpenshellSpy,
      captureOpenshellForStatusSpy,
      runOpenshellSpy,
      vi.spyOn(openshellRuntime, "isCommandTimeout").mockReturnValue(false),
      getNamedGatewayLifecycleStateSpy,
      vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
        recovered: false,
      } as never),
      removeSandboxSpy,
    );

    gatewayState = requireDist("../../../../dist/lib/actions/sandbox/gateway-state.js");
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("status lookup returns schema-mismatch state before sandbox get", async () => {
    const lookup = await gatewayState.getSandboxGatewayStateForStatus("alpha");

    expect(lookup.state).toBe("gateway_schema_mismatch");
    expect(lookup.output).toContain("No sandbox data was changed.");
    expect(detectPreflightIssueSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: expect.any(Number),
    }));
    expect(captureOpenshellForStatusSpy).not.toHaveBeenCalled();
  });

  it("threads the status probe timeout into gateway drift preflight", async () => {
    vi.stubEnv("NEMOCLAW_STATUS_PROBE_TIMEOUT_MS", "123");
    detectPreflightIssueSpy.mockReturnValue(null);

    await gatewayState.getSandboxGatewayStateForStatus("alpha");

    expect(detectPreflightIssueSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 123,
    }));
    expect(captureOpenshellForStatusSpy).toHaveBeenCalledWith(
      ["sandbox", "get", "alpha"],
      expect.objectContaining({ timeout: 123 }),
    );
  });

  it("recover/connect liveness guard exits without removing registry entries on schema mismatch", async () => {
    await expect(gatewayState.ensureLiveSandboxOrExit("alpha")).rejects.toThrow(
      "process.exit(1)",
    );

    expect(removeSandboxSpy).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
  });

  it("propagates schema mismatch after selecting the named gateway", () => {
    getNamedGatewayLifecycleStateSpy.mockReturnValue({
      state: "connected_other",
      activeGateway: "openshell",
      status: "Gateway: openshell\nStatus: Connected",
    });

    const lookup = gatewayState.reconcileMissingAgainstNamedGateway("alpha", {
      state: "missing",
      output: "NotFound",
    });

    expect(lookup.state).toBe("gateway_schema_mismatch");
    expect(lookup.output).toContain("No sandbox data was changed.");
    expect(runOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(removeSandboxSpy).not.toHaveBeenCalled();
  });
});
