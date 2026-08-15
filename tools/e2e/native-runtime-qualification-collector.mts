// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
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

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  readValidatedArtifactZipEntry,
  readValidatedArtifactZipEntryBytes,
} from "../../scripts/scorecard/read-artifact-zip.mts";
import {
  compileNativeRuntimeQualification,
  consumeNativeRuntimeQualificationEvidence,
  nativeRuntimeQualificationDefinition,
  type NativeRuntimeQualificationAuthority as ProtectedNativeRuntimeQualificationAuthority,
  type NativeRuntimeQualificationExpectedSource,
  type NativeRuntimeQualificationReceiptReader,
} from "../../test/e2e/registry/native-runtime-qualification.ts";

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
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(
      `Native runtime qualification file is missing or outside its size limit: ${file}`,
    );
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > 1_048_576) {
      throw new Error(
        `Native runtime qualification file is missing or outside its size limit: ${file}`,
      );
    }
    const source = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Native runtime qualification file changed while it was read: ${file}`);
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new Error(`Native runtime qualification JSON is invalid: ${file}`);
    }
  } finally {
    closeSync(descriptor);
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
if (
  invokedFile === fileURLToPath(import.meta.url) &&
  ["dispatch", "collect", "aggregate"].includes(process.argv[2] ?? "")
) {
  try {
    runCli();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}


export const NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE =
  "native-runtime-qualification-evidence.json";
export const NATIVE_RUNTIME_QUALIFICATION_COLLECTOR_WORKFLOW =
  ".github/workflows/native-runtime-qualification-collector.yaml";

const API_ROOT = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_ITEMS = 100;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const REQUEST_ATTEMPTS = 3;
const SHA = /^[a-f0-9]{40}$/u;
const SAFE_PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/()\[\]-]{0,199}$/u;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

type JsonRecord = Record<string, unknown>;

export interface GitHubQualificationReader {
  getJson(apiPath: string): Promise<unknown>;
  getBytes(apiPath: string): Promise<Buffer>;
}

export interface NativeRuntimeQualificationCollectorInput {
  readonly repository: string;
  readonly actor: string;
  readonly eventName: string;
  readonly ref: string;
  readonly collectorWorkflowRef: string;
  readonly collectorWorkflowSha: string;
  readonly collectorRunId: number;
  readonly providerId: string;
  readonly pullRequestNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
  readonly evidenceWorkflow: string;
  readonly evidenceRunId: number;
  readonly evidenceJobName: string;
  readonly evidenceArtifactName: string;
}

type PullRequestIdentity = {
  readonly candidateRepository: string;
  readonly headSha: string;
  readonly baseSha: string;
};

type WorkflowIdentity = { readonly id: number };

type WorkflowRun = {
  readonly id: number;
  readonly workflowId: number;
  readonly attempt: number;
  readonly headSha: string;
};

type WorkflowJob = { readonly id: number };

type WorkflowArtifact = {
  readonly id: number;
  readonly name: string;
  readonly digest: string;
  readonly archivePath: string;
};

function fail(message: string): never {
  throw new Error(`Native runtime qualification collector rejected evidence: ${message}`);
}

function collectorRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label} is invalid`);
  return Number(value);
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is invalid`);
  return value;
}

function expectedString(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} does not match '${expected}'`);
}

