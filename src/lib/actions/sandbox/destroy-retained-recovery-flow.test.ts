// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import type { RetainedSandboxRecoveryRecord } from "../../state/onboard-session/retained-sandbox-recovery";

function retainedRecoveryRecord(sandboxId = "sb-alpha"): RetainedSandboxRecoveryRecord {
  return {
    schemaVersion: 1,
    recordId: "f".repeat(64),
    sandboxName: "alpha",
    sandboxIdentityFingerprint: createHash("sha256").update(sandboxId).digest("hex"),
    identityWasUnavailable: false,
    gatewayName: "nemoclaw-19080",
    gatewayPort: 19080,
    lifecycleGeneration: "generation-alpha",
    createAttemptNonce: "c".repeat(62),
    resources: {
      sharedInferenceProviders: [],
      sandboxScopedProviders: [],
      credentialEnvironmentVariables: [],
    },
    reason: "retained_after_sandbox_creation_failure",
    recordedAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("destroySandbox retained recovery flow", () => {
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

  it(
    "removes every container after OpenShell confirms the retained sandbox absent (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const sandboxContainerId = "a".repeat(64);
      const bootstrapContainerId = "b".repeat(64);
      const identityRows = [sandboxContainerId, bootstrapContainerId]
        .map((id) => `${id}\topenshell\tdefault\tsb-alpha`)
        .join("\n");
      const harness = createDestroyHarness({
        sandboxPresent: false,
        dockerOrphanIds: [bootstrapContainerId],
        dockerRunResult: { status: 0, stdout: identityRows },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        },
        retainedRecoveryRecords: [recovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.dockerRunSpy).toHaveBeenCalledWith(
        ["rm", "-f", bootstrapContainerId],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledWith(recovery);
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(harness.sessionState.sandboxName).toBeNull();
      expect(exitSpy).not.toHaveBeenCalled();

      const exactRemovalCallsAfterCleanup = harness.dockerRunSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "rm" && args[1] === "-f",
      ).length;
      harness.setSandboxPresent(false);
      harness.setRegistryEntryPresent(false);
      harness.setRetainedRecoveryRecords([]);
      harness.setDockerIdentityResult({ status: 0, stdout: "" });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(
        harness.dockerRunSpy.mock.calls.filter(
          ([args]) => Array.isArray(args) && args[0] === "rm" && args[1] === "-f",
        ),
      ).toHaveLength(exactRemovalCallsAfterCleanup);
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledOnce();
    },
  );

  it(
    "preserves recovery when a foreign name-labeled container appears after continuity checks (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const sandboxContainerId = "a".repeat(64);
      const bootstrapContainerId = "b".repeat(64);
      const foreignContainerId = "e".repeat(64);
      const identityRows = [sandboxContainerId, bootstrapContainerId]
        .map((id) => `${id}\topenshell\tdefault\tsb-alpha`)
        .join("\n");
      const harness = createDestroyHarness({
        sandboxPresent: false,
        dockerNameLabeledIds: [bootstrapContainerId, foreignContainerId],
        dockerOrphanIds: [bootstrapContainerId],
        dockerRunResult: { status: 0, stdout: identityRows },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        },
        retainedRecoveryRecords: [recovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.dockerRunSpy).not.toHaveBeenCalledWith(
        ["rm", "-f", expect.any(String)],
        expect.anything(),
      );
      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("outside the retained identity set"),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).not.toHaveBeenCalled();
    },
  );

  it(
    "does not delete a live retained sandbox when Docker identity is absent (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const harness = createDestroyHarness({
        dockerRunResult: { status: 0, stdout: "" },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        },
        retainedRecoveryRecords: [recovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("delete command accepts only the mutable sandbox name"),
      );
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).not.toHaveBeenCalled();
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    },
  );

  it(
    "does not issue mutable-name deletion for a live retained sandbox with matching identity (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const containerId = "a".repeat(64);
      const harness = createDestroyHarness({
        dockerRunResult: {
          status: 0,
          stdout: `${containerId}\topenshell\tdefault\tsb-alpha`,
        },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        },
        retainedRecoveryRecords: [recovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot bind that deletion to the retained immutable identity"),
      );
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).not.toHaveBeenCalled();
      expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    },
  );

  it(
    "finishes retained cleanup after OpenShell already removed the sandbox (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const bootstrapContainerId = "b".repeat(64);
      const pendingCreateIdentity = {
        schemaVersion: 1 as const,
        state: "verified-create" as const,
        gatewayName: recovery.gatewayName,
        gatewayPort: recovery.gatewayPort,
        sandboxName: recovery.sandboxName,
        lifecycleGeneration: recovery.lifecycleGeneration!,
        sandboxIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        createAttemptNonce: recovery.createAttemptNonce,
        route: "none" as const,
      };
      const harness = createDestroyHarness({
        sandboxPresent: false,
        dockerOrphanIds: [bootstrapContainerId],
        dockerRunResult: {
          status: 0,
          stdout: `${bootstrapContainerId}\topenshell\tdefault\tsb-alpha`,
        },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
          pendingCreateIdentity,
        },
        retainedRecoveryRecords: [recovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.dockerRunSpy).toHaveBeenCalledWith(
        ["rm", "-f", bootstrapContainerId],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledWith(recovery);
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it(
    "fails closed and then retires the lone record after recovery authority loss (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const bootstrapContainerId = "b".repeat(64);
      const harness = createDestroyHarness({
        sandboxPresent: false,
        dockerOrphanIds: [bootstrapContainerId],
        dockerRunResult: {
          status: 0,
          stdout: `${bootstrapContainerId}\topenshell\tdefault\tsb-alpha`,
        },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        },
        retainedRecoveryRecords: [recovery],
      });
      harness.resolveRetainedSandboxRecoverySpy
        .mockImplementation(() => {
          harness.setRetainedRecoveryRecords([]);
          return true;
        })
        .mockReturnValueOnce(false);

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledWith(recovery);
      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("local recovery cleanup was not confirmed"),
      );
      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Resolve the recovery record conflict"),
      );
      expect(
        harness.logSpy.mock.calls.some(([message]) =>
          String(message).includes("Sandbox 'alpha' destroyed"),
        ),
      ).toBe(false);
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(exitSpy).toHaveBeenCalledWith(1);

      const exactRemovalCallsAfterFailure = harness.dockerRunSpy.mock.calls.filter(
        ([args]) => Array.isArray(args) && args[0] === "rm" && args[1] === "-f",
      ).length;
      harness.setRegistryEntryPresent(false);
      harness.setSandboxPresent(false);
      harness.setDockerIdentityResult({ status: 0, stdout: "" });
      exitSpy.mockClear();
      harness.logSpy.mockClear();

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledTimes(2);
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenLastCalledWith(recovery);
      expect(
        harness.dockerRunSpy.mock.calls.filter(
          ([args]) => Array.isArray(args) && args[0] === "rm" && args[1] === "-f",
        ),
      ).toHaveLength(exactRemovalCallsAfterFailure);
      expect(
        harness.logSpy.mock.calls.some(([message]) =>
          String(message).includes("Sandbox 'alpha' destroyed"),
        ),
      ).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();

      harness.logSpy.mockClear();
      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledTimes(2);
    },
  );

  it(
    "selects only the retained record matching observed Docker identity without a registry row (#10547)",
    { timeout: 30_000 },
    async () => {
      const matchingRecovery = retainedRecoveryRecord();
      const olderRecovery = {
        ...retainedRecoveryRecord("sb-older"),
        recordId: "e".repeat(64),
        lifecycleGeneration: "generation-older",
      };
      const sandboxContainerId = "a".repeat(64);
      const bootstrapContainerId = "b".repeat(64);
      const identityRows = [sandboxContainerId, bootstrapContainerId]
        .map((id) => `${id}\topenshell\tdefault\tsb-alpha`)
        .join("\n");
      const harness = createDestroyHarness({
        registryEntryPresent: false,
        sandboxPresent: false,
        dockerOrphanIds: [bootstrapContainerId],
        dockerRunResult: { status: 0, stdout: identityRows },
        retainedRecoveryRecords: [olderRecovery, matchingRecovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.dockerRunSpy).toHaveBeenCalledWith(
        ["rm", "-f", bootstrapContainerId],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledOnce();
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledWith(matchingRecovery);
      expect(harness.resolveRetainedSandboxRecoverySpy).not.toHaveBeenCalledWith(olderRecovery);
      expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
        "alpha",
        matchingRecovery.gatewayName,
        harness.runOpenshellSpy,
      );
      expect(harness.gatewayPinsAtSandboxList).toEqual([matchingRecovery.gatewayName]);
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it(
    "refuses destroy when observed Docker identity matches multiple retained records (#10547)",
    { timeout: 30_000 },
    async () => {
      const firstRecovery = retainedRecoveryRecord();
      const secondRecovery = {
        ...firstRecovery,
        recordId: "e".repeat(64),
        lifecycleGeneration: "generation-second",
        createAttemptNonce: "d".repeat(62),
      };
      const harness = createDestroyHarness({
        registryEntryPresent: false,
        dockerRunResult: {
          status: 0,
          stdout: `${"a".repeat(64)}\topenshell\tdefault\tsb-alpha`,
        },
        retainedRecoveryRecords: [firstRecovery, secondRecovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("could not select exactly one recovery record"),
      );
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).not.toHaveBeenCalled();
    },
  );
});
