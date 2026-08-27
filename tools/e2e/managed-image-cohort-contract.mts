// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImagePlatform,
  type ShippedManagedImageAgent,
} from "../../src/lib/onboard/managed-image/contract.ts";

const REPOSITORY = "NVIDIA/NemoClaw";
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface ManagedImageCohortIdentity {
  readonly cohort: string;
  readonly receipt: ManagedImageCohortReceipt;
  readonly revision: string;
  readonly runAttempt: number;
  readonly runId: number;
}

export interface ManagedImageCohortReceipt {
  readonly kind: "nemoclaw-managed-image-cohort-receipt-v1";
  readonly cohort: string;
  readonly revision: string;
  readonly runAttempt: number;
  readonly runId: number;
  readonly images: Readonly<
    Record<ShippedManagedImageAgent, Readonly<Record<ManagedImagePlatform, string>>>
  >;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be an immutable SHA-256 digest`);
  }
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} must contain the complete expected set`);
  }
}

function validatePlatformEvidence(
  value: unknown,
  expected: {
    readonly agent: string;
    readonly cohort: string;
    readonly platform: (typeof PLATFORMS)[number];
    readonly revision: string;
    readonly runAttempt: number;
    readonly runId: number;
  },
): void {
  const platform = record(value, `${expected.agent} ${expected.platform} publication`);
  const platformDigest = digest(platform.digest, `${expected.agent} ${expected.platform} digest`);
  const image =
    MANAGED_IMAGE_REPOSITORIES[expected.agent as keyof typeof MANAGED_IMAGE_REPOSITORIES];
  exactString(
    platform.reference,
    `${image}@${platformDigest}`,
    `${expected.agent} ${expected.platform} reference`,
  );
  const baseReference = platform.baseReference;
  if (typeof baseReference !== "string" || !/@sha256:[0-9a-f]{64}$/u.test(baseReference)) {
    throw new Error(`${expected.agent} ${expected.platform} base reference must be immutable`);
  }

  const publicationEvidence = record(
    platform.publicationEvidence,
    `${expected.agent} ${expected.platform} publication evidence`,
  );
  const candidateDescriptor = record(
    publicationEvidence.candidateDescriptor,
    `${expected.agent} ${expected.platform} candidate descriptor`,
  );
  exactString(
    candidateDescriptor.digest,
    platformDigest,
    `${expected.agent} ${expected.platform} candidate digest`,
  );
  const workloadDescriptor = record(
    publicationEvidence.workloadDescriptor,
    `${expected.agent} ${expected.platform} workload descriptor`,
  );
  const workloadDigest = digest(
    workloadDescriptor.digest,
    `${expected.agent} ${expected.platform} workload digest`,
  );
  const workloadPlatform = record(
    workloadDescriptor.platform,
    `${expected.agent} ${expected.platform} workload platform`,
  );
  const [os, architecture] = expected.platform.split("/");
  exactString(workloadPlatform.os, os, `${expected.agent} ${expected.platform} operating system`);
  exactString(
    workloadPlatform.architecture,
    architecture,
    `${expected.agent} ${expected.platform} architecture`,
  );

  const attestations = record(
    publicationEvidence.attestations,
    `${expected.agent} ${expected.platform} attestations`,
  );
  const manifestDescriptor = record(
    attestations.manifestDescriptor,
    `${expected.agent} ${expected.platform} attestation manifest descriptor`,
  );
  const manifestAnnotations = record(
    manifestDescriptor.annotations,
    `${expected.agent} ${expected.platform} attestation manifest annotations`,
  );
  exactString(
    manifestAnnotations["vnd.docker.reference.digest"],
    workloadDigest,
    `${expected.agent} ${expected.platform} attestation manifest workload digest`,
  );
  const slsa = record(attestations.slsa, `${expected.agent} ${expected.platform} SLSA evidence`);
  const statement = record(slsa.statement, `${expected.agent} ${expected.platform} SLSA statement`);
  const slsaSubject = record(
    statement.subject,
    `${expected.agent} ${expected.platform} SLSA subject`,
  );
  exactString(
    slsaSubject.digest,
    workloadDigest,
    `${expected.agent} ${expected.platform} SLSA subject workload digest`,
  );
  exactString(
    statement.builderId,
    `https://github.com/${REPOSITORY}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`,
    `${expected.agent} ${expected.platform} builder`,
  );
  const bindings = record(
    statement.bindings,
    `${expected.agent} ${expected.platform} SLSA bindings`,
  );
  exactString(bindings.agent, expected.agent, `${expected.agent} ${expected.platform} agent`);
  exactString(bindings.cohort, expected.cohort, `${expected.agent} ${expected.platform} cohort`);
  exactString(
    bindings.platform,
    expected.platform,
    `${expected.agent} ${expected.platform} binding`,
  );
  exactString(
    bindings.revision,
    expected.revision,
    `${expected.agent} ${expected.platform} revision`,
  );
  exactString(bindings.source, `https://github.com/${REPOSITORY}`, `${expected.agent} source`);
  exactString(
    bindings.baseReference,
    baseReference,
    `${expected.agent} ${expected.platform} base reference binding`,
  );
  const spdx = record(attestations.spdx, `${expected.agent} ${expected.platform} SPDX evidence`);
  const spdxStatement = record(
    spdx.statement,
    `${expected.agent} ${expected.platform} SPDX statement`,
  );
  const spdxSubject = record(
    spdxStatement.subject,
    `${expected.agent} ${expected.platform} SPDX subject`,
  );
  exactString(
    spdxSubject.digest,
    workloadDigest,
    `${expected.agent} ${expected.platform} SPDX subject workload digest`,
  );
}