function validateCollectorBoundary(input: NativeRuntimeQualificationCollectorInput): void {
  const expectedWorkflowRef = `${input.repository}/${NATIVE_RUNTIME_QUALIFICATION_COLLECTOR_WORKFLOW}@refs/heads/main`;
  if (
    input.repository !== "NVIDIA/NemoClaw" ||
    input.eventName !== "workflow_dispatch" ||
    input.ref !== "refs/heads/main" ||
    input.collectorWorkflowRef !== expectedWorkflowRef ||
    input.collectorWorkflowSha !== input.expectedBaseSha ||
    input.evidenceWorkflow === NATIVE_RUNTIME_QUALIFICATION_COLLECTOR_WORKFLOW ||
    input.collectorRunId === input.evidenceRunId ||
    !SAFE_PROVIDER_ID.test(input.providerId) ||
    !SHA.test(input.expectedHeadSha) ||
    !SHA.test(input.expectedBaseSha) ||
    input.expectedHeadSha === input.expectedBaseSha ||
    !SAFE_WORKFLOW.test(input.evidenceWorkflow) ||
    !SAFE_NAME.test(input.evidenceJobName) ||
    !SAFE_ARTIFACT_NAME.test(input.evidenceArtifactName)
  ) {
    fail("the trusted workflow boundary or controller inputs are invalid");
  }
  positiveInteger(input.collectorRunId, "collector run id");
  positiveInteger(input.pullRequestNumber, "pull request number");
  positiveInteger(input.evidenceRunId, "evidence run id");
}

