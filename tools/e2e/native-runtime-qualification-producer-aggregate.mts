// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  consumeNativeRuntimeQualificationEvidence,
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
  type NativeRuntimeQualificationEvidenceEnvelope,
  type NativeRuntimeQualificationExpectedSource,
} from "../../test/e2e/registry/native-runtime-qualification.ts";
import type { NativeRuntimeQualificationCaseFragment } from "./native-runtime-qualification-producer-evidence.mts";
import {
  nativeRuntimeQualificationOperationFile,
  type NativeRuntimeQualificationProducerPlan,
} from "./native-runtime-qualification-producer-plan.mts";

export const NATIVE_RUNTIME_QUALIFICATION_AGGREGATE_JOB_NAME =
  "Aggregate native runtime qualification evidence";
export const NATIVE_RUNTIME_QUALIFICATION_AGGREGATE_EVIDENCE_FILE =
  "native-runtime-qualification-evidence.json";

const MAX_FRAGMENT_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 524_288;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/u;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function readBoundedBytes(file: string, maximum: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > maximum) {
      throw new Error(`Native runtime qualification aggregate input is invalid: ${file}`);
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Native runtime qualification")) {
      throw error;
    }
    throw new Error(`Native runtime qualification aggregate input is invalid: ${file}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(file: string, maximum = MAX_FRAGMENT_BYTES): unknown {
  try {
    return JSON.parse(readBoundedBytes(file, maximum).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Native runtime qualification aggregate input is not JSON: ${file}`);
    }
    throw error;
  }
}

function positiveInteger(value: string, label: string): number {
  if (!POSITIVE_INTEGER.test(value)) {
    throw new Error(`Native runtime qualification ${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Native runtime qualification ${label} is invalid`);
  }
  return parsed;
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Native runtime qualification ${label} does not match the trusted plan`);
  }
}

function assertDirectory(directory: string, label: string): void {
  const status = lstatSync(directory, { throwIfNoEntry: false });
  if (!status?.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Native runtime qualification ${label} is invalid`);
  }
}

function walkRegularFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string, relative: string): void => {
    assertDirectory(directory, "aggregate artifact directory");
    for (const name of readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const status = lstatSync(child);
      if (status.isSymbolicLink()) {
        throw new Error(
          `Native runtime qualification aggregate input cannot contain symlinks: ${childRelative}`,
        );
      }
      if (status.isDirectory()) visit(child, childRelative);
      else if (status.isFile() && status.size >= 1 && status.size <= MAX_RECEIPT_BYTES)
        files.push(childRelative);
      else
        throw new Error(
          `Native runtime qualification aggregate input is invalid: ${childRelative}`,
        );
    }
  };
  visit(root, "");
  return Object.freeze(files);
}

function expectedReceiptFiles(
  row: NativeRuntimeQualificationProducerPlan["include"][number],
): readonly string[] {
  const caseId = row.id;
  const operations = row.case.obligations.map(
    (id) => `receipts/${caseId}/operations/${nativeRuntimeQualificationOperationFile(id)}`,
  );
  return Object.freeze([
    "case-fragment.json",
    `receipts/${caseId}/installer/architecture.json`,
    `receipts/${caseId}/installer/candidate-source.json`,
    `receipts/${caseId}/installer/docker-absence.json`,
    `receipts/${caseId}/installer/installed-source.json`,
    `receipts/${caseId}/installer/installer.sh`,
    `receipts/${caseId}/installer/invocation.json`,
    `receipts/${caseId}/runtime/runtime-result.json`,
    ...operations,
    ...(row.case.acceleration === "nvidia-gpu"
      ? [`receipts/${caseId}/runtime/nvidia-cdi.json`]
      : []),
  ]);
}

