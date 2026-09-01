// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type {
  RuntimeProviderBundle,
  RuntimeProviderNativeArtifactBootstrapInput,
  RuntimeProviderNativeArtifactBootstrapResult,
} from "./contract";
import {
  recoverInactiveNativeArtifactOnboarding,
  runInactiveNativeArtifactOnboarding,
} from "./native-artifact-onboarding";

const WORKLOAD = nativeArtifactWorkloadReceiptFixture(
  encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
);

const READY_RESULT: RuntimeProviderNativeArtifactBootstrapResult = Object.freeze({
  outcome: "ready",
  reason: null,
  authoritySha256: "a".repeat(64),
  providerHandle: `future-native:${"b".repeat(64)}`,
  sandboxName: "alpha",
  lifecycleGeneration: "generation-1",
  resourceState: "active",
  cleanup: {
    attempted: false,
    resourceRemovalAuthorized: false,
    removed: false,
  },
  recoveryRequired: false,
});

function bootstrapInput() {
  return {
    sandboxName: "alpha",
    lifecycleGeneration: "generation-1",
    driveRoot: "C:\\",
    artifactRoot: "C:\\openclaw-artifact",
    workload: WORKLOAD,
  } as const;
}

function providerFixture(
  input: {
    readonly acceptsWorkload?: boolean;
    readonly bootstrapProviderId?: string;
  } = {},
) {
  const providerId = "future-native";
  const run = vi.fn(async (_value: RuntimeProviderNativeArtifactBootstrapInput) => READY_RESULT);
  const recover = vi.fn(async (_value: RuntimeProviderNativeArtifactBootstrapInput) => ({
    ...READY_RESULT,
    outcome: "not-created" as const,
    reason: "recovered" as const,
    resourceState: "absent" as const,
  }));
  const provider = {
    identity: { id: providerId },
    plan: { providerId, supported: true, gatewayLauncher: "openshell" },
    workload: {
      providerId,
      supported: true,
      acceptsReceipt: vi.fn(() => input.acceptsWorkload !== false),
    },
    bootstrap: {
      providerId: input.bootstrapProviderId ?? providerId,
      supported: true,
      bootstrapKind: "native-artifact",
      contractVersion: 1,
      run,
      recover,
    },
  } as unknown as RuntimeProviderBundle;
  return { provider, recover, run };
}

describe("inactive provider-neutral native-artifact onboarding", () => {
  it("uses the qualified provider identity without registering it (#8178)", async () => {
    const { provider, run } = providerFixture();

    const result = await runInactiveNativeArtifactOnboarding({
      provider,
      bootstrap: bootstrapInput(),
    });

    expect(result.computePlan).toEqual({
      driverName: "future-native",
      gatewayLauncher: "openshell",
    });
    expect(result.bootstrapResult).toBe(READY_RESULT);
    expect(run).toHaveBeenCalledWith({
      ...bootstrapInput(),
      providerId: "future-native",
    });
  });

  it("rejects an unaccepted workload before bootstrap (#8178)", async () => {
    const { provider, run } = providerFixture({ acceptsWorkload: false });

    await expect(
      runInactiveNativeArtifactOnboarding({ provider, bootstrap: bootstrapInput() }),
    ).rejects.toThrow(/does not match the provider workload contract/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects bootstrap identity drift before bootstrap (#8178)", async () => {
    const { provider, run } = providerFixture({ bootstrapProviderId: "other-provider" });

    await expect(
      runInactiveNativeArtifactOnboarding({ provider, bootstrap: bootstrapInput() }),
    ).rejects.toThrow(/identity-consistent native-artifact bootstrap contract/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("routes recovery through the same qualified provider (#8178)", async () => {
    const { provider, recover, run } = providerFixture();

    const result = await recoverInactiveNativeArtifactOnboarding({
      provider,
      bootstrap: bootstrapInput(),
    });

    expect(result.bootstrapResult).toMatchObject({
      outcome: "not-created",
      reason: "recovered",
      resourceState: "absent",
    });
    expect(recover).toHaveBeenCalledWith({
      ...bootstrapInput(),
      providerId: "future-native",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
