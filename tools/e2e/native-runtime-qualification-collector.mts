// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readValidatedArtifactZipEntries } from "../../scripts/lib/read-artifact-zip.mts";
import {
  compileNativeRuntimeQualification,
  consumeNativeRuntimeQualificationEvidence,
  nativeRuntimeQualificationDefinition,
  type NativeRuntimeQualificationAuthority,
  type NativeRuntimeQualificationExpectedSource,
  type NativeRuntimeQualificationReceiptReader,
} from "../../test/e2e/registry/native-runtime-qualification.ts";

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

function record(value: unknown, label: string): JsonRecord {
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
  const permission = record(
    await api.getJson(
      `repos/${input.repository}/collaborators/${encodeURIComponent(input.actor)}/permission`,
    ),
    "actor permission",
  );
  const user = record(permission.user, "actor permission user");
  if (user.login !== input.actor || !WRITE_PERMISSIONS.has(String(permission.permission))) {
    fail(`actor '${input.actor}' lacks write, maintain, or admin permission`);
  }
}

function validatePullRequest(
  value: unknown,
  input: NativeRuntimeQualificationCollectorInput,
): PullRequestIdentity {
  const pull = record(value, "pull request");
  const head = record(pull.head, "candidate commit");
  const base = record(pull.base, "target-branch base");
  const headRepository = record(head.repo, "candidate repository");
  const baseRepository = record(base.repo, "target repository");
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
  const commit = record(await api.getJson(`repos/${input.repository}/commits/main`), "main commit");
  expectedString(commit.sha, input.expectedBaseSha, "current main SHA");
}

function workflowFile(workflowPath: string): string {
  return workflowPath.slice(workflowPath.lastIndexOf("/") + 1);
}

async function loadWorkflow(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<WorkflowIdentity> {
  const workflow = record(
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
  const run = record(value, "protected workflow run");
  const repository = record(run.repository, "protected workflow run repository");
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
  const page = record(await api.getJson(`${apiPath}?per_page=${PAGE_SIZE}&page=1`), label);
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
    .map((value) => record(value, "protected run job"))
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
  const artifact = record(value, "protected evidence artifact");
  const artifactRun = record(artifact.workflow_run, "protected evidence artifact run");
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
    .map((value) => record(value, "protected evidence artifact"))
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
  const entries = readValidatedArtifactZipEntries(archive, {
    maxEntries: MAX_ARCHIVE_ENTRIES,
    maxTotalUncompressedBytes: MAX_EVIDENCE_BYTES + MAX_ARCHIVE_ENTRIES * MAX_RECEIPT_BYTES,
  });
  if (entries === null) fail("artifact does not contain one bounded evidence JSON file");
  const source = entries
    .find(({ name }) => name === NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE)
    ?.bytes.toString("utf8");
  if (source === undefined) fail("artifact does not contain one bounded evidence JSON file");
  let envelope: unknown;
  try {
    envelope = JSON.parse(source) as unknown;
  } catch {
    fail("protected evidence artifact is not valid JSON");
  }
  const cache = new Map(entries.map(({ name, bytes }) => [name, bytes]));
  const readReceipt: NativeRuntimeQualificationReceiptReader = (receiptPath) => {
    const receipt = cache.get(receiptPath);
    return receipt !== undefined && receipt.length <= MAX_RECEIPT_BYTES ? receipt : null;
  };
  return { envelope, readReceipt };
}

export async function collectNativeRuntimeQualificationEvidence(
  api: GitHubQualificationReader,
  input: NativeRuntimeQualificationCollectorInput,
): Promise<NativeRuntimeQualificationAuthority> {
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

function writeAuthority(authority: NativeRuntimeQualificationAuthority): void {
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
