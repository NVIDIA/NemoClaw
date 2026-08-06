// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  expectAbsentSandboxMcpFinalize,
  expectActiveTimerDestroyOrder,
  expectFailedDeletePreservesHostState,
  expectFailedHardeningMcpRestore,
  expectFailedHardeningRefusesForcedCleanup,
  expectFailedHardeningStillDeletes,
  expectFailedMcpFinalizePreservesRegistry,
  expectFailedMcpRestorePreservesDestroyFailure,
  expectMcpFinalizeAfterDelete,
  expectMcpFinalizeBridgeErrorReturnsFailure,
  expectMcpPrepareBridgeErrorAborts,
  expectMcpRestoreAfterDeleteFailure,
  expectShieldsUpRefusalBeforeMutation,
  expectStrictSandboxPresenceClassification,
  expectSuccessfulLiveDestroy,
} from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  type DestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import type { BaselineExclusionTransition, CustomPolicyTransition } from "../../state/registry";

const customApplyTransition = {
  version: 1,
  id: "33333333-3333-4333-8333-333333333333",
  operation: "apply",
  name: "private-api",
  previous: null,
  desired: {
    name: "private-api",
    content: "network_policies:\n  private_api:\n    endpoints: []\n",
    sourcePath: "/tmp/private-api.yaml",
  },
  startedAt: "2026-08-06T12:00:00.000Z",
} satisfies CustomPolicyTransition;

const customRemoveTransition = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  operation: "remove",
  name: "private-api",
  previous: {
    name: "private-api",
    content: "network_policies:\n  private_api:\n    endpoints: []\n",
  },
  desired: null,
  startedAt: "2026-08-06T12:00:00.000Z",
} satisfies CustomPolicyTransition;

const baselineRestoreTransition = {
  id: "22222222-2222-4222-8222-222222222222",
  operation: "restore",
  exclusion: {
    version: 1,
    agent: "openclaw",
    key: "nous_research",
    digest: "approved-digest",
  },
  targetLiveDigest: "release-digest",
  startedAt: "2026-08-06T12:00:00.000Z",
} satisfies BaselineExclusionTransition;

function expectNoDestroyCleanupAfterPresenceProof(harness: DestroyHarness): void {
  expect(harness.selectGatewaySpy).toHaveBeenCalled();
  expect(harness.gatewayPinsAtSandboxList.length).toBeGreaterThan(0);
  expect(harness.gatewayPinsAtSandboxList.every((pin) => pin === "nemoclaw-19080")).toBe(true);
  expect(harness.runOpenshellSpy).toHaveBeenCalled();
  expect(
    harness.runOpenshellSpy.mock.calls.every(
      ([args]) => Array.isArray(args) && args.join(" ") === "sandbox list -o json",
    ),
  ).toBe(true);
  expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
  expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
  expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
  expect(harness.unloadOllamaModelsSpy).not.toHaveBeenCalled();
  expect(harness.stopAllSpy).not.toHaveBeenCalled();
  expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
  expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).not.toHaveBeenCalled();
  expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).not.toHaveBeenCalled();
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).not.toHaveBeenCalled();
  expect(harness.events).toEqual([]);
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  expect(harness.updateSandboxSpy).not.toHaveBeenCalled();
  expect(harness.updateSessionSpy).not.toHaveBeenCalled();
  expect(harness.killTimerSpy).not.toHaveBeenCalled();
  expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
  expect(harness.revokeHttpsPinRuntimeAdapterRouteSpy).not.toHaveBeenCalled();
  expect(harness.dockerCaptureSpy).not.toHaveBeenCalled();
  expect(harness.dockerRunSpy).not.toHaveBeenCalled();
}

