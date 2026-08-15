// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildNativeRuntimeQualificationPlan,
  type NativeRuntimeQualificationArtifactIdentity,
  type NativeRuntimeQualificationPlanRow,
  type NativeRuntimeQualificationPlanSource,
  validateNativeRuntimeQualificationArtifactIdentity,
} from "./native-runtime-qualification-plan.mts";

export interface NativeRuntimeQualificationCaseReceipt {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-case-receipt-v1";
  readonly qualificationId: string;
  readonly providerId: string;
  readonly caseId: string;
  readonly source: NativeRuntimeQualificationPlanSource;
  readonly protectedJob: NativeRuntimeQualificationProtectedJobIdentity;
  readonly artifact: NativeRuntimeQualificationArtifactIdentity;
  readonly result: "passed";
}

export interface NativeRuntimeQualificationProtectedJobIdentity {
  readonly id: string;
  readonly name: string;
}

export interface NativeRuntimeQualificationAuthoritySource extends NativeRuntimeQualificationPlanSource {
  readonly protectedJobs: readonly (NativeRuntimeQualificationProtectedJobIdentity & {
    readonly caseId: string;
  })[];
}

export interface NativeRuntimeQualificationAuthority {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-authority-v1";
  readonly qualificationId: string;
  readonly providerId: string;
  readonly source: NativeRuntimeQualificationAuthoritySource;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function sameValue(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match the trusted plan`);
  }
}

function expectedRow(
  source: NativeRuntimeQualificationPlanSource,
  caseId: string,
): NativeRuntimeQualificationPlanRow {
  const row = buildNativeRuntimeQualificationPlan(source).include.find(
    (entry) => entry.id === caseId,
  );
  if (!row) throw new Error(`Native runtime qualification case '${caseId}' is unexpected`);
  return row;
}

export function collectNativeRuntimeQualificationCase(
  value: unknown,
  source: NativeRuntimeQualificationPlanSource,
  caseId: string,
  protectedJobValue: NativeRuntimeQualificationProtectedJobIdentity,
  artifactValue: NativeRuntimeQualificationArtifactIdentity,
): NativeRuntimeQualificationCaseReceipt {
  const row = expectedRow(source, caseId);
  const artifact = validateNativeRuntimeQualificationArtifactIdentity(
    artifactValue,
    row.artifactName,
  );
  const protectedJob = validateProtectedJobIdentity(protectedJobValue, row.jobName);
  const evidence = record(value, "Native runtime qualification case evidence");
  exactKeys(
    evidence,
    ["schemaVersion", "kind", "qualificationId", "providerId", "source", "case", "result"],
    "Native runtime qualification case evidence",
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== "nemoclaw-native-runtime-qualification-case-evidence-v1" ||
    evidence.qualificationId !== row.qualificationId ||
    evidence.providerId !== row.providerId ||
    evidence.result !== "passed"
  ) {
    throw new Error("Native runtime qualification case evidence identity is invalid");
  }
  sameValue(evidence.source, source, "Native runtime qualification source identity");
  sameValue(evidence.case, row.case, `Native runtime qualification case '${caseId}'`);
  return Object.freeze({
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-case-receipt-v1",
    qualificationId: row.qualificationId,
    providerId: row.providerId,
    caseId,
    source: Object.freeze({ ...source }),
    protectedJob,
    artifact,
    result: "passed",
  });
}

function validateProtectedJobIdentity(
  value: NativeRuntimeQualificationProtectedJobIdentity,
  expectedName: string,
): NativeRuntimeQualificationProtectedJobIdentity {
  if (!/^[1-9][0-9]{0,19}$/u.test(value.id) || value.name !== expectedName) {
    throw new Error("Native runtime qualification protected job identity is invalid");
  }
  return Object.freeze({ ...value });
}

function validateReceipt(
  value: unknown,
  source: NativeRuntimeQualificationPlanSource,
): NativeRuntimeQualificationCaseReceipt {
  const receipt = record(value, "Native runtime qualification case receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "qualificationId",
      "providerId",
      "caseId",
      "source",
      "protectedJob",
      "artifact",
      "result",
    ],
    "Native runtime qualification case receipt",
  );
  if (typeof receipt.caseId !== "string") {
    throw new Error("Native runtime qualification case receipt identity is invalid");
  }
  const row = expectedRow(source, receipt.caseId);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "nemoclaw-native-runtime-qualification-case-receipt-v1" ||
    receipt.qualificationId !== row.qualificationId ||
    receipt.providerId !== row.providerId ||
    receipt.result !== "passed"
  ) {
    throw new Error("Native runtime qualification case receipt identity is invalid");
  }
  sameValue(receipt.source, source, "Native runtime qualification receipt source identity");
  const protectedJob = record(receipt.protectedJob, "Native runtime qualification protected job");
  exactKeys(protectedJob, ["id", "name"], "Native runtime qualification protected job");
  if (typeof protectedJob.id !== "string" || typeof protectedJob.name !== "string") {
    throw new Error("Native runtime qualification protected job identity is invalid");
  }
  const artifact = record(receipt.artifact, "Native runtime qualification receipt artifact");
  exactKeys(
    artifact,
    ["id", "name", "digest", "sizeInBytes"],
    "Native runtime qualification receipt artifact",
  );
  if (
    typeof artifact.id !== "string" ||
    typeof artifact.name !== "string" ||
    typeof artifact.digest !== "string" ||
    typeof artifact.sizeInBytes !== "number"
  ) {
    throw new Error("Native runtime qualification artifact identity is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-case-receipt-v1",
    qualificationId: row.qualificationId,
    providerId: row.providerId,
    caseId: row.id,
    source: Object.freeze({ ...source }),
    protectedJob: validateProtectedJobIdentity(
      { id: protectedJob.id, name: protectedJob.name },
      row.jobName,
    ),
    artifact: validateNativeRuntimeQualificationArtifactIdentity(
      {
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        sizeInBytes: artifact.sizeInBytes,
      },
      row.artifactName,
    ),
    result: "passed",
  });
}

export function validateNativeRuntimeQualificationDispatchReceipt(
  value: unknown,
  source: NativeRuntimeQualificationPlanSource,
  expected: { readonly repository: string; readonly prNumber: number },
): void {
  buildNativeRuntimeQualificationPlan(source);
  const receipt = record(value, "Native runtime qualification dispatch receipt");
  exactKeys(
    receipt,
    [
      "actor",
      "allowDgxSparkRunnerQueue",
      "allowJetsonDispatch",
      "allowJetsonRunnerQueue",
      "baseSha",
      "candidateRepository",
      "candidateSha",
      "emptySelectors",
      "eventName",
      "includeStagingBrevLaunchable",
      "jobs",
      "kind",
      "prNumber",
      "releaseQualificationWaivedJobs",
      "releaseQualificationWaiverReason",
      "repository",
      "targets",
      "triggeringActor",
      "workflowRunAttempt",
      "workflowRunId",
      "workflowSha",
    ],
    "Native runtime qualification dispatch receipt",
  );
  const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
  if (
    receipt.kind !== "nemoclaw-e2e-dispatch-v2" ||
    receipt.repository !== expected.repository ||
    receipt.repository !== source.repository ||
    receipt.prNumber !== expected.prNumber ||
    receipt.prNumber !== source.pullRequestNumber ||
    receipt.candidateRepository !== source.candidateRepository ||
    receipt.candidateSha !== source.candidateSha ||
    receipt.baseSha !== source.baseSha ||
    receipt.workflowSha !== source.workflowSha ||
    receipt.workflowRunId !== source.producerRunId ||
    receipt.workflowRunAttempt !== source.producerRunAttempt ||
    receipt.eventName !== "workflow_dispatch" ||
    receipt.jobs !== "native-runtime-qualification-producer" ||
    receipt.targets !== "" ||
    receipt.emptySelectors !== false ||
    typeof receipt.allowDgxSparkRunnerQueue !== "boolean" ||
    typeof receipt.allowJetsonDispatch !== "boolean" ||
    typeof receipt.allowJetsonRunnerQueue !== "boolean" ||
    typeof receipt.includeStagingBrevLaunchable !== "boolean" ||
    !Array.isArray(receipt.releaseQualificationWaivedJobs) ||
    receipt.releaseQualificationWaivedJobs.length !== 0 ||
    receipt.releaseQualificationWaiverReason !== null ||
    typeof receipt.actor !== "string" ||
    !login.test(receipt.actor) ||
    typeof receipt.triggeringActor !== "string" ||
    !login.test(receipt.triggeringActor) ||
    receipt.actor !== receipt.triggeringActor
  ) {
    throw new Error("Native runtime qualification dispatch receipt identity is invalid");
  }
}

export function aggregateNativeRuntimeQualificationCases(
  values: readonly unknown[],
  source: NativeRuntimeQualificationPlanSource,
): NativeRuntimeQualificationAuthority {
  const plan = buildNativeRuntimeQualificationPlan(source);
  const expectedIds = new Set(plan.include.map((entry) => entry.id));
  const receipts = values.map((entry) => validateReceipt(entry, source));
  const seen = new Set<string>();
  const artifacts = new Set<string>();
  const jobs = new Set<string>();
  for (const receipt of receipts) {
    if (!expectedIds.has(receipt.caseId)) {
      throw new Error(`Native runtime qualification case '${receipt.caseId}' is unexpected`);
    }
    if (seen.has(receipt.caseId)) {
      throw new Error(`Native runtime qualification case '${receipt.caseId}' is duplicated`);
    }
    if (artifacts.has(receipt.artifact.id)) {
      throw new Error(
        `Native runtime qualification artifact '${receipt.artifact.id}' is duplicated`,
      );
    }
    if (jobs.has(receipt.protectedJob.id)) {
      throw new Error(
        `Native runtime qualification protected job '${receipt.protectedJob.id}' is duplicated`,
      );
    }
    seen.add(receipt.caseId);
    artifacts.add(receipt.artifact.id);
    jobs.add(receipt.protectedJob.id);
  }
  const missing = plan.include.filter((entry) => !seen.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) {
    throw new Error(`Native runtime qualification cases are missing: ${missing.join(", ")}`);
  }
  const ordered = plan.include.map((entry) =>
    receipts.find((receipt) => receipt.caseId === entry.id)!,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-authority-v1",
    qualificationId: plan.include[0]!.qualificationId,
    providerId: plan.include[0]!.providerId,
    source: Object.freeze({
      ...source,
      protectedJobs: Object.freeze(
        ordered.map((receipt) =>
          Object.freeze({ caseId: receipt.caseId, ...receipt.protectedJob }),
        ),
      ),
    }),
  });
}

function readJsonFile(file: string): unknown {
  const status = lstatSync(file, { throwIfNoEntry: false });
  if (!status?.isFile() || status.size < 1 || status.size > 1_048_576) {
    throw new Error(
      `Native runtime qualification file is missing or outside its size limit: ${file}`,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`Native runtime qualification JSON is invalid: ${file}`);
  }
}

function receiptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Native runtime qualification receipt transport contains a symbolic link");
    }
    if (entry.isDirectory()) files.push(...receiptFiles(child));
    else if (entry.isFile() && entry.name === "receipt.json") files.push(child);
  }
  return files.sort();
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}

function sourceFromEnvironment(): NativeRuntimeQualificationPlanSource {
  return {
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
  };
}

function runCli(): void {
  const mode = process.argv[2];
  const source = sourceFromEnvironment();
  if (mode === "collect") {
    const input = process.env.EVIDENCE_PATH ?? "";
    const output = process.env.RECEIPT_PATH ?? "";
    const artifact: NativeRuntimeQualificationArtifactIdentity = {
      id: process.env.ARTIFACT_ID ?? "",
      name: process.env.ARTIFACT_NAME ?? "",
      digest: process.env.ARTIFACT_DIGEST ?? "",
      sizeInBytes: Number(process.env.ARTIFACT_SIZE ?? ""),
    };
    if (!input || !output) throw new Error("Collector input and output paths are required");
    const receipt = collectNativeRuntimeQualificationCase(
      readJsonFile(input),
      source,
      process.env.CASE_ID ?? "",
      {
        id: process.env.PROTECTED_JOB_ID ?? "",
        name: process.env.PROTECTED_JOB_NAME ?? "",
      },
      artifact,
    );
    writeJsonAtomic(output, receipt);
    return;
  }
  if (mode === "dispatch") {
    const input = process.env.DISPATCH_RECEIPT_PATH ?? "";
    const prNumber = Number(process.env.PR_NUMBER ?? "");
    if (!input || !Number.isSafeInteger(prNumber) || prNumber < 1) {
      throw new Error("Dispatch receipt path and pull request number are required");
    }
    validateNativeRuntimeQualificationDispatchReceipt(readJsonFile(input), source, {
      repository: process.env.GITHUB_REPOSITORY ?? "",
      prNumber,
    });
    return;
  }
  if (mode === "aggregate") {
    const input = process.env.RECEIPT_DIRECTORY ?? "";
    const output = process.env.AGGREGATE_PATH ?? "";
    if (!input || !output) throw new Error("Aggregate input and output paths are required");
    const aggregate = aggregateNativeRuntimeQualificationCases(
      receiptFiles(input).map(readJsonFile),
      source,
    );
    writeJsonAtomic(output, aggregate);
    return;
  }
  throw new Error("Usage: native-runtime-qualification-collector.mts dispatch|collect|aggregate");
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
