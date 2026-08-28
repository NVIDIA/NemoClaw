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
    verifiedEffectivePolicyIdentity: null,
    createAttemptNonce: "c".repeat(62),
    policyCreationReceipt: null,
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
    "removes every container from one retained failed attempt and clears recovery (#10547)",
    { timeout: 30_000 },
    async () => {
      const recovery = retainedRecoveryRecord();
      const sandboxContainerId = "a".repeat(64);
      const bootstrapContainerId = "b".repeat(64);
      const identityRows = [sandboxContainerId, bootstrapContainerId]
        .map((id) => `${id}\topenshell\tdefault\tsb-alpha`)
        .join("\n");
      const harness = createDestroyHarness({
        dockerOrphanIds: [bootstrapContainerId],
        dockerRunResult: { status: 0, stdout: identityRows },
        registryEntryOverrides: {
          lifecycleGeneration: recovery.lifecycleGeneration!,
          lifecycleLiveIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        },
        retainedRecoveryRecords: [recovery],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.dockerRunSpy).toHaveBeenCalledWith(
        ["rm", "-f", bootstrapContainerId],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledWith(recovery);
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
      expect(exitSpy).not.toHaveBeenCalled();
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
        expect.stringContaining("Docker exposed no container with the retained immutable identity"),
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
      const pendingPolicyVerification = {
        schemaVersion: 1 as const,
        state: "verified-create" as const,
        policyAuthority: "externally-managed" as const,
        observedPolicyAuthority: "externally-managed" as const,
        gatewayName: recovery.gatewayName,
        gatewayPort: recovery.gatewayPort,
        sandboxName: recovery.sandboxName,
        lifecycleGeneration: recovery.lifecycleGeneration!,
        sandboxIdentityFingerprint: recovery.sandboxIdentityFingerprint!,
        createAttemptNonce: recovery.createAttemptNonce,
        route: "none" as const,
        policyHash: "policy-hash",
        policyVersion: 1,
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
          pendingPolicyVerification,
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
});
