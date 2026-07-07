// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

describe("sandbox registration route transaction", () => {
  it("rechecks compatibility after waiting for the gateway lock and before create", async () => {
    let releaseGateway!: () => void;
    const gatewayReleased = new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    let reportGatewayEntered!: () => void;
    const gatewayEntered = new Promise<void>((resolve) => {
      reportGatewayEntered = resolve;
    });
    const checkGatewayRouteCompatibility = vi.fn(() => ({
      ok: false as const,
      gatewayName: "nemoclaw",
      sandboxName: "my-assistant",
      route: { provider: "provider", model: "model" },
      conflicts: [{ sandboxName: "peer", reason: "provider-model" as const }],
    }));
    const { calls, deps } = createDeps({
      checkGatewayRouteCompatibility,
      withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        reportGatewayEntered();
        await gatewayReleased;
        return await operation();
      },
    });

    const onboard = handleSandboxState(baseOptions(deps));
    await gatewayEntered;
    expect(checkGatewayRouteCompatibility).not.toHaveBeenCalled();
    releaseGateway();

    await expect(onboard).rejects.toThrow("exit 1");
    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw", sandboxName: null }),
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.updateSession).not.toHaveBeenCalled();
    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("peer"));
  });

  it("holds sandbox then gateway locks through sandbox creation and route registration", async () => {
    const events: string[] = [];
    const { deps } = createDeps({
      checkGatewayRouteCompatibility: () => {
        events.push("guard");
        return { ok: true };
      },
      withSandboxMutationLock: async (_sandboxName, operation) => {
        events.push("sandbox-lock");
        return await operation();
      },
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        events.push("gateway-lock");
        return await operation();
      },
      createSandbox: async () => {
        events.push("create");
        return "my-assistant";
      },
      updateSandboxRegistry: () => {
        events.push("registry");
      },
    });

    await expect(handleSandboxState(baseOptions(deps))).resolves.toMatchObject({
      sandboxName: "my-assistant",
    });
    expect(events).toEqual(["sandbox-lock", "gateway-lock", "guard", "create", "registry"]);
  });

  it("fails when a competing same-name registration changed routes", async () => {
    const checkGatewayRouteCompatibility = vi.fn((request) =>
      request.sandboxName === null
        ? {
            ok: false as const,
            gatewayName: "nemoclaw",
            sandboxName: null,
            route: { provider: "provider", model: "model" },
            conflicts: [{ sandboxName: "my-assistant", reason: "provider-model" as const }],
          }
        : { ok: true as const },
    );
    const { calls, deps } = createDeps({
      checkGatewayRouteCompatibility,
      getSandboxRegistryEntry: () => ({
        name: "my-assistant",
        provider: "other-provider",
        model: "other-model",
      }),
    });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: null }),
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
  });

  it("fails when the route reservation disappears before creation", async () => {
    const { calls, deps } = createDeps({ getSandboxRegistryEntry: () => null });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("disappeared"));
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
  });
});
