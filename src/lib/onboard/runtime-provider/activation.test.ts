// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
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
  RUNTIME_PROVIDER_SNAPSHOT_CONTRACT_VERSION,
  RUNTIME_PROVIDER_STATE_MUTATION_CONTRACT_VERSION,
  type RuntimeProviderBundle,
} from "./contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES, createCurrentRuntimeProviderBundles } from "./current";
import type {
  NativeRuntimeQualificationAuthority,
  NativeRuntimeQualificationAuthoritySource,
} from "./native-qualification-authority";

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

function requiredCaseIds(providerId: string): readonly string[] {
  return RUNTIME_PROVIDER_ACTIVATION_AGENTS.flatMap((agent) =>
    RUNTIME_PROVIDER_ACTIVATION_PLATFORMS.flatMap((platform) => {
      const architecture = platform.split("/")[1];
      return RUNTIME_PROVIDER_ACTIVATION_ACCELERATION_MODES.flatMap((acceleration) => {
        const inference =
          acceleration === "cpu"
            ? [RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES[0]]
            : RUNTIME_PROVIDER_ACTIVATION_INFERENCE_SERVICES;
        const accelerationId = acceleration === "nvidia-gpu" ? "gpu" : acceleration;
        return inference.map(
          (service) => `${providerId}-${agent}-linux-${architecture}-${accelerationId}-${service}`,
        );
      });
    }),
  ).sort();
}

function qualificationSource(providerId: string): NativeRuntimeQualificationAuthoritySource {
  return {
    repository: "NVIDIA/NemoClaw",
    producerWorkflow: ".github/workflows/e2e.yaml",
    pullRequestNumber: 8063,
    candidateRepository: "NVIDIA/NemoClaw",
    candidateSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "c".repeat(40),
    workflowSha: "c".repeat(40),
    producerRunId: "101",
    producerRunAttempt: 1,
    dispatchArtifact: {
      id: "202",
      name: "e2e-dispatch-101-1",
      digest: `sha256:${"d".repeat(64)}`,
      sizeInBytes: 4096,
    },
    protectedJobs: requiredCaseIds(providerId).map((caseId, index) => ({
      caseId,
      id: String(1000 + index),
      name: `Native runtime qualification / ${caseId}`,
    })),
  };
}

function qualificationAuthority(
  providerId: string,
  source: NativeRuntimeQualificationAuthoritySource,
): NativeRuntimeQualificationAuthority {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-authority-v1",
    qualificationId: `${providerId}-protected-host-local-inference`,
    providerId,
    source,
  };
}

function unreachable(): never {
  throw new Error("Activation contract fixture operations are not executed.");
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
  const source = qualificationSource(topology.providerId);
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
          ...source,
          dispatchArtifact: { ...source.dispatchArtifact },
          protectedJobs: source.protectedJobs.map((job) => ({ ...job })),
        },
      },
    },
    qualificationAuthority: qualificationAuthority(topology.providerId, source),
    bundle,
  };
}

const INCOMPLETE_SURFACES = [
  "stateMutation",
  "bootstrap",
  "snapshot",
  "recovery",
  "cleanup",
] as const;

function withoutSurface(
  bundle: RuntimeProviderBundle,
  surface: (typeof INCOMPLETE_SURFACES)[number],
): RuntimeProviderBundle {
  const unsupported = {
    providerId: bundle.identity.id,
    supported: false as const,
    reason: "incomplete fixture",
  };
  const transformations: Record<(typeof INCOMPLETE_SURFACES)[number], () => RuntimeProviderBundle> =
    {
      stateMutation: () => ({ ...bundle, stateMutation: unsupported }) as RuntimeProviderBundle,
      bootstrap: () => ({ ...bundle, bootstrap: unsupported }) as RuntimeProviderBundle,
      snapshot: () => ({ ...bundle, snapshot: unsupported }) as RuntimeProviderBundle,
      recovery: () => ({ ...bundle, recovery: unsupported }) as RuntimeProviderBundle,
      cleanup: () => ({
        ...bundle,
        capabilities: { ...bundle.capabilities, workloadImageCleanup: false },
        cleanup: unsupported,
      }),
    };
  return transformations[surface]();
}

