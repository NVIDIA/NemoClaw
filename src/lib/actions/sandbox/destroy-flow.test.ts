// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  expectAbsentSandboxMcpFinalize,
  expectActiveTimerDestroyOrder,
  expectFailedDeletePreservesHostState,
  expectFailedHardeningStopsDelete,
  expectFailedMcpFinalizePreservesRegistry,
  expectFailedMcpRestorePreservesDestroyFailure,
  expectMcpFinalizeAfterDelete,
  expectMcpRestoreAfterDeleteFailure,
  expectShieldsUpRefusalBeforeMutation,
  expectStrictSandboxPresenceClassification,
  expectSuccessfulLiveDestroy,
} from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroySandbox flow", () => {
  let exitSpy: MockInstance;
  let originalGatewayEnv: string | undefined;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    resetDestroyModuleCache();
  });

  it("trusts absence only from a successful, error-free sandbox list", { timeout: 15_000 }, () => {
    expectStrictSandboxPresenceClassification();
  });

  it("selects the sandbox gateway, deletes live resources, cleans host state, and removes registry state", async () => {
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expectSuccessfulLiveDestroy(harness, exitSpy);
  });

  it("stops before local cleanup when OpenShell fails to delete the live sandbox", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 7,
      deleteOutput: "delete failed",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedDeletePreservesHostState(harness, exitSpy);
  });

  it("refuses shields-up Hermes MCP destroy before stopping services or preparing MCP state", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "has shields up or an unreadable shields posture",
    );

    expectShieldsUpRefusalBeforeMutation(harness);
  });

  it("does not require mutable Hermes config for a prepared-only add", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpAddState: "prepared",
      mcpServers: ["github"],
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha");
  });

  it("does not require mutable Hermes config for absent-sandbox cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      mcpServers: ["github"],
      sandboxPresent: false,
      shieldsDown: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
    });
  });

  it("does not stop shared host services when --force cleans up the last sandbox with the gateway down (#6046)", async () => {
    // Gateway-unreachable delete failure + --force triggers forcedLocalCleanup:
    // the local record is removed but the gateway-side delete was never
    // confirmed, so the sandbox may still exist. Even as the only registered
    // sandbox, that must not tear down shared host services (CodeRabbit #6050).
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      registeredSandboxCount: 1,
    });

    await expect(harness.destroySandbox("alpha", { force: true })).resolves.toBeUndefined();

    // Local cleanup still proceeds...
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    // ...but shared host services are preserved on the unconfirmed delete.
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("fails closed and restores MCP state when --force cannot confirm sandbox deletion", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      mcpServers: ["github"],
      registeredSandboxCount: 1,
    });

    await expect(harness.destroySandbox("alpha", { force: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expectMcpRestoreAfterDeleteFailure(harness);
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("MCP ownership required for exact provider cleanup");
    expect(errorOutput).toContain("--force cannot safely discard MCP ownership");
    expect(errorOutput).not.toContain("re-run with --force to remove the local sandbox record");
  });

  it("wipes while mutable, hardens an active timer window, then deletes and clears it", async () => {
    const harness = createDestroyHarness({ activeTimer: true });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectActiveTimerDestroyOrder(harness);
  });

  it("does not delete when active-window hardening fails after the wipe", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "injected hardening failure",
    );

    expectFailedHardeningStopsDelete(harness);
  });

  it("detaches MCP providers before delete and finalizes them only after delete succeeds", async () => {
    const harness = createDestroyHarness({ mcpServers: ["github", "slack"] });

    await harness.destroySandbox("alpha", { yes: true });

    expectMcpFinalizeAfterDelete(harness);
  });

  it("restores MCP runtime state when sandbox delete fails", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectMcpRestoreAfterDeleteFailure(harness);
  });

  it("relocks shields and preserves destroy failure when MCP rollback fails", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
      restoreMcpError: "injected MCP restore failure",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedMcpRestorePreservesDestroyFailure(harness);
  });

  it("preserves the registry when post-delete MCP cleanup fails, even with force", async () => {
    const harness = createDestroyHarness({
      finalizeMcpError: "provider delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "provider delete failed",
    );

    expectFailedMcpFinalizePreservesRegistry(harness);
  });

  it("finalizes exact MCP providers when the sandbox was already externally removed", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "Error: sandbox alpha not found",
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectAbsentSandboxMcpFinalize(harness);
  });
});
