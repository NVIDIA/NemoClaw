// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract";
import { validateManagedImageCohort } from "../../../tools/e2e/managed-image-cohort-contract.mts";

const REVISION = "a".repeat(40);
const RUN_ID = 32707920950;
const RUN_ATTEMPT = 1;
const COHORT = `ghrun-${RUN_ID}-${RUN_ATTEMPT}`;
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
type JsonObject = Record<string, unknown>;
type PlatformPublication = {
  publicationEvidence: {
    workloadDescriptor: JsonObject;
    attestations: {
      manifestDescriptor: { annotations: JsonObject };
      slsa: { statement: { bindings: JsonObject; subject: JsonObject } };
      spdx: { statement: { subject: JsonObject } };
    };
  };
};

function digest(index: number): `sha256:${string}` {
  return `sha256:${(index % 15).toString(16).repeat(64)}`;
}

function cohortContract(): Record<string, unknown> {
  return {
    contractVersion: 2,
    cohort: COHORT,
    source: { repository: "NVIDIA/NemoClaw", revision: REVISION, release: null },
    run: { id: RUN_ID, attempt: RUN_ATTEMPT },
    platforms: PLATFORMS,
    agents: Object.fromEntries(
      SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, agentIndex) => {
        const image = MANAGED_IMAGE_REPOSITORIES[agent];
        const manifestDigest = digest(agentIndex + 1);
        return [
          agent,
          {
            image,
            digest: manifestDigest,
            reference: `${image}@${manifestDigest}`,
            descriptor: { digest: manifestDigest },
            alias: `${image}:cohort-${COHORT}`,
            platforms: Object.fromEntries(
              PLATFORMS.map((platform, platformIndex) => {
                const platformDigest = digest(agentIndex + platformIndex + 4);
                const workloadDigest = digest(agentIndex + platformIndex + 10);
                const baseReference = `ghcr.io/nvidia/nemoclaw/base@${digest(agentIndex + platformIndex + 7)}`;
                const [os, architecture] = platform.split("/");
                return [
                  platform,
                  {
                    digest: platformDigest,
                    reference: `${image}@${platformDigest}`,
                    baseReference,
                    publicationEvidence: {
                      candidateDescriptor: {
                        digest: platformDigest,
                        mediaType: "application/vnd.oci.image.index.v1+json",
                        size: 100,
                      },
                      workloadDescriptor: {
                        digest: workloadDigest,
                        mediaType: "application/vnd.oci.image.manifest.v1+json",
                        platform: { os, architecture },
                        size: 200,
                      },
                      attestations: {
                        manifestDescriptor: {
                          annotations: {
                            "vnd.docker.reference.digest": workloadDigest,
                            "vnd.docker.reference.type": "attestation-manifest",
                          },
                          digest: digest(agentIndex + platformIndex + 12),
                          mediaType: "application/vnd.oci.image.manifest.v1+json",
                          platform: { os: "unknown", architecture: "unknown" },
                          size: 300,
                        },
                        slsa: {
                          descriptor: {
                            annotations: {
                              "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1",
                            },
                            digest: digest(agentIndex + platformIndex + 13),
                            mediaType: "application/vnd.in-toto+json",
                            size: 400,
                          },
                          statement: {
                            type: "https://in-toto.io/Statement/v1",
                            predicateType: "https://slsa.dev/provenance/v1",
                            buildType:
                              "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
                            builderId: `https://github.com/NVIDIA/NemoClaw/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`,
                            subject: { name: image, digest: workloadDigest },
                            bindings: {
                              agent,
                              baseReference,
                              cohort: COHORT,
                              platform,
                              revision: REVISION,
                              source: "https://github.com/NVIDIA/NemoClaw",
                            },
                          },
                        },
                        spdx: {
                          descriptor: {
                            annotations: {
                              "in-toto.io/predicate-type": "https://spdx.dev/Document",
                            },
                            digest: digest(agentIndex + platformIndex + 14),
                            mediaType: "application/vnd.in-toto+json",
                            size: 500,
                          },
                          statement: {
                            type: "https://in-toto.io/Statement/v1",
                            predicateType: "https://spdx.dev/Document",
                            subject: { name: image, digest: workloadDigest },
                          },
                        },
                      },
                    },
                  },
                ];
              }),
            ),
          },
        ];
      }),
    ),
  };
}

