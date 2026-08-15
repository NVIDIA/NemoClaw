// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
  type NativeRuntimeQualificationCase,
} from "../../test/e2e/registry/native-runtime-qualification.ts";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;

export interface NativeRuntimeQualificationPlanSource {
  readonly repository: "NVIDIA/NemoClaw";
  readonly producerWorkflow: ".github/workflows/e2e.yaml";
  readonly pullRequestNumber: number;
  readonly candidateRepository: string;
  readonly candidateSha: string;
  readonly baseRef: "main";
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly producerRunId: string;
  readonly producerRunAttempt: number;
  readonly dispatchArtifact: NativeRuntimeQualificationArtifactIdentity;
}

export interface NativeRuntimeQualificationArtifactIdentity {
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly sizeInBytes: number;
}

export interface NativeRuntimeQualificationPlanRow {
  readonly id: string;
  readonly qualificationId: string;
  readonly providerId: string;
  readonly repository: "NVIDIA/NemoClaw";
  readonly producerWorkflow: ".github/workflows/e2e.yaml";
  readonly pullRequestNumber: number;
  readonly candidateRepository: string;
  readonly candidateSha: string;
  readonly baseRef: "main";
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly producerRunId: string;
  readonly producerRunAttempt: number;
  readonly dispatchArtifact: NativeRuntimeQualificationArtifactIdentity;
  readonly jobName: string;
  readonly artifactName: string;
  readonly case: NativeRuntimeQualificationCase;
}

export interface NativeRuntimeQualificationPlan {
  readonly include: readonly NativeRuntimeQualificationPlanRow[];
}

function validateSource(
  source: NativeRuntimeQualificationPlanSource,
): NativeRuntimeQualificationPlanSource {
  if (
    source.repository !== "NVIDIA/NemoClaw" ||
    source.producerWorkflow !== ".github/workflows/e2e.yaml" ||
    !Number.isSafeInteger(source.pullRequestNumber) ||
    source.pullRequestNumber < 1 ||
    !REPOSITORY.test(source.candidateRepository) ||
    source.baseRef !== "main"
  ) {
    throw new Error("Native runtime qualification authority source is invalid");
  }
  for (const [label, value] of [
    ["candidate SHA", source.candidateSha],
    ["base SHA", source.baseSha],
    ["trusted workflow SHA", source.workflowSha],
  ] as const) {
    if (!COMMIT_SHA.test(value)) {
      throw new Error(`Native runtime qualification ${label} is invalid`);
    }
  }
  if (!RUN_ID.test(source.producerRunId)) {
    throw new Error("Native runtime qualification producer run ID is invalid");
  }
  if (source.producerRunAttempt !== 1) {
    throw new Error("Native runtime qualification producer run attempt is invalid");
  }
  if (source.candidateSha === source.baseSha || source.baseSha !== source.workflowSha) {
    throw new Error("Native runtime qualification source revisions are invalid");
  }
  const dispatchArtifact = validateNativeRuntimeQualificationArtifactIdentity(
    source.dispatchArtifact,
    `e2e-dispatch-${source.producerRunId}-${source.producerRunAttempt}`,
  );
  return Object.freeze({ ...source, dispatchArtifact });
}

export function validateNativeRuntimeQualificationArtifactIdentity(
  value: NativeRuntimeQualificationArtifactIdentity,
  expectedName: string,
): NativeRuntimeQualificationArtifactIdentity {
  if (
    !RUN_ID.test(value.id) ||
    value.name !== expectedName ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.sizeInBytes) ||
    value.sizeInBytes < 1 ||
    value.sizeInBytes > 1_048_576
  ) {
    throw new Error("Native runtime qualification artifact identity is invalid");
  }
  return Object.freeze({ ...value });
}

export function nativeRuntimeQualificationArtifactName(
  caseId: string,
  candidateSha: string,
): string {
  if (
    !PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION.cases.some((entry) => entry.id === caseId)
  ) {
    throw new Error("Native runtime qualification case ID is invalid");
  }
  if (!COMMIT_SHA.test(candidateSha)) {
    throw new Error("Native runtime qualification candidate SHA is invalid");
  }
  return `native-runtime-qualification-evidence-${candidateSha}-${caseId}`;
}

export function nativeRuntimeQualificationProducerJobName(caseId: string): string {
  if (
    !PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION.cases.some((entry) => entry.id === caseId)
  ) {
    throw new Error("Native runtime qualification case ID is invalid");
  }
  return `Native runtime qualification / ${caseId}`;
}

function immutableCase(value: NativeRuntimeQualificationCase): NativeRuntimeQualificationCase {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    obligations: Object.freeze([...value.obligations]),
    evidenceKinds: Object.freeze([...value.evidenceKinds]),
  });
}

export function buildNativeRuntimeQualificationPlan(
  value: NativeRuntimeQualificationPlanSource,
): NativeRuntimeQualificationPlan {
  const source = validateSource(value);
  const qualification = PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION;
  const include = qualification.cases.map((entry) =>
    Object.freeze({
      id: entry.id,
      qualificationId: qualification.id,
      providerId: qualification.providerId,
      ...source,
      jobName: nativeRuntimeQualificationProducerJobName(entry.id),
      artifactName: nativeRuntimeQualificationArtifactName(entry.id, source.candidateSha),
      case: immutableCase(entry),
    }),
  );
  return Object.freeze({ include: Object.freeze(include) });
}

export function writeNativeRuntimeQualificationPlanCiOutput(
  source: NativeRuntimeQualificationPlanSource,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const output = environment.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  const plan = buildNativeRuntimeQualificationPlan(source);
  appendFileSync(output, `matrix=${JSON.stringify(plan)}\n`);
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "--ci-output" || process.argv.length !== 3) {
      throw new Error("Usage: native-runtime-qualification-plan.mts --ci-output");
    }
    writeNativeRuntimeQualificationPlanCiOutput({
      repository: "NVIDIA/NemoClaw",
      producerWorkflow: ".github/workflows/e2e.yaml",
      pullRequestNumber: Number(process.env.PR_NUMBER ?? ""),
      candidateRepository: process.env.CANDIDATE_REPOSITORY ?? "",
      candidateSha: process.env.CANDIDATE_SHA ?? "",
      baseRef: "main",
      baseSha: process.env.BASE_SHA ?? "",
      workflowSha: process.env.WORKFLOW_SHA ?? "",
      producerRunId: process.env.PRODUCER_RUN_ID ?? "",
      producerRunAttempt: Number(process.env.PRODUCER_RUN_ATTEMPT ?? ""),
      dispatchArtifact: {
        id: process.env.DISPATCH_ARTIFACT_ID ?? "",
        name: process.env.DISPATCH_ARTIFACT_NAME ?? "",
        digest: process.env.DISPATCH_ARTIFACT_DIGEST ?? "",
        sizeInBytes: Number(process.env.DISPATCH_ARTIFACT_SIZE ?? ""),
      },
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
