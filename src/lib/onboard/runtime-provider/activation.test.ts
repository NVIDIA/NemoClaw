// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  compileNativeRuntimeQualification,
  consumeNativeRuntimeQualificationEvidence,
  nativeRuntimeQualificationDefinition,
  type NativeRuntimeQualificationAuthority,
} from "../../../../test/e2e/registry/native-runtime-qualification";
import {
  nativeQualificationEvidenceForDefinition,
  nativeQualificationExpectedSource,
  nativeQualificationReceiptReader,
} from "../../../../test/helpers/native-runtime-qualification-evidence";
import { createInMemoryRuntimeProviderBundle } from "../../../../test/helpers/runtime-provider-bundle";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "../managed-image/contract";
import {
  createRuntimeProviderActivationCatalog,
  RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES,
  RUNTIME_PROVIDER_ACTIVATION_AGENTS,
  RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
  RUNTIME_PROVIDER_ACTIVATION_ENGINE_SCOPES,
  RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES,
  RUNTIME_PROVIDER_ACTIVATION_JOURNEYS,
  RUNTIME_PROVIDER_ACTIVATION_PLATFORMS,
  RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES,
  type RuntimeProviderActivationHostAuthority,
  type RuntimeProviderActivationRegistration,
  type RuntimeProviderActivationTransport,
} from "./activation";
import {
  RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION,
  RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
  RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
  type RuntimeProviderBundle,
} from "./contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES, createCurrentRuntimeProviderBundles } from "./current";

type CandidateTopology = {
  readonly providerId: string;
  readonly hostAuthority: RuntimeProviderActivationHostAuthority;
  readonly transport: RuntimeProviderActivationTransport;
};

const CANDIDATE_TOPOLOGIES = [
  {
    providerId: "podman-rootful-contract",
    hostAuthority: "rootful",
    transport: "operation-scoped",
  },
  {
    providerId: "podman-rootless-contract",
    hostAuthority: "rootless",
    transport: "operation-scoped",
  },
  {
    providerId: "mxc-style-contract",
    hostAuthority: "external",
    transport: "socket-free",
  },
] as const satisfies readonly CandidateTopology[];

const QUALIFICATION_AUTHORITIES = new Map<string, NativeRuntimeQualificationAuthority>();

function createQualificationAuthority(providerId: string): NativeRuntimeQualificationAuthority {
  const qualification = compileNativeRuntimeQualification(
    nativeRuntimeQualificationDefinition(providerId),
  );
  const authority = consumeNativeRuntimeQualificationEvidence(
    qualification,
    nativeQualificationEvidenceForDefinition(qualification),
    nativeQualificationExpectedSource(),
    nativeQualificationReceiptReader,
  );
  QUALIFICATION_AUTHORITIES.set(providerId, authority);
  return authority;
}

function qualificationAuthority(providerId: string): NativeRuntimeQualificationAuthority {
  return QUALIFICATION_AUTHORITIES.get(providerId) ?? createQualificationAuthority(providerId);
}

function unreachable(): never {
  throw new Error("Activation contract fixture operations are never executed.");
}

function completeBundle(providerId: string): RuntimeProviderBundle {
  const base = createInMemoryRuntimeProviderBundle({
    providerId,
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
    hostLocalInference: {
      services: [...RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES],
      createOperation: unreachable,
    },
  });
  return {
    ...base,
    stateMutation: {
      providerId,
      supported: true,
      contractVersion: RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
      acquire: unreachable,
      assertFenced: unreachable,
      publish: unreachable,
      rollback: unreachable,
      activate: unreachable,
      release: unreachable,
      recover: unreachable,
    },
    bootstrap: {
      providerId,
      supported: true,
      bootstrapKind: "managed-image",
      createAuthorityStore: unreachable,
      createLifecycle: unreachable,
      createOnboardRouting: unreachable,
    },
    snapshot: {
      providerId,
      supported: true,
      contractVersion: RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
      capabilities: { backup: true, restore: true, managedProfileRestore: true },
      preflight: unreachable,
      capture: unreachable,
      validateRestore: unreachable,
      restore: unreachable,
    },
    recovery: {
      providerId,
      supported: true,
      recover: () => ({ exitCode: 0 }),
    },
    containerEngine: {
      providerId,
      supported: true,
      identities: RUNTIME_PROVIDER_ACTIVATION_ENGINE_SCOPES.map((operation) => ({
        operation,
        engineId: "contract-fixture",
        displayName: "Contract fixture",
      })),
    },
  };
}