function validateFragment(
  value: unknown,
  row: NativeRuntimeQualificationProducerPlan["include"][number],
): NativeRuntimeQualificationCaseFragment {
  const fragment = record(value, `Native runtime qualification fragment '${row.id}'`);
  exactKeys(
    fragment,
    [
      "schemaVersion",
      "kind",
      "qualificationId",
      "providerId",
      "source",
      "case",
      "installer",
      "runtime",
      "operations",
      ...(row.case.acceleration === "nvidia-gpu" ? ["nvidiaCdi"] : []),
    ],
    `Native runtime qualification fragment '${row.id}'`,
  );
  if (
    fragment.schemaVersion !== 1 ||
    fragment.kind !== "nemoclaw-native-runtime-qualification-case-fragment-v1" ||
    fragment.qualificationId !== "podman-protected-host-local-inference" ||
    fragment.providerId !== "podman"
  ) {
    throw new Error(`Native runtime qualification fragment '${row.id}' identity is invalid`);
  }
  exactJson(fragment.source, row.source, `fragment '${row.id}' source`);
  exactJson(fragment.case, row.case, `fragment '${row.id}' case`);
  return fragment as unknown as NativeRuntimeQualificationCaseFragment;
}

function expectedSource(
  plan: NativeRuntimeQualificationProducerPlan,
  aggregateJobId: number,
): NativeRuntimeQualificationExpectedSource {
  const first = plan.include[0];
  if (!first) throw new Error("Native runtime qualification plan is empty");
  return Object.freeze({
    repository: first.source.repository,
    workflow: first.source.producerWorkflow,
    pullRequestNumber: first.source.pullRequestNumber,
    candidateRepository: first.source.candidateRepository,
    headSha: first.source.candidateSha,
    baseRef: "main" as const,
    baseSha: first.source.baseSha,
    runId: positiveInteger(first.source.producerRunId, "producer run id"),
    attempt: first.source.producerRunAttempt,
    jobId: aggregateJobId,
    // The aggregate job cannot know the GitHub artifact identity before upload.
    // The collector replaces these placeholders with the independently resolved identity.
    artifact: Object.freeze({
      id: 1,
      name: "native-runtime-qualification-pre-upload",
      digest: `sha256:${"0".repeat(64)}`,
    }),
  });
}

function caseEvidence(
  fragment: NativeRuntimeQualificationCaseFragment,
  source: NativeRuntimeQualificationExpectedSource,
): NativeRuntimeQualificationEvidenceEnvelope["cases"][number] {
  return Object.freeze({
    schemaVersion: 1,
    caseId: fragment.case.id,
    protectedRun: Object.freeze({
      repository: source.repository,
      workflow: source.workflow,
      pullRequestNumber: source.pullRequestNumber,
      candidateRepository: source.candidateRepository,
      headSha: source.headSha,
      baseRef: source.baseRef,
      baseSha: source.baseSha,
      runId: source.runId,
      attempt: source.attempt,
      jobId: source.jobId,
    }),
    installer:
      fragment.installer as NativeRuntimeQualificationEvidenceEnvelope["cases"][number]["installer"],
    runtime:
      fragment.runtime as NativeRuntimeQualificationEvidenceEnvelope["cases"][number]["runtime"],
    operations: fragment.operations,
    ...(fragment.nvidiaCdi ? { nvidiaCdi: fragment.nvidiaCdi } : {}),
  });
}

