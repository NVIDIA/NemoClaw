// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

describe("sandbox registration route transaction", () => {
  it("rechecks quarantine after a queued onboard acquires the sandbox lock (#10140)", async () => {
    const events: string[] = [];
    const { calls, deps } = createDeps({
      withSandboxMutationLock: async (_sandboxName, operation) => {
        events.push("lock-acquired");
        return await operation();
      },
      getSandboxRegistryEntry: () => {
        events.push("fence-read");
        return {
          name: "my-assistant",
          quarantine: {
            schemaVersion: 1,
            fenceId: "00000000-0000-4000-8000-000000000001",
            requestIdentity: "a".repeat(64),
            reasonDigest: "b".repeat(64),
            createdAt: "2026-08-25T04:00:00.000Z",
            updatedAt: "2026-08-25T04:00:00.000Z",
            phase: "fenced",
            target: {
              sandboxName: "my-assistant",
              providerId: "docker",
              gatewayName: "nemoclaw",
              gatewayPort: 8080,
              lifecycleGeneration: "registry-generation-1",
              liveIdentityFingerprint: "b".repeat(64),
              providerHandle: "c".repeat(64),
              providerLifecycleGeneration: "provider-generation-1",
              runtime: { kind: "docker-container", handle: "d".repeat(64) },
            },
            attempts: [],
          },
        };
      },
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps), sandboxName: "my-assistant" }),
    ).rejects.toThrow("quarantined");

    expect(events.slice(0, 2)).toEqual(["lock-acquired", "fence-read"]);
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("allows valid peer-route drift after waiting for the gateway lock", async () => {
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

    await expect(onboard).resolves.toMatchObject({ sandboxName: "my-assistant" });
    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayName: "nemoclaw", sandboxName: null }),
    );
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.startStep).toHaveBeenCalled();
    expect(calls.updateSession).toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("stages credentials, then holds sandbox, host dashboard, and gateway locks through creation", async () => {
    const events: string[] = [];
    const { deps } = createDeps({
      configureWebSearch: vi.fn(async () => ({
        fetchEnabled: true as const,
        provider: "brave" as const,
      })),
      checkGatewayRouteCompatibility: () => {
        events.push("guard");
        return { ok: true };
      },
      withSandboxMutationLock: async (_sandboxName, operation) => {
        events.push("sandbox-lock");
        return await operation();
      },
      withDashboardPortReservationLock: async (operation) => {
        events.push("dashboard-lock");
        return await operation();
      },
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        events.push("gateway-lock");
        return await operation();
      },
      stageSandboxCredentialProviders: async () => {
        events.push("stage");
        return [];
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
    expect(events).toEqual([
      "gateway-lock",
      "stage",
      "sandbox-lock",
      "dashboard-lock",
      "gateway-lock",
      "guard",
      "create",
      "registry",
    ]);
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
