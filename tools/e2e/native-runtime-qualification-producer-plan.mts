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
const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const ARTIFACT_ID = RUN_ID;
const RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE = "podman-openclaw-linux-amd64-cpu-ollama";

export const NATIVE_RUNTIME_QUALIFICATION_FOCUSED_OPERATIONS = [
  "restart",
  "rebuild",
  "snapshot-restore",
  "clone",
  "backup",
  "crash-recovery",
  "rollback",
  "name-reuse",
  "installer",
  "cleanup",
] as const;

export interface NativeRuntimeQualificationDispatchArtifact {
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly sizeInBytes: number;
}

export interface NativeRuntimeQualificationProducerSource {
  readonly repository: "NVIDIA/NemoClaw";
  readonly producerWorkflow: ".github/workflows/e2e.yaml";
  readonly pullRequestNumber: number;
  readonly candidateRepository: "NVIDIA/NemoClaw";
  readonly candidateSha: string;
  readonly baseRef: "main";
  readonly baseSha: string;
  readonly workflowSha: string;
  readonly producerRunId: string;
  readonly producerRunAttempt: 1;
  readonly dispatchArtifact: NativeRuntimeQualificationDispatchArtifact;
}

export interface NativeRuntimeQualificationProducerPlanInput {
  readonly source: NativeRuntimeQualificationProducerSource;
  readonly installerSha256: string;
  readonly arm64GpuRunner: string;
}

export interface NativeRuntimeQualificationProducerPlanRow {
  readonly id: string;
  readonly jobName: string;
  readonly artifactName: string;
  readonly runner: string;
  readonly installerSha256: string;
  readonly source: NativeRuntimeQualificationProducerSource;
  readonly case: NativeRuntimeQualificationCase;
  readonly rootModes: readonly ("rootless" | "rootful")[];
  readonly focusedOperations: readonly string[];
}

export interface NativeRuntimeQualificationProducerPlan {
  readonly include: readonly NativeRuntimeQualificationProducerPlanRow[];
}

function validateArtifact(
  value: NativeRuntimeQualificationDispatchArtifact,
  source: Pick<NativeRuntimeQualificationProducerSource, "producerRunId" | "producerRunAttempt">,
): NativeRuntimeQualificationDispatchArtifact {
  if (
    !ARTIFACT_ID.test(value.id) ||
    value.name !== `e2e-dispatch-${source.producerRunId}-${source.producerRunAttempt}` ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.sizeInBytes) ||
    value.sizeInBytes < 1 ||
    value.sizeInBytes > 1_048_576
  ) {
    throw new Error("Native runtime qualification dispatch artifact is invalid");
  }
  return Object.freeze({ ...value });
}

function validateSource(
  value: NativeRuntimeQualificationProducerSource,
): NativeRuntimeQualificationProducerSource {
  if (
    value.repository !== "NVIDIA/NemoClaw" ||
    value.producerWorkflow !== ".github/workflows/e2e.yaml" ||
    value.candidateRepository !== "NVIDIA/NemoClaw" ||
    value.baseRef !== "main" ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    value.pullRequestNumber < 1 ||
    !COMMIT_SHA.test(value.candidateSha) ||
    !COMMIT_SHA.test(value.baseSha) ||
    !COMMIT_SHA.test(value.workflowSha) ||
    value.candidateSha === value.baseSha ||
    value.baseSha !== value.workflowSha ||
    !RUN_ID.test(value.producerRunId) ||
    value.producerRunAttempt !== 1
  ) {
    throw new Error("Native runtime qualification producer source is invalid");
  }
  return Object.freeze({
    ...value,
    dispatchArtifact: validateArtifact(value.dispatchArtifact, value),
  });
}

function runnerForCase(entry: NativeRuntimeQualificationCase, arm64GpuRunner: string): string {
  if (entry.architecture === "amd64" && entry.acceleration === "cpu") return "ubuntu-26.04";
  if (entry.architecture === "arm64" && entry.acceleration === "cpu") {
    return "ubuntu-24.04-arm";
  }
  if (entry.architecture === "amd64") return "linux-amd64-gpu-rtxpro6000-latest-1";
  if (!RUNNER_LABEL.test(arm64GpuRunner)) {
    throw new Error(
      "Native runtime qualification requires NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL to name a reviewed repository runner",
    );
  }
  return arm64GpuRunner;
}

function immutableCase(value: NativeRuntimeQualificationCase): NativeRuntimeQualificationCase {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    obligations: Object.freeze([...value.obligations]),
    evidenceKinds: Object.freeze([...value.evidenceKinds]),
  });
}

export function buildNativeRuntimeQualificationProducerPlan(
  input: NativeRuntimeQualificationProducerPlanInput,
): NativeRuntimeQualificationProducerPlan {
  const source = validateSource(input.source);
  if (!SHA256.test(input.installerSha256)) {
    throw new Error("Native runtime qualification installer SHA-256 is invalid");
  }
  const include = PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION.cases.map((entry) => {
    const focused = entry.id === NATIVE_RUNTIME_QUALIFICATION_FOCUSED_CASE;
    const rootModes: readonly ("rootless" | "rootful")[] = focused
      ? ["rootless", "rootful"]
      : ["rootless"];
    return Object.freeze({
      id: entry.id,
      jobName: `Native runtime qualification / ${entry.id}`,
      artifactName: `native-runtime-qualification-evidence-${source.candidateSha}-${entry.id}`,
      runner: runnerForCase(entry, input.arm64GpuRunner),
      installerSha256: input.installerSha256,
      source,
      case: immutableCase(entry),
      rootModes: Object.freeze(rootModes),
      focusedOperations: Object.freeze(
        focused ? [...NATIVE_RUNTIME_QUALIFICATION_FOCUSED_OPERATIONS] : [],
      ),
    });
  });
  return Object.freeze({ include: Object.freeze(include) });
}

export function writeNativeRuntimeQualificationProducerPlanCiOutput(
  input: NativeRuntimeQualificationProducerPlanInput,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!environment.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const plan = buildNativeRuntimeQualificationProducerPlan(input);
  appendFileSync(environment.GITHUB_OUTPUT, `matrix=${JSON.stringify(plan)}\n`);
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--ci-output") {
      throw new Error("Usage: native-runtime-qualification-producer-plan.mts --ci-output");
    }
    writeNativeRuntimeQualificationProducerPlanCiOutput({
      source: {
        repository: "NVIDIA/NemoClaw",
        producerWorkflow: ".github/workflows/e2e.yaml",
        pullRequestNumber: Number(process.env.PR_NUMBER ?? ""),
        candidateRepository: process.env.CANDIDATE_REPOSITORY as "NVIDIA/NemoClaw",
        candidateSha: process.env.CANDIDATE_SHA ?? "",
        baseRef: "main",
        baseSha: process.env.BASE_SHA ?? "",
        workflowSha: process.env.WORKFLOW_SHA ?? "",
        producerRunId: process.env.PRODUCER_RUN_ID ?? "",
        producerRunAttempt: Number(process.env.PRODUCER_RUN_ATTEMPT ?? "") as 1,
        dispatchArtifact: {
          id: process.env.DISPATCH_ARTIFACT_ID ?? "",
          name: process.env.DISPATCH_ARTIFACT_NAME ?? "",
          digest: process.env.DISPATCH_ARTIFACT_DIGEST ?? "",
          sizeInBytes: Number(process.env.DISPATCH_ARTIFACT_SIZE ?? ""),
        },
      },
      installerSha256: process.env.INSTALLER_SHA256 ?? "",
      arm64GpuRunner: process.env.NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL ?? "",
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