export function aggregateNativeRuntimeQualificationProducerEvidence(input: {
  readonly plan: NativeRuntimeQualificationProducerPlan;
  readonly caseArtifactRoot: string;
  readonly evidenceDirectory: string;
  readonly aggregateJobId: number;
}): NativeRuntimeQualificationEvidenceEnvelope {
  const { plan } = input;
  const expectedCaseCount = PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION.cases.length;
  if (
    plan.include.length !== expectedCaseCount ||
    new Set(plan.include.map((row) => row.id)).size !== expectedCaseCount
  ) {
    throw new Error("Native runtime qualification aggregate requires the exact 24-case plan");
  }
  const first = plan.include[0]!;
  for (const row of plan.include) {
    exactJson(row.source, first.source, `plan row '${row.id}' source cohort`);
  }
  if (!Number.isSafeInteger(input.aggregateJobId) || input.aggregateJobId < 1) {
    throw new Error("Native runtime qualification aggregate job id is invalid");
  }
  assertDirectory(input.caseArtifactRoot, "aggregate artifact root");
  const expectedDirectories = plan.include.map((row) => row.artifactName).sort();
  const actualDirectories = readdirSync(input.caseArtifactRoot).sort();
  if (JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)) {
    throw new Error(
      "Native runtime qualification aggregate artifact cohort is incomplete or mixed",
    );
  }
  if (lstatSync(input.evidenceDirectory, { throwIfNoEntry: false })) {
    throw new Error("Native runtime qualification aggregate output must not already exist");
  }
  const outputParent = path.dirname(input.evidenceDirectory);
  assertDirectory(outputParent, "aggregate output parent");
  mkdirSync(input.evidenceDirectory, { mode: 0o700 });

  const source = expectedSource(plan, input.aggregateJobId);
  const cases: NativeRuntimeQualificationEvidenceEnvelope["cases"][number][] = [];
  let totalBytes = 0;
  const copiedPaths = new Set<string>();
  for (const row of plan.include) {
    const artifactDirectory = path.join(input.caseArtifactRoot, row.artifactName);
    assertDirectory(artifactDirectory, `case artifact '${row.artifactName}'`);
    const actualFiles = walkRegularFiles(artifactDirectory);
    const expectedFiles = [...expectedReceiptFiles(row)].sort();
    if (JSON.stringify([...actualFiles].sort()) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Native runtime qualification case artifact '${row.id}' has invalid files`);
    }
    const fragment = validateFragment(
      readJson(path.join(artifactDirectory, "case-fragment.json")),
      row,
    );
    for (const relativePath of actualFiles.filter((file) => file !== "case-fragment.json")) {
      if (copiedPaths.has(relativePath)) {
        throw new Error(`Native runtime qualification aggregate repeats receipt '${relativePath}'`);
      }
      copiedPaths.add(relativePath);
      const bytes = readBoundedBytes(path.join(artifactDirectory, relativePath), MAX_RECEIPT_BYTES);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Native runtime qualification aggregate receipts exceed their byte limit");
      }
      const target = path.join(input.evidenceDirectory, relativePath);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    cases.push(caseEvidence(fragment, source));
  }
  const envelope: NativeRuntimeQualificationEvidenceEnvelope = Object.freeze({
    schemaVersion: 1,
    qualificationId: "podman-protected-host-local-inference",
    providerId: "podman",
    cases: Object.freeze(cases),
  });
  const definition = PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION;
  consumeNativeRuntimeQualificationEvidence(definition, envelope, source, (receiptPath) => {
    try {
      return readBoundedBytes(path.join(input.evidenceDirectory, receiptPath), MAX_RECEIPT_BYTES);
    } catch {
      return null;
    }
  });
  writeFileSync(
    path.join(input.evidenceDirectory, NATIVE_RUNTIME_QUALIFICATION_AGGREGATE_EVIDENCE_FILE),
    `${JSON.stringify(envelope)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return envelope;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Native runtime qualification environment '${name}' is missing`);
  return value;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Usage: native-runtime-qualification-producer-aggregate.mts");
    }
    const plan = JSON.parse(
      requiredEnvironment("QUALIFICATION_PLAN"),
    ) as NativeRuntimeQualificationProducerPlan;
    aggregateNativeRuntimeQualificationProducerEvidence({
      plan,
      caseArtifactRoot: requiredEnvironment("CASE_ARTIFACT_ROOT"),
      evidenceDirectory: requiredEnvironment("EVIDENCE_DIRECTORY"),
      aggregateJobId: positiveInteger(requiredEnvironment("AGGREGATE_JOB_ID"), "aggregate job id"),
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