describe("runtime provider activation catalog", () => {
  it("registers rootful, rootless, and external socket-free providers through the activation catalog (#9143)", () => {
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
        Object.isFrozen(catalog[providerId]!.qualificationAuthority.source.protectedJobs),
      ),
    ).toEqual([true, true, true]);
    expect(() => {
      (
        catalog[CANDIDATE_TOPOLOGIES[1].providerId]!.qualificationAuthority.source
          .protectedJobs as unknown as unknown[]
      ).push({});
    }).toThrow(TypeError);
  });

  it("keeps production selection limited to Docker and Kubernetes (#9143)", () => {
    expect(Object.keys(CURRENT_RUNTIME_PROVIDER_BUNDLES)).toEqual(["docker", "kubernetes"]);
    expect(Object.keys(createCurrentRuntimeProviderBundles())).toEqual(["docker", "kubernetes"]);
  });

  it.each(INCOMPLETE_SURFACES)(
    "rejects incomplete %s authority before composition (#9143)",
    (surface) => {
      const candidate = CANDIDATE_TOPOLOGIES[1];
      const incomplete = withoutSurface(completeBundle(candidate.providerId), surface);

      expect(() =>
        createRuntimeProviderActivationCatalog([registration(candidate, incomplete)]),
      ).toThrow(`incomplete ${surface} authority`);
    },
  );

  it.each(RUNTIME_PROVIDER_ACTIVATION_ENGINE_SCOPES)(
    "rejects a bundle missing the %s operation scope (#9143)",
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

  it("rejects incomplete host-local inference authority (#9143)", () => {
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

  it("rejects declaration and bundle identity mismatch (#9143)", () => {
    const candidate = CANDIDATE_TOPOLOGIES[1];
    expect(() =>
      createRuntimeProviderActivationCatalog([
        registration(candidate, completeBundle("different-provider")),
      ]),
    ).toThrow("does not match its provider bundle");
  });

  it("rejects a missing authenticated qualification authority (#9143)", () => {
    const candidate = registration();
    const { qualificationAuthority: _authority, ...incomplete } = candidate;

    expect(() =>
      createRuntimeProviderActivationCatalog([
        incomplete as unknown as RuntimeProviderActivationRegistration,
      ]),
    ).toThrow("authenticated qualification authority is required");
  });

  it("rejects qualification authority for a different provider (#9143)", () => {
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

  it.each([
    ["candidate commit", { candidateSha: "e".repeat(40) }],
    ["trusted base and workflow commit", { baseSha: "e".repeat(40), workflowSha: "e".repeat(40) }],
  ])("rejects qualification authority with a different %s (#9143)", (_label, sourceOverride) => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          ...sourceOverride,
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "does not match the required source identity",
    );
  });

  it("rejects qualification authority from a different producer workflow (#9143)", () => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          producerWorkflow: ".github/workflows/untrusted.yaml",
        },
      },
    } as unknown as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "protected repository, producer workflow, pull request, or base ref is invalid",
    );
  });

  it("rejects qualification authority without every protected case job (#9143)", () => {
    const candidate = registration();
    const mismatched = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          protectedJobs: candidate.qualificationAuthority.source.protectedJobs.slice(1),
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([mismatched])).toThrow(
      "does not match the required source identity",
    );
  });

  it("rejects an incomplete protected job requirement and matching authority (#9143)", () => {
    const candidate = registration();
    const protectedJobs = candidate.declaration.qualification.source.protectedJobs.slice(1);
    const incomplete = {
      ...candidate,
      declaration: {
        ...candidate.declaration,
        qualification: {
          ...candidate.declaration.qualification,
          source: { ...candidate.declaration.qualification.source, protectedJobs },
        },
      },
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: { ...candidate.qualificationAuthority.source, protectedJobs },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([incomplete])).toThrow(
      "required qualification protected jobs must be",
    );
  });

  it("rejects a noncanonical protected job name (#9143)", () => {
    const candidate = registration();
    const first = candidate.qualificationAuthority.source.protectedJobs[0]!;
    const invalid = {
      ...candidate,
      qualificationAuthority: {
        ...candidate.qualificationAuthority,
        source: {
          ...candidate.qualificationAuthority.source,
          protectedJobs: [
            { ...first, name: `Untrusted / ${first.caseId}` },
            ...candidate.qualificationAuthority.source.protectedJobs.slice(1),
          ],
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([invalid])).toThrow(
      "protected job identity is invalid",
    );
  });

  it("rejects a candidate that matches the trusted workflow revision (#9143)", () => {
    const candidate = registration();
    const workflowSha = candidate.declaration.qualification.source.workflowSha;
    const invalid = {
      ...candidate,
      declaration: {
        ...candidate.declaration,
        qualification: {
          ...candidate.declaration.qualification,
          source: { ...candidate.declaration.qualification.source, candidateSha: workflowSha },
        },
      },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([invalid])).toThrow(
      "must separate the candidate from the trusted target-branch base",
    );
  });

  it("rejects a target base that differs from the trusted workflow revision (#9143)", () => {
    const candidate = registration();
    const source = {
      ...candidate.declaration.qualification.source,
      baseSha: "b".repeat(40),
    };
    const invalid = {
      ...candidate,
      declaration: {
        ...candidate.declaration,
        qualification: { ...candidate.declaration.qualification, source },
      },
      qualificationAuthority: { ...candidate.qualificationAuthority, source },
    } as RuntimeProviderActivationRegistration;

    expect(() => createRuntimeProviderActivationCatalog([invalid])).toThrow(
      "must separate the candidate from the trusted target-branch base",
    );
  });

  it("rejects duplicate activation identities (#9143)", () => {
    expect(() => createRuntimeProviderActivationCatalog([registration(), registration()])).toThrow(
      "duplicate provider identity",
    );
  });

  it("rejects an activation that shadows a production provider (#9143)", () => {
    const candidate = registration({
      providerId: "docker",
      hostAuthority: "rootful",
      transport: "operation-scoped",
    });
    expect(() => createCurrentRuntimeProviderBundles([candidate])).toThrow(
      "already production-selectable",
    );
  });
});