function expectJournalClearBeforeAbsentCleanup(
  harness: DestroyHarness,
  clearSpy: MockInstance,
  transitionId: string,
): void {
  expect(clearSpy).toHaveBeenCalledWith("alpha", transitionId);
  const clearOrder = clearSpy.mock.invocationCallOrder[0];
  const presenceProofCall = harness.runOpenshellSpy.mock.calls.findIndex(
    ([args]) => Array.isArray(args) && args.join(" ") === "sandbox list -o json",
  );
  expect(presenceProofCall).toBeGreaterThanOrEqual(0);
  expect(harness.gatewayPinsAtSandboxList).toEqual(["nemoclaw-19080"]);
  expect(harness.runOpenshellSpy.mock.invocationCallOrder[presenceProofCall]).toBeLessThan(
    clearOrder,
  );
  const refreshedReadOrder = harness.getSandboxSpy.mock.invocationCallOrder.find(
    (order) => order > clearOrder,
  );
  expect(refreshedReadOrder).toBeDefined();
  expect(clearOrder).toBeLessThan(refreshedReadOrder ?? 0);
  expect(clearOrder).toBeLessThan(harness.stopNimByNameSpy.mock.invocationCallOrder[0]);
  expect(clearOrder).toBeLessThan(
    harness.prepareMcpBridgesForAbsentSandboxDestroySpy.mock.invocationCallOrder[0],
  );
  expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
  expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
    force: false,
  });
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalled();
  const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
    ([args]) => Array.isArray(args) && args.join(" ") === "sandbox delete alpha",
  );
  expect(deleteCall).toBeGreaterThanOrEqual(0);
  expect(clearOrder).toBeLessThan(harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall]);
  expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
}

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
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("trusts absence only from a successful, error-free sandbox list", { timeout: 30_000 }, () => {
    expectStrictSandboxPresenceClassification();
  });

  it("selects the sandbox gateway, deletes live resources, cleans host state, and removes registry state", async () => {
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expectSuccessfulLiveDestroy(harness, exitSpy);
  });

  it.each([
    [
      "a live sandbox with a custom policy application",
      { customPolicyTransition: customApplyTransition },
      "custom policy apply for 'private-api' needs repair",
      "policy add with --from-file or --from-dir",
    ],
    [
      "unknown sandbox presence with a custom policy removal",
      {
        customPolicyTransition: customRemoveTransition,
        sandboxListStatus: 1,
        sandboxListStderr: "gateway unreachable",
      },
      "custom policy remove for 'private-api' needs repair",
      "policy remove private-api",
    ],
    [
      "a live sandbox with a baseline policy restore",
      { baselineExclusionTransition: baselineRestoreTransition },
      "baseline policy restore for 'nous_research' needs repair",
      "policy restore nous_research",
    ],
  ] as const)("blocks %s before destroy can mutate runtime or durable state", async (_scenario, options, expectedFailure, expectedRetry) => {
    const harness = createDestroyHarness(options);

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      expectedFailure,
    );

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(expectedRetry);
    expect(harness.selectGatewaySpy).toHaveBeenCalledTimes(2);
    expect(harness.gatewayPinsAtSandboxList).toEqual(["nemoclaw-19080", "nemoclaw-19080"]);
    expect(harness.clearCustomPolicyTransitionSpy).not.toHaveBeenCalled();
    expect(harness.clearBaselineExclusionTransitionSpy).not.toHaveBeenCalled();
    expectNoDestroyCleanupAfterPresenceProof(harness);
  });

  it("clears the exact custom policy journal before cleaning up a confirmed-absent sandbox", async () => {
    const harness = createDestroyHarness({
      customPolicyTransition: customRemoveTransition,
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectJournalClearBeforeAbsentCleanup(
      harness,
      harness.clearCustomPolicyTransitionSpy,
      customRemoveTransition.id,
    );
    expect(harness.clearBaselineExclusionTransitionSpy).not.toHaveBeenCalled();
  });

  it("clears the exact baseline policy journal before cleaning up a confirmed-absent sandbox", async () => {
    const harness = createDestroyHarness({
      baselineExclusionTransition: baselineRestoreTransition,
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectJournalClearBeforeAbsentCleanup(
      harness,
      harness.clearBaselineExclusionTransitionSpy,
      baselineRestoreTransition.id,
    );
    expect(harness.clearCustomPolicyTransitionSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "custom policy",
      {
        customPolicyTransition: customRemoveTransition,
        customTransitionClearResult: false,
      },
      "custom policy repair journal changed or could not be cleared",
      "clearCustomPolicyTransitionSpy",
      customRemoveTransition.id,
    ],
    [
      "baseline policy",
      {
        baselineExclusionTransition: baselineRestoreTransition,
        baselineTransitionClearResult: false,
      },
      "baseline policy repair journal changed or could not be cleared",
      "clearBaselineExclusionTransitionSpy",
      baselineRestoreTransition.id,
    ],
  ] as const)("preserves all cleanup state when the absent-sandbox %s journal CAS fails", async (_scenario, transition, expectedFailure, clearSpyName, transitionId) => {
    const harness = createDestroyHarness({
      ...transition,
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      expectedFailure,
    );

    expect(harness[clearSpyName]).toHaveBeenCalledWith("alpha", transitionId);
    expect(harness.getSandboxSpy).toHaveBeenCalledTimes(2);
    expectNoDestroyCleanupAfterPresenceProof(harness);
  });

  it("does not partially clear conflicting policy journals from a confirmed-absent sandbox", async () => {
    const harness = createDestroyHarness({
      baselineExclusionTransition: baselineRestoreTransition,
      customPolicyTransition: customRemoveTransition,
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "conflicting custom and baseline policy repair journals",
    );

    expect(harness.clearCustomPolicyTransitionSpy).not.toHaveBeenCalled();
    expect(harness.clearBaselineExclusionTransitionSpy).not.toHaveBeenCalled();
    expectNoDestroyCleanupAfterPresenceProof(harness);
  });

  it("revokes the prior HTTPS-pin route only after confirmed deletion and registry removal", async () => {
    const routeId = "a".repeat(64);
    const harness = createDestroyHarness({
      endpointUrl: `http://host.openshell.internal:11438/route/${routeId}`,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.revokeHttpsPinRuntimeAdapterRouteSpy).toHaveBeenCalledWith(routeId);
    expect(harness.removeSandboxSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.revokeHttpsPinRuntimeAdapterRouteSpy.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["--yes", "darwin", { yes: true }, "", true],
    ["NEMOCLAW_NON_INTERACTIVE=1", "darwin", {}, "1", true],
    [
      "an explicit preservation override",
      "darwin",
      { yes: true, cleanupGateway: false },
      "",
      false,
    ],
    ["NEMOCLAW_NON_INTERACTIVE=1", "linux", {}, "1", false],
  ] as const)("applies the final-gateway default for %s on %s (#4662)", async (_scenario, platform, options, nonInteractive, cleanupExpected) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", nonInteractive);
    const harness = createDestroyHarness();

    await expect(harness.destroySandbox("alpha", options)).resolves.toBeUndefined();

    expect(harness.promptSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy.mock.calls).toEqual(
      cleanupExpected ? [["nemoclaw-19080", harness.runOpenshellSpy]] : [],
    );
  });

  it("stops before local cleanup when OpenShell fails to delete the live sandbox", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 7,
      deleteOutput: "delete failed",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedDeletePreservesHostState(harness, exitSpy);
  });

  it("preserves provider and registry ownership when runtime authority is unknown", async () => {
    const harness = createDestroyHarness({
      openshellDriver: "unknown-runtime",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("unknown-runtime");
    expect(errorOutput).toContain("is not registered for this operation");
    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("blocks deletion and preserves ownership when image authority is unproven", async () => {
    const harness = createDestroyHarness({
      imageTag: "local/alpha:current",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "local/alpha:recorded",
        shared: false,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const logOutput = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("Runtime provider 'docker'");
    expect(errorOutput).toContain("recorded workload receipt");
    expect(logOutput).not.toContain("Sandbox 'alpha' destroyed");
    expect(harness.events).not.toContain("delete");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
  });

  it("retires registry and session ownership after the workload receipt is repaired", async () => {
    const imageTag = "local/alpha:current";
    const harness = createDestroyHarness({
      imageTag,
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: imageTag,
        shared: false,
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.dockerRunSpy).toHaveBeenCalledWith(["rmi", imageTag], {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.updateSessionSpy).toHaveBeenCalledOnce();
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Sandbox 'alpha' destroyed",
    );
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
    expect(harness.revokeHttpsPinRuntimeAdapterRouteSpy).not.toHaveBeenCalled();
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

  it("warns and still deletes when active-window hardening fails after the wipe (#7727)", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectFailedHardeningStillDeletes(harness);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("keeps the timer and local record when --force cannot confirm deletion after failed hardening (#7727)", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 1,
      deleteOutput: "error trying to connect: connection refused",
      registeredSandboxCount: 1,
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { force: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expectFailedHardeningRefusesForcedCleanup(harness);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("restores MCP runtime state without a rollback window when delete fails after failed hardening (#7727)", async () => {
    const harness = createDestroyHarness({
      activeTimer: true,
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
      shieldsUpError: new Error("injected hardening failure"),
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedHardeningMcpRestore(harness);
    expect(exitSpy).toHaveBeenCalledWith(7);
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

  it("exits with code 1 when MCP bridge prepare throws McpBridgeError, gateway down (#8103)", async () => {
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      prepareMcpBridgeError: "Could not inspect OpenShell provider: gateway unreachable",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expectMcpPrepareBridgeErrorAborts(harness);
  });

  it("redacts MCP bridge finalize errors after sandbox deletion (#8103)", async () => {
    const secretMarker = "destroy-secret-marker";
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      finalizeMcpBridgeError: `Could not inspect OpenShell provider: OPENAI_API_KEY=${secretMarker}`,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expectMcpFinalizeBridgeErrorReturnsFailure(harness, secretMarker);
  });

  it("retires retained MCP state when destroy retries after finalization failure (#8103)", async () => {
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      finalizeMcpBridgeError: "Could not inspect OpenShell provider: gateway unreachable",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    harness.setSandboxPresent(false);
    harness.finalizeMcpBridgesAfterSandboxDeleteSpy.mockResolvedValue(undefined);

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
    });
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledTimes(2);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.updateSessionSpy).toHaveBeenCalledOnce();
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith(
      "nemoclaw-19080",
      harness.runOpenshellSpy,
    );
  });
});