function platformPublication(value: Record<string, unknown>): PlatformPublication {
  const agents = value.agents as Record<string, { platforms: Record<string, PlatformPublication> }>;
  return agents.openclaw.platforms["linux/amd64"];
}

describe("managed-image cohort publication contract", () => {
  it("binds all shipped agents and architectures to the selected publication", () => {
    expect(
      validateManagedImageCohort(cohortContract(), {
        revision: REVISION,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
      }),
    ).toEqual({
      cohort: COHORT,
      receipt: {
        kind: "nemoclaw-managed-image-cohort-receipt-v1",
        cohort: COHORT,
        revision: REVISION,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        images: Object.fromEntries(
          SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, agentIndex) => [
            agent,
            Object.fromEntries(
              PLATFORMS.map((platform, platformIndex) => [
                platform,
                `${MANAGED_IMAGE_REPOSITORIES[agent]}@${digest(agentIndex + platformIndex + 10)}`,
              ]),
            ),
          ]),
        ),
      },
      revision: REVISION,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
    });
  });

  it("rejects a cohort that omits one image architecture", () => {
    const value = cohortContract();
    const agents = value.agents as Record<string, { platforms: Record<string, unknown> }>;
    delete agents.hermes.platforms["linux/arm64"];

    expect(() =>
      validateManagedImageCohort(value, {
        revision: REVISION,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
      }),
    ).toThrow("complete expected set");
  });

  it("rejects mixed revision provenance within the cohort", () => {
    const value = cohortContract();
    const agents = value.agents as Record<
      string,
      {
        platforms: Record<
          string,
          {
            publicationEvidence: {
              attestations: { slsa: { statement: { bindings: JsonObject } } };
            };
          }
        >;
      }
    >;
    agents.openclaw.platforms[
      "linux/amd64"
    ].publicationEvidence.attestations.slsa.statement.bindings.revision = "b".repeat(40);

    expect(() =>
      validateManagedImageCohort(value, {
        revision: REVISION,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
      }),
    ).toThrow("revision must be");
  });

  it.each([
    [
      "a missing attestation manifest workload digest binding",
      (publication: PlatformPublication) =>
        delete publication.publicationEvidence.attestations.manifestDescriptor.annotations[
          "vnd.docker.reference.digest"
        ],
    ],
    [
      "a changed attestation manifest workload digest binding",
      (publication: PlatformPublication) =>
        (publication.publicationEvidence.attestations.manifestDescriptor.annotations[
          "vnd.docker.reference.digest"
        ] = digest(9)),
    ],
    [
      "a missing SLSA subject workload digest binding",
      (publication: PlatformPublication) =>
        delete publication.publicationEvidence.attestations.slsa.statement.subject.digest,
    ],
    [
      "a changed SLSA subject workload digest binding",
      (publication: PlatformPublication) =>
        (publication.publicationEvidence.attestations.slsa.statement.subject.digest = digest(9)),
    ],
    [
      "a missing SPDX subject workload digest binding",
      (publication: PlatformPublication) =>
        delete publication.publicationEvidence.attestations.spdx.statement.subject.digest,
    ],
    [
      "a changed SPDX subject workload digest binding",
      (publication: PlatformPublication) =>
        (publication.publicationEvidence.attestations.spdx.statement.subject.digest = digest(9)),
    ],
  ])("rejects %s", (_label, corruptBinding) => {
    const value = cohortContract();
    corruptBinding(platformPublication(value));

    expect(() =>
      validateManagedImageCohort(value, {
        revision: REVISION,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
      }),
    ).toThrow("workload digest must be");
  });
});
