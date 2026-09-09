// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createOnboardCreatedSandboxRegistration } from "../created-sandbox-finalization";
import {
  createCreatedSandboxLifecycle,
  type SandboxRecreateObservation,
} from "../sandbox-recreate-transaction";
import { createOnboardCreatedSandboxRegistrationWithManagedLifecycle } from "./orchestration";

describe("managed bootstrap sandbox registration", () => {
  const lifecycleGeneration = "generation-1";
  const durableIdentity = "a".repeat(64);
  const recordedRegistration = {
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: durableIdentity,
  };

  function registrationFixture(managedBootstrap: boolean, observation: SandboxRecreateObservation) {
    const publish = vi.fn();
    const runtime = {
      targetGeneration: undefined,
      registrationFields: {},
      recordCreated: vi.fn(),
    } as never;
    const completeRegistration = createOnboardCreatedSandboxRegistrationWithManagedLifecycle({
      sandboxName: "alpha",
      managedBootstrap,
      sandboxGpuEnabled: false,
      createdLifecycle: createCreatedSandboxLifecycle(
        runtime,
        { sandboxName: "alpha", gatewayName: "nemoclaw" },
        () => observation,
        lifecycleGeneration,
      ),
      getRecordedRegistration: () => recordedRegistration,
      createRegistration: createOnboardCreatedSandboxRegistration,
      registration: {
        completion: {
          complete: async (
            _created,
            _configuredReceipt,
            _providerGpuDisposition,
            _manageDashboard,
            resolveLifecycleRegistrationFields,
            lifecycle,
          ) => {
            const verified = lifecycle.revalidate(
              lifecycle.capture(resolveLifecycleRegistrationFields()),
            );
            publish(lifecycle.revalidate(verified));
          },
        },
        cleanupBuildContext: vi.fn(),
        manageDashboard: false,
        sandboxGpuEnabled: false,
      },
    });
    return {
      complete: () =>
        completeRegistration(
          { lifecycleRegistrationFields: { lifecycleGeneration } } as never,
          null,
        ),
      publish,
    };
  }

  it("publishes a managed sandbox when its not Ready identity matches (#10512)", async () => {
    const fixture = registrationFixture(true, {
      state: "not_ready",
      liveIdentityFingerprint: durableIdentity,
    });

    await expect(fixture.complete()).resolves.toBeUndefined();
    expect(fixture.publish).toHaveBeenCalledExactlyOnceWith(recordedRegistration);
  });

  it.each([
    ["ordinary", false, { state: "not_ready" as const, liveIdentityFingerprint: durableIdentity }],
    ["missing", true, { state: "not_ready" as const, liveIdentityFingerprint: null }],
    [
      "malformed",
      true,
      { state: "not_ready" as const, liveIdentityFingerprint: "not-a-fingerprint" },
    ],
    ["changed", true, { state: "not_ready" as const, liveIdentityFingerprint: "b".repeat(64) }],
  ])(
    "does not publish a %s sandbox from an invalid not Ready observation (#10512)",
    async (_case, managedBootstrap, observation) => {
      const fixture = registrationFixture(managedBootstrap, observation);

      await expect(fixture.complete()).rejects.toThrow();
      expect(fixture.publish).not.toHaveBeenCalled();
    },
  );
});