/** Validate one complete published cohort against its selected workflow attempt. */
export function validateManagedImageCohort(
  value: unknown,
  expected: { readonly revision: string; readonly runAttempt: number; readonly runId: number },
): ManagedImageCohortIdentity {
  if (!SHA_PATTERN.test(expected.revision)) throw new Error("expected cohort revision is invalid");
  positiveInteger(expected.runId, "expected cohort run id");
  positiveInteger(expected.runAttempt, "expected cohort run attempt");

  const cohort = record(value, "managed-image cohort");
  if (cohort.contractVersion !== 2)
    throw new Error("managed-image cohort contract version must be 2");
  const expectedCohort = `ghrun-${expected.runId}-${expected.runAttempt}`;
  exactString(cohort.cohort, expectedCohort, "managed-image cohort identity");
  const source = record(cohort.source, "managed-image cohort source");
  exactString(source.repository, REPOSITORY, "managed-image cohort source repository");
  exactString(source.revision, expected.revision, "managed-image cohort source revision");
  const run = record(cohort.run, "managed-image cohort run");
  if (run.id !== expected.runId || run.attempt !== expected.runAttempt) {
    throw new Error("managed-image cohort run does not match the selected publication");
  }
  if (JSON.stringify(cohort.platforms) !== JSON.stringify(PLATFORMS)) {
    throw new Error("managed-image cohort must contain linux/amd64 and linux/arm64");
  }

  const agents = record(cohort.agents, "managed-image cohort agents");
  exactKeys(agents, SHIPPED_MANAGED_IMAGE_AGENTS, "managed-image cohort agents");
  for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
    const contract = record(agents[agent], `${agent} cohort contract`);
    const image = MANAGED_IMAGE_REPOSITORIES[agent];
    const manifestDigest = digest(contract.digest, `${agent} cohort digest`);
    exactString(contract.image, image, `${agent} cohort image`);
    exactString(contract.reference, `${image}@${manifestDigest}`, `${agent} cohort reference`);
    exactString(contract.alias, `${image}:cohort-${expectedCohort}`, `${agent} cohort alias`);
    exactString(
      record(contract.descriptor, `${agent} cohort descriptor`).digest,
      manifestDigest,
      `${agent} cohort descriptor digest`,
    );
    const platforms = record(contract.platforms, `${agent} cohort platforms`);
    exactKeys(platforms, PLATFORMS, `${agent} cohort platforms`);
    for (const platform of PLATFORMS) {
      validatePlatformEvidence(platforms[platform], {
        agent,
        cohort: expectedCohort,
        platform,
        revision: expected.revision,
        runAttempt: expected.runAttempt,
        runId: expected.runId,
      });
    }
  }

  const images = Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => {
      const platforms = record(
        record(agents[agent], `${agent} cohort contract`).platforms,
        `${agent} cohort platforms`,
      );
      return [
        agent,
        Object.fromEntries(
          PLATFORMS.map((platform) => {
            const publication = record(platforms[platform], `${agent} ${platform} publication`);
            const workloadDescriptor = record(
              record(publication.publicationEvidence, `${agent} ${platform} publication evidence`)
                .workloadDescriptor,
              `${agent} ${platform} workload descriptor`,
            );
            const workloadDigest = digest(
              workloadDescriptor.digest,
              `${agent} ${platform} workload digest`,
            );
            return [platform, `${MANAGED_IMAGE_REPOSITORIES[agent]}@${workloadDigest}`];
          }),
        ),
      ];
    }),
  ) as ManagedImageCohortReceipt["images"];
  const receipt: ManagedImageCohortReceipt = {
    kind: "nemoclaw-managed-image-cohort-receipt-v1",
    cohort: expectedCohort,
    revision: expected.revision,
    runAttempt: expected.runAttempt,
    runId: expected.runId,
    images,
  };

  return {
    cohort: expectedCohort,
    receipt,
    revision: expected.revision,
    runAttempt: expected.runAttempt,
    runId: expected.runId,
  };
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export function main(argv = process.argv.slice(2), env = process.env): void {
  if (argv.length !== 1) throw new Error("expected one managed-image cohort contract path");
  const identity = validateManagedImageCohort(
    JSON.parse(readFileSync(argv[0], "utf8")) as unknown,
    {
      revision: env.PUBLICATION_HEAD_SHA ?? "",
      runAttempt: requiredInteger(env.PUBLICATION_RUN_ATTEMPT, "PUBLICATION_RUN_ATTEMPT"),
      runId: requiredInteger(env.PUBLICATION_RUN_ID, "PUBLICATION_RUN_ID"),
    },
  );
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(
    env.GITHUB_OUTPUT,
    `cohort=${identity.cohort}\nreceipt=${JSON.stringify(identity.receipt)}\nrevision=${identity.revision}\nrun_attempt=${identity.runAttempt}\nrun_id=${identity.runId}\n`,
    "utf8",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown managed-image cohort error");
    process.exitCode = 1;
  }
}
