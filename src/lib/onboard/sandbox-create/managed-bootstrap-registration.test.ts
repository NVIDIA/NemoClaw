// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { PendingSandboxCreateIdentity } from "../../state/registry";
import { createOnboardCreatedSandboxRegistration } from "../created-sandbox-finalization";
import {
  createCreatedSandboxLifecycle,
  type SandboxRecreateObservation,
} from "../sandbox-recreate-transaction";
import {
  createOnboardCreatedSandboxRegistrationWithManagedLifecycle,
  persistExactFinalHandoffAcknowledgement,
} from "./orchestration";

describe("managed bootstrap sandbox registration", () => {
  const lifecycleGeneration = "generation-1";
  const durableIdentity = "a".repeat(64);
  const recordedRegistration = {
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: durableIdentity,
  };

  function registrationFixture(
    managedBootstrap: boolean,
    observation: SandboxRecreateObservation,
    persistedFinalHandoffAcknowledged = false,
  ) {
    const publish = vi.fn();
    const runtime = {
      targetGeneration: undefined,
      registrationFields: {},
      recordCreated: vi.fn(),
    } as never;
    const completeRegistration = createOnboardCreatedSandboxRegistrationWithManagedLifecycle({
      sandboxName: "alpha",
      managedBootstrap,
      allowNotReadyWithMatchingIdentity: () => persistedFinalHandoffAcknowledged,
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

  it("publishes an explicitly recreated sandbox after its exact final handoff (#10560)", async () => {
    let checkpoint: PendingSandboxCreateIdentity = {
      schemaVersion: 1 as const,
      state: "verified-create" as const,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration,
      sandboxIdentityFingerprint: durableIdentity,
      route: "compatibility" as const,
    };
    const persist = vi.fn((acknowledged: PendingSandboxCreateIdentity) => {
      checkpoint = acknowledged;
    });
    checkpoint = persistExactFinalHandoffAcknowledgement({
      runtimePatch: { allowsNotReadyLifecycleRevalidation: () => true } as never,
      checkpoint,
      persist,
    });
    const fixture = registrationFixture(
      false,
      { state: "not_ready", liveIdentityFingerprint: durableIdentity },
      checkpoint.exactFinalHandoffAcknowledged === true,
    );

    await expect(fixture.complete()).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
    expect(fixture.publish).toHaveBeenCalledExactlyOnceWith(recordedRegistration);
  });

  it("does not publish a resumed recreation without a persisted final handoff (#10560)", async () => {
    const checkpoint: PendingSandboxCreateIdentity = {
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration,
      sandboxIdentityFingerprint: durableIdentity,
      route: "compatibility",
    };
    const persist = vi.fn();
    expect(
      persistExactFinalHandoffAcknowledgement({
        runtimePatch: { allowsNotReadyLifecycleRevalidation: () => false } as never,
        checkpoint,
        persist,
      }),
    ).toBe(checkpoint);
    const fixture = registrationFixture(false, {
      state: "not_ready",
      liveIdentityFingerprint: durableIdentity,
    });

    await expect(fixture.complete()).rejects.toThrow(/not report it Ready/u);
    expect(persist).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
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

  it("rejects an identity change after an exact final handoff (#10560)", async () => {
    const fixture = registrationFixture(
      false,
      { state: "not_ready", liveIdentityFingerprint: "b".repeat(64) },
      true,
    );

    await expect(fixture.complete()).rejects.toThrow(/identity changed/u);
    expect(fixture.publish).not.toHaveBeenCalled();
  });
});