async function assertActorPermission(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<void> {
  const permission = collectorRecord(
    await api.getJson(
      `repos/${input.repository}/collaborators/${encodeURIComponent(input.actor)}/permission`,
    ),
    "actor permission",
  );
  const user = collectorRecord(permission.user, "actor permission user");
  if (user.login !== input.actor || !WRITE_PERMISSIONS.has(String(permission.permission))) {
    fail(`actor '${input.actor}' lacks write, maintain, or admin permission`);
  }
}

function validatePullRequest(
  value: unknown,
  input: NativeRuntimeQualificationCollectorInput,
): PullRequestIdentity {
  const pull = collectorRecord(value, "pull request");
  const head = collectorRecord(pull.head, "candidate commit");
  const base = collectorRecord(pull.base, "target-branch base");
  const headRepository = collectorRecord(head.repo, "candidate repository");
  const baseRepository = collectorRecord(base.repo, "target repository");
  if (
    pull.number !== input.pullRequestNumber ||
    pull.state !== "open" ||
    head.sha !== input.expectedHeadSha ||
    base.sha !== input.expectedBaseSha ||
    base.ref !== "main" ||
    baseRepository.full_name !== input.repository ||
    typeof headRepository.full_name !== "string"
  ) {
    fail(
      "candidate commit, candidate repository, target-branch base SHA, or pull request state does not match controller inputs",
    );
  }
  return {
    candidateRepository: headRepository.full_name,
    headSha: exactSha(head.sha, "candidate commit SHA"),
    baseSha: exactSha(base.sha, "target-branch base SHA"),
  };
}

async function loadPullRequest(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<PullRequestIdentity> {
  return validatePullRequest(
    await api.getJson(`repos/${input.repository}/pulls/${input.pullRequestNumber}`),
    input,
  );
}

async function assertMainRevision(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<void> {
  const commit = collectorRecord(await api.getJson(`repos/${input.repository}/commits/main`), "main commit");
  expectedString(commit.sha, input.expectedBaseSha, "current main SHA");
}

function workflowFile(workflowPath: string): string {
  return workflowPath.slice(workflowPath.lastIndexOf("/") + 1);
}

async function loadWorkflow(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<WorkflowIdentity> {
  const workflow = collectorRecord(
    await api.getJson(
      `repos/${input.repository}/actions/workflows/${encodeURIComponent(
        workflowFile(input.evidenceWorkflow),
      )}`,
    ),
    "protected workflow",
  );
  if (workflow.path !== input.evidenceWorkflow || workflow.state !== "active") {
    fail("protected workflow path is mismatched or inactive");
  }
  return { id: positiveInteger(workflow.id, "protected workflow id") };
}

function validateRun(
  value: unknown,
  input: NativeRuntimeQualificationCollectorInput,
  workflow: WorkflowIdentity,
): WorkflowRun {
  const run = collectorRecord(value, "protected workflow run");
  const repository = collectorRecord(run.repository, "protected workflow run repository");
  if (
    run.id !== input.evidenceRunId ||
    run.workflow_id !== workflow.id ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_sha !== input.expectedBaseSha ||
    run.head_branch !== "main" ||
    run.path !== input.evidenceWorkflow ||
    repository.full_name !== input.repository
  ) {
    fail("protected workflow run identity or successful conclusion is invalid");
  }
  return {
    id: positiveInteger(run.id, "protected run id"),
    workflowId: positiveInteger(run.workflow_id, "protected workflow id"),
    attempt: positiveInteger(run.run_attempt, "protected run attempt"),
    headSha: exactSha(run.head_sha, "protected workflow SHA"),
  };
}

async function loadRun(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
  workflow: WorkflowIdentity,
): Promise<WorkflowRun> {
  return validateRun(
    await api.getJson(`repos/${input.repository}/actions/runs/${input.evidenceRunId}`),
    input,
    workflow,
  );
}

async function loadCountedPage(
  api: GitHubQualificationReader,
  apiPath: string,
  collection: string,
  label: string,
): Promise<unknown[]> {
  const page = collectorRecord(await api.getJson(`${apiPath}?per_page=${PAGE_SIZE}&page=1`), label);
  const total = positiveInteger(page.total_count, `${label} total_count`);
  const items = page[collection];
  if (!Array.isArray(items) || total !== items.length || total > MAX_ITEMS) {
    fail(`${label} is incomplete, inconsistent, or exceeds ${MAX_ITEMS} items`);
  }
  return items;
}

async function loadExpectedJob(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
  run: WorkflowRun,
): Promise<WorkflowJob> {
  const jobs = await loadCountedPage(
    api,
    `repos/${input.repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`,
    "jobs",
    "protected run jobs",
  );
  const matches = jobs
    .map((value) => collectorRecord(value, "protected run job"))
    .filter((job) => job.name === input.evidenceJobName);
  if (matches.length !== 1) fail("expected protected job identity is missing or duplicated");
  const job = matches[0]!;
  if (
    job.run_id !== run.id ||
    job.run_attempt !== run.attempt ||
    job.head_sha !== run.headSha ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  ) {
    fail("expected protected job did not complete successfully in the bound run attempt");
  }
  return { id: positiveInteger(job.id, "protected job id") };
}

function validateArtifact(
  value: unknown,
  input: NativeRuntimeQualificationCollectorInput,
  run: WorkflowRun,
): WorkflowArtifact {
  const artifact = collectorRecord(value, "protected evidence artifact");
  const artifactRun = collectorRecord(artifact.workflow_run, "protected evidence artifact run");
  const id = positiveInteger(artifact.id, "protected evidence artifact id");
  const expectedArchivePath = `repos/${input.repository}/actions/artifacts/${id}/zip`;
  const archiveUrl =
    typeof artifact.archive_download_url === "string"
      ? new URL(artifact.archive_download_url)
      : null;
  if (
    artifact.name !== input.evidenceArtifactName ||
    artifact.expired !== false ||
    typeof artifact.digest !== "string" ||
    !ARTIFACT_DIGEST.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    Number(artifact.size_in_bytes) < 1 ||
    Number(artifact.size_in_bytes) > MAX_ARCHIVE_BYTES ||
    artifactRun.id !== run.id ||
    artifactRun.head_sha !== run.headSha ||
    archiveUrl?.origin !== API_ROOT ||
    archiveUrl.pathname !== `/${expectedArchivePath}`
  ) {
    fail("protected evidence artifact identity is invalid");
  }
  return {
    id,
    name: input.evidenceArtifactName,
    digest: artifact.digest,
    archivePath: expectedArchivePath,
  };
}

async function loadExpectedArtifact(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
  run: WorkflowRun,
): Promise<WorkflowArtifact> {
  const artifacts = await loadCountedPage(
    api,
    `repos/${input.repository}/actions/runs/${run.id}/artifacts`,
    "artifacts",
    "protected run artifacts",
  );
  const matches = artifacts
    .map((value) => collectorRecord(value, "protected evidence artifact"))
    .filter((artifact) => artifact.name === input.evidenceArtifactName);
  if (matches.length !== 1) fail("expected protected artifact identity is missing or duplicated");
  return validateArtifact(matches[0], input, run);
}

async function loadEvidenceEnvelope(
  api: GitHubQualificationReader,
  artifact: WorkflowArtifact,
): Promise<{
  readonly envelope: unknown;
  readonly readReceipt: NativeRuntimeQualificationReceiptReader;
}> {
  const archive = await api.getBytes(artifact.archivePath);
  if (archive.length > MAX_ARCHIVE_BYTES) fail("protected evidence artifact is oversized");
  const actualDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (actualDigest !== artifact.digest) fail("downloaded artifact digest does not match GitHub");
  const source = readValidatedArtifactZipEntry(
    archive,
    NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE,
    { maxBytes: MAX_EVIDENCE_BYTES, maxEntries: MAX_ARCHIVE_ENTRIES },
  );
  if (source === null) fail("artifact does not contain one bounded evidence JSON file");
  let envelope: unknown;
  try {
    envelope = JSON.parse(source) as unknown;
  } catch {
    fail("protected evidence artifact is not valid JSON");
  }
  const cache = new Map<string, Buffer | null>();
  const readReceipt: NativeRuntimeQualificationReceiptReader = (receiptPath) => {
    if (!cache.has(receiptPath)) {
      cache.set(
        receiptPath,
        readValidatedArtifactZipEntryBytes(archive, receiptPath, {
          maxBytes: MAX_RECEIPT_BYTES,
          maxEntries: MAX_ARCHIVE_ENTRIES,
        }),
      );
    }
    return cache.get(receiptPath) ?? null;
  };
  return { envelope, readReceipt };
}

export async function collectNativeRuntimeQualificationEvidence(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<ProtectedNativeRuntimeQualificationAuthority> {
  validateCollectorBoundary(input);
  await assertActorPermission(api, input);
  const pull = await loadPullRequest(api, input);
  await assertMainRevision(api, input);
  const workflow = await loadWorkflow(api, input);
  const run = await loadRun(api, input, workflow);
  const job = await loadExpectedJob(api, input, run);
  const artifact = await loadExpectedArtifact(api, input, run);
  const evidence = await loadEvidenceEnvelope(api, artifact);
  const expected: NativeRuntimeQualificationExpectedSource = {
    repository: input.repository,
    workflow: input.evidenceWorkflow,
    pullRequestNumber: input.pullRequestNumber,
    candidateRepository: pull.candidateRepository,
    headSha: pull.headSha,
    baseRef: "main",
    baseSha: pull.baseSha,
    runId: run.id,
    attempt: run.attempt,
    jobId: job.id,
    artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
  };
  const qualification = compileNativeRuntimeQualification(
    nativeRuntimeQualificationDefinition(input.providerId),
  );
  const authority = consumeNativeRuntimeQualificationEvidence(
    qualification,
    evidence.envelope,
    expected,
    evidence.readReceipt,
  );

  const [confirmedPull, confirmedRun, confirmedArtifact] = await Promise.all([
    loadPullRequest(api, input),
    loadRun(api, input, workflow),
    api.getJson(`repos/${input.repository}/actions/artifacts/${artifact.id}`),
  ]);
  await assertMainRevision(api, input);
  if (
    confirmedPull.candidateRepository !== pull.candidateRepository ||
    confirmedPull.headSha !== pull.headSha ||
    confirmedPull.baseSha !== pull.baseSha ||
    confirmedRun.attempt !== run.attempt
  ) {
    fail("protected source changed while evidence was being collected");
  }
  const confirmed = validateArtifact(confirmedArtifact, input, run);
  if (confirmed.digest !== artifact.digest) fail("protected artifact changed during collection");
  return authority;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) fail("GitHub response is oversized");
  if (response.body === null) fail("GitHub response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maxBytes) {
      await reader.cancel();
      fail("GitHub response exceeded its byte bound");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, total);
}

export function createGitHubQualificationReader(
  token: string,
  fetchImpl: typeof fetch = fetch,
): GitHubQualificationReader {
  if (token.trim() === "") fail("GH_TOKEN is missing");
  const request = async (apiPath: string, maxBytes: number): Promise<Buffer> => {
    const url = `${API_ROOT}/${apiPath}`;
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "NemoClaw-native-runtime-qualification-collector",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return readBoundedResponse(response, maxBytes);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === REQUEST_ATTEMPTS) {
        fail(`GitHub API ${apiPath} returned HTTP ${response.status}`);
      }
      await delay(250 * 2 ** (attempt - 1));
    }
    fail(`GitHub API ${apiPath} exhausted retries`);
  };
  return {
    async getJson(apiPath) {
      const source = await request(apiPath, MAX_API_BYTES);
      try {
        return JSON.parse(source.toString("utf8")) as unknown;
      } catch {
        fail(`GitHub API ${apiPath} did not return valid JSON`);
      }
    },
    getBytes: (apiPath) => request(apiPath, MAX_ARCHIVE_BYTES),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") fail(`environment '${name}' is missing`);
  return value;
}

function environmentInput(): NativeRuntimeQualificationCollectorInput {
  return {
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    actor: requiredEnvironment("GITHUB_ACTOR"),
    eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
    ref: requiredEnvironment("GITHUB_REF"),
    collectorWorkflowRef: requiredEnvironment("GITHUB_WORKFLOW_REF"),
    collectorWorkflowSha: requiredEnvironment("GITHUB_WORKFLOW_SHA"),
    collectorRunId: Number(requiredEnvironment("GITHUB_RUN_ID")),
    providerId: requiredEnvironment("EXPECTED_PROVIDER_ID"),
    pullRequestNumber: Number(requiredEnvironment("EXPECTED_PR_NUMBER")),
    expectedHeadSha: requiredEnvironment("EXPECTED_HEAD_SHA"),
    expectedBaseSha: requiredEnvironment("EXPECTED_BASE_SHA"),
    evidenceWorkflow: requiredEnvironment("EVIDENCE_WORKFLOW"),
    evidenceRunId: Number(requiredEnvironment("EVIDENCE_RUN_ID")),
    evidenceJobName: requiredEnvironment("EVIDENCE_JOB_NAME"),
    evidenceArtifactName: requiredEnvironment("EVIDENCE_ARTIFACT_NAME"),
  };
}

function writeAuthority(authority: ProtectedNativeRuntimeQualificationAuthority): void {
  const outputPath = requiredEnvironment("QUALIFICATION_AUTHORITY_PATH");
  if (!path.isAbsolute(outputPath) || /[\r\n]/u.test(outputPath)) {
    fail("qualification authority output path is invalid");
  }
  writeFileSync(outputPath, `${JSON.stringify(authority, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");
  appendFileSync(
    githubOutput,
    [
      `qualification_id=${authority.qualificationId}`,
      `provider_id=${authority.providerId}`,
      `source_run_id=${authority.source.runId}`,
      `source_run_attempt=${authority.source.attempt}`,
      `source_job_id=${authority.source.jobId}`,
      `source_artifact_id=${authority.source.artifact.id}`,
      `source_artifact_digest=${authority.source.artifact.digest}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function main(): Promise<void> {
  const input = environmentInput();
  const authority = await collectNativeRuntimeQualificationEvidence(
    createGitHubQualificationReader(requiredEnvironment("GH_TOKEN")),
    input,
  );
  writeAuthority(authority);
  console.log(
    `Authenticated ${authority.qualificationId} from protected run ${authority.source.runId} attempt ${authority.source.attempt}, job ${authority.source.jobId}, artifact ${authority.source.artifact.id}.`,
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
