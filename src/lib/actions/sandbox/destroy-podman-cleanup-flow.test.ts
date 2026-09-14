// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

const absentPodmanIdentity = {
  schemaVersion: 1 as const,
  providerId: "podman",
  resourceHandle: null,
  ownershipSha256: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  resetDestroyModuleCache();
});

it("passes registered Podman authority through final gateway cleanup", async () => {
  const harness = createDestroyHarness({
    openshellDriver: "podman",
    runtimeProviderIdentityProof: absentPodmanIdentity,
    executeSandboxDestroyResult: {
      ok: true,
      alreadyGone: false,
      deleteOutput: "",
      deleteResult: { status: 0, stdout: "", stderr: "" },
      detachOutcome: { detached: [], failures: [] },
      forcedLocalCleanup: false,
    },
  });

  await expect(
    harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
  ).resolves.toBeUndefined();

  expect(harness.resolveGatewayRuntimeProviderIdSpy).toHaveBeenCalledWith(
    "nemoclaw-19080",
    "podman",
  );
  expect(harness.assertDestroyIdentitySpy).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({ providerId: "podman" }),
  );
  expect(harness.shouldCleanupGatewaySpy).toHaveBeenCalledWith(
    expect.objectContaining({ runtimeProviderId: "podman" }),
    {},
  );
  expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith(
    "nemoclaw-19080",
    harness.runOpenshellSpy,
    { runtimeProviderId: "podman" },
  );
  expect(harness.dockerCaptureSpy).not.toHaveBeenCalled();
});

it("recovers Podman authority when final cleanup is retried after registry removal", async () => {
  const harness = createDestroyHarness({
    registryEntryPresent: false,
    removeSandboxResult: false,
    recoveredGatewayRuntimeProviderId: "podman",
    runtimeProviderIdentityProof: absentPodmanIdentity,
    sandboxPresent: false,
    executeSandboxDestroyResult: {
      ok: true,
      alreadyGone: true,
      deleteOutput: "sandbox not found",
      deleteResult: { status: 1, stdout: "", stderr: "sandbox not found" },
      detachOutcome: { detached: [], failures: [] },
      forcedLocalCleanup: false,
    },
  });

  await expect(
    harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
  ).resolves.toBeUndefined();

  expect(harness.resolveGatewayRuntimeProviderIdSpy).toHaveBeenCalledWith("nemoclaw", undefined);
  expect(harness.assertDestroyIdentitySpy).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({ providerId: "podman", sandbox: null }),
  );
  expect(harness.shouldCleanupGatewaySpy).toHaveBeenCalledWith(
    expect.objectContaining({ removedRegistryEntry: true, runtimeProviderId: "podman" }),
    {},
  );
  expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith("nemoclaw", harness.runOpenshellSpy, {
    runtimeProviderId: "podman",
  });
  expect(harness.dockerCaptureSpy).not.toHaveBeenCalled();
});
