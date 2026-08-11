// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "../managed-image/contract";
import {
  composeActivatedRuntimeProviderBundles,
  createRuntimeProviderActivationCatalog,
  RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES,
  RUNTIME_PROVIDER_ACTIVATION_AGENTS,
  RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
  RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
  RUNTIME_PROVIDER_ACTIVATION_JOURNEYS,
  RUNTIME_PROVIDER_ACTIVATION_PLATFORMS,
  RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES,
  type RuntimeProviderActivationRegistration,
} from "./activation";
import { RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION, type RuntimeProviderBundle } from "./contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES, createCurrentRuntimeProviderBundles } from "./current";
import type { HostLocalInferenceRuntime } from "./host-local-inference";

const PROVIDER_ID = "mxc";

function unreachable(): never {
  throw new Error("Activation fixture operation is not executed by this contract test.");
}

function inferenceRuntime(): HostLocalInferenceRuntime {
  return {
    providerId: PROVIDER_ID,
    authorityId: "mxc:contract-test",
    services: [...RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES],
    translateContainerArgs: (args) => [...args],
    qualifyOllama: unreachable,
    startManaged: unreachable,
    inspectManaged: unreachable,
    stopManaged: unreachable,
    preserveForRebuild: unreachable,
  };
}

function completeBundle(): RuntimeProviderBundle {
  const base = createInMemoryRuntimeProviderBundle({
    providerId: PROVIDER_ID,
    workloadProfile: {
      support: {
        exactDigestReferences: true,
        platforms: [...RUNTIME_PROVIDER_ACTIVATION_PLATFORMS],
        startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
        capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
      },
      hostArchitectures: ["amd64", "arm64"],
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
    },
    hostLocalInferenceRuntime: inferenceRuntime(),
  });
  return {
    ...base,
    bootstrap: {
      providerId: PROVIDER_ID,
      supported: true,
      createLifecycle: unreachable,
      createOnboardRouting: unreachable,
    },
    snapshot: {
      providerId: PROVIDER_ID,
      supported: true,
      contractVersion: RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
      capabilities: { backup: true, restore: true, managedProfileRestore: true },
      preflight: unreachable,
      capture: unreachable,
      validateRestore: unreachable,
      restore: unreachable,
    },
    recovery: {
      providerId: PROVIDER_ID,
      supported: true,
      recover: () => ({ exitCode: 0 }),
    },
  };
}

function registration(
  bundle: RuntimeProviderBundle = completeBundle(),
): RuntimeProviderActivationRegistration {
  return {
    declaration: {
      contractVersion: RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
      providerId: PROVIDER_ID,
      agents: [...RUNTIME_PROVIDER_ACTIVATION_AGENTS],
      platforms: [...RUNTIME_PROVIDER_ACTIVATION_PLATFORMS],
      rootModes: [...RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES],
      accelerationModes: [...RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES],
      hostLocalInferenceServices: [...RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES],
      journeys: [...RUNTIME_PROVIDER_ACTIVATION_JOURNEYS],
      installer: { releaseInstaller: true, dockerUnavailable: true },
      qualification: { protectedE2e: true, exactHeadAndBase: true },
    },
    bundle,
  };
}

describe("runtime provider activation catalog", () => {
  it("composes a socket-free provider through the production activation seam", () => {
    const catalog = createRuntimeProviderActivationCatalog([registration()]);
    const providers = createCurrentRuntimeProviderBundles([registration()]);

    expect(Object.keys(catalog)).toEqual([PROVIDER_ID]);
    expect(Object.keys(providers)).toEqual(["docker", "kubernetes", PROVIDER_ID]);
    expect(providers[PROVIDER_ID]).toMatchObject({
      identity: { id: PROVIDER_ID },
      bootstrap: { supported: true },
      snapshot: { supported: true },
      recovery: { supported: true },
      cleanup: { supported: true },
    });
    expect(Object.isFrozen(catalog[PROVIDER_ID]?.declaration.agents)).toBe(true);
    expect(Object.isFrozen(providers[PROVIDER_ID])).toBe(true);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty(PROVIDER_ID);
  });

  it.each([
    "bootstrap",
    "snapshot",
    "recovery",
    "cleanup",
  ] as const)("rejects incomplete %s authority before composition", (surface) => {
    const bundle = completeBundle();
    const incomplete = {
      ...bundle,
      ...(surface === "cleanup"
        ? {
            capabilities: {
              ...bundle.capabilities,
              workloadImageCleanup: false,
            },
          }
        : {}),
      [surface]: {
        providerId: PROVIDER_ID,
        supported: false,
        reason: "incomplete fixture",
      },
    } as RuntimeProviderBundle;

    expect(() => createRuntimeProviderActivationCatalog([registration(incomplete)])).toThrow(
      `incomplete ${surface} authority`,
    );
  });

  it("rejects a partial supported surface before composition", () => {
    const bundle = completeBundle();
    const incomplete = {
      ...bundle,
      mutationAuthority: {
        ...bundle.mutationAuthority,
        operations: ["registration", "start", "stop"],
      },
    } as RuntimeProviderBundle;

    expect(() => createRuntimeProviderActivationCatalog([registration(incomplete)])).toThrow(
      "mutation authority must be exactly",
    );
  });

  it.each([
    "host-doctor",
    "host-local-inference",
    "sandbox-lifecycle",
    "workload-cleanup",
  ] as const)("rejects a bundle missing the %s container-engine scope", (operation) => {
    const bundle = completeBundle();
    expect(bundle.containerEngine.supported).toBe(true);
    const containerEngine = bundle.containerEngine as Extract<
      RuntimeProviderBundle["containerEngine"],
      { supported: true }
    >;
    const incomplete = {
      ...bundle,
      containerEngine: {
        ...containerEngine,
        identities: containerEngine.identities.filter(
          (identity) => identity.operation !== operation,
        ),
      },
    } as RuntimeProviderBundle;

    expect(() => createRuntimeProviderActivationCatalog([registration(incomplete)])).toThrow(
      `missing the '${operation}' engine scope`,
    );
  });

  it("rejects requirement drift instead of silently shrinking qualification", () => {
    const candidate = registration();
    const drifted = {
      ...candidate,
      declaration: {
        ...candidate.declaration,
        platforms: ["linux/amd64"],
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([drifted])).toThrow(
      "platforms must be exactly 'linux/amd64,linux/arm64'",
    );
  });

  it("rejects duplicate base and activation identities", () => {
    const base = composeActivatedRuntimeProviderBundles({}, [registration()]);
    expect(() => composeActivatedRuntimeProviderBundles(base, [registration()])).toThrow(
      "already production-selectable",
    );
  });
});