function registration(
  topology: CandidateTopology = CANDIDATE_TOPOLOGIES[1],
  bundle: RuntimeProviderBundle = completeBundle(topology.providerId),
): RuntimeProviderActivationRegistration {
  const requiredSource = nativeQualificationExpectedSource();
  const authority = qualificationAuthority(topology.providerId);
  return {
    declaration: {
      contractVersion: RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
      providerId: topology.providerId,
      topology: {
        hostAuthority: topology.hostAuthority,
        transport: topology.transport,
      },
      agents: [...RUNTIME_PROVIDER_ACTIVATION_AGENTS],
      platforms: [...RUNTIME_PROVIDER_ACTIVATION_PLATFORMS],
      qualificationRootModes: [...RUNTIME_PROVIDER_ACTIVATION_ROOT_MODES],
      accelerationModes: [...RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES],
      hostLocalInferenceServices: [...RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES],
      journeys: [...RUNTIME_PROVIDER_ACTIVATION_JOURNEYS],
      installer: { releaseInstaller: true, dockerUnavailable: true },
      qualification: {
        qualificationId: `${topology.providerId}-protected-host-local-inference`,
        source: {
          ...requiredSource,
          artifact: { ...requiredSource.artifact },
        },
      },
    },
    qualificationAuthority: authority,
    bundle,
  };
}

const INCOMPLETE_SURFACES = [
  [
    "stateMutation",
    (bundle: RuntimeProviderBundle) => ({
      ...bundle,
      stateMutation: {
        providerId: bundle.identity.id,
        supported: false as const,
        reason: "incomplete fixture",
      },
    }),
  ],
  [
    "bootstrap",
    (bundle: RuntimeProviderBundle) => ({
      ...bundle,
      bootstrap: {
        providerId: bundle.identity.id,
        supported: false as const,
        reason: "incomplete fixture",
      },
    }),
  ],
  [
    "snapshot",
    (bundle: RuntimeProviderBundle) => ({
      ...bundle,
      snapshot: {
        providerId: bundle.identity.id,
        supported: false as const,
        reason: "incomplete fixture",
      },
    }),
  ],
  [
    "recovery",
    (bundle: RuntimeProviderBundle) => ({
      ...bundle,
      recovery: {
        providerId: bundle.identity.id,
        supported: false as const,
        reason: "incomplete fixture",
      },
    }),
  ],
  [
    "cleanup",
    (bundle: RuntimeProviderBundle) => ({
      ...bundle,
      capabilities: { ...bundle.capabilities, workloadImageCleanup: false },
      cleanup: {
        providerId: bundle.identity.id,
        supported: false as const,
        reason: "incomplete fixture",
      },
    }),
  ],
] as const;

describe("runtime provider activation catalog", () => {
  it("composes rootful, rootless, and external socket-free topologies through one seam", () => {
    const registrations = CANDIDATE_TOPOLOGIES.map((topology) => registration(topology));
    const catalog = createRuntimeProviderActivationCatalog(registrations);
    const providers = createCurrentRuntimeProviderBundles(registrations);

    expect(Object.keys(catalog)).toEqual(CANDIDATE_TOPOLOGIES.map(({ providerId }) => providerId));
    expect(Object.keys(providers)).toEqual([
      "docker",
      "kubernetes",
      ...CANDIDATE_TOPOLOGIES.map(({ providerId }) => providerId),
    ]);
    expect(
      CANDIDATE_TOPOLOGIES.map(({ providerId }) => providers[providerId]?.identity.id),
    ).toEqual(CANDIDATE_TOPOLOGIES.map(({ providerId }) => providerId));
    expect(
      CANDIDATE_TOPOLOGIES.map(({ providerId }) =>
        Object.isFrozen(catalog[providerId]?.declaration.topology),
      ),
    ).toEqual([true, true, true]);
    expect(
      CANDIDATE_TOPOLOGIES.map(({ providerId }) =>
        Object.isFrozen(catalog[providerId]?.qualificationAuthority.source.artifact),
      ),
    ).toEqual([true, true, true]);
  });

  it("leaves Docker and Kubernetes unchanged with no production candidate registration", () => {
    expect(Object.keys(CURRENT_RUNTIME_PROVIDER_BUNDLES)).toEqual(["docker", "kubernetes"]);
    expect(Object.keys(createCurrentRuntimeProviderBundles())).toEqual(["docker", "kubernetes"]);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("podman");
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("mxc");
  });

  it("rejects native-artifact bootstrap from production activation (#8178)", () => {
    const candidate = CANDIDATE_TOPOLOGIES[2];
    const complete = completeBundle(candidate.providerId);
    const inactive = {
      ...complete,
      bootstrap: {
        providerId: candidate.providerId,
        supported: true,
        bootstrapKind: "native-artifact",
        contractVersion: RUNTIME_PROVIDER_NATIVE_ARTIFACT_BOOTSTRAP_CONTRACT_VERSION,
        run: unreachable,
      },
    } as RuntimeProviderBundle;

    expect(() =>
      createRuntimeProviderActivationCatalog([registration(candidate, inactive)]),
    ).toThrow("does not provide managed-image bootstrap authority");
  });

  it.each(INCOMPLETE_SURFACES)(
    "rejects incomplete %s authority before composition",
    (surface, makeIncomplete) => {
      const candidate = CANDIDATE_TOPOLOGIES[1];
      const incomplete = makeIncomplete(completeBundle(candidate.providerId));

      expect(() =>
        createRuntimeProviderActivationCatalog([registration(candidate, incomplete)]),
      ).toThrow(`incomplete ${surface} authority`);
    },
  );

  it.each(RUNTIME_PROVIDER_ACTIVATION_ENGINE_SCOPES)(
    "rejects a bundle missing the %s operation scope",
    (operation) => {
      const candidate = CANDIDATE_TOPOLOGIES[1];
      const bundle = completeBundle(candidate.providerId);
      const containerEngine = bundle.containerEngine as Extract<
        RuntimeProviderBundle["containerEngine"],
        { readonly supported: true }
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

      expect(() =>
        createRuntimeProviderActivationCatalog([registration(candidate, incomplete)]),
      ).toThrow(`missing: ${operation}`);
    },
  );

  it("rejects incomplete host-local inference authority", () => {
    const candidate = CANDIDATE_TOPOLOGIES[1];
    const bundle = completeBundle(candidate.providerId);
    const incomplete = {
      ...bundle,
      capabilities: { ...bundle.capabilities, hostLocalInference: false },
      hostLocalInference: {
        providerId: candidate.providerId,
        supported: false,
        reason: "incomplete fixture",
      },
    } as RuntimeProviderBundle;

    expect(() =>
      createRuntimeProviderActivationCatalog([registration(candidate, incomplete)]),
    ).toThrow("incomplete hostLocalInference authority");
  });

  it("rejects declaration and bundle identity mismatch", () => {
    const candidate = CANDIDATE_TOPOLOGIES[1];
    const mismatched = completeBundle("different-provider");

    expect(() =>
      createRuntimeProviderActivationCatalog([registration(candidate, mismatched)]),
    ).toThrow("does not match");
  });

  it("rejects a missing validated qualification authority", () => {
    const candidate = registration();
    const { qualificationAuthority: _authority, ...incomplete } = candidate;

    expect(() =>
      createRuntimeProviderActivationCatalog([
        incomplete as unknown as RuntimeProviderActivationRegistration,
      ]),
    ).toThrow("validated qualification authority is required");
  });

  it("rejects qualification authority for a different provider", () => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        providerId: "different-provider",
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "does not match provider",
    );
  });

  it("rejects qualification authority for a different candidate commit", () => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          headSha: "c".repeat(40),
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "does not match the required source identity",
    );
  });

  it("rejects qualification authority from a different producer workflow", () => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          workflow: ".github/workflows/untrusted-native-qualification.yaml",
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "must bind the protected qualification repository and producer workflow",
    );
  });

  it("rejects qualification authority from a different candidate repository", () => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          candidateRepository: "different/NemoClaw",
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "must bind the protected qualification repository and producer workflow",
    );
  });
});
