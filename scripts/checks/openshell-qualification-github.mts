// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { readValidatedArtifactZipEntry } from "../scorecard/read-artifact-zip.mts";
import {
  type ActiveQualificationTestDescriptor,
  assertExactKeys,
  createQualificationReceipt,
  fail,
  isRecord,
  MAX_AUTHORITY_PATHS,
  type ProduceQualificationReceiptInput,
  positiveInteger,
  QUALIFICATION_CONTRACT_SCHEMA_VERSION,
  QUALIFICATION_MAX_ARTIFACT_BYTES,
  QUALIFICATION_MAX_JSON_BYTES,
  QUALIFICATION_RECEIPT_FILE,
  QUALIFICATION_SCOPE,
  QUALIFICATION_SOURCE_RECEIPT_FILE,
  type QualificationArtifactProvenance,
  type QualificationArtifactReader,
  type QualificationContract,
  type QualificationExecutionContext,
  type QualificationGitHubReader,
  type QualificationPhase,
  type QualificationReceipt,
  type QualificationReceiptExpectation,
  type QualificationReceiptJob,
  type QualificationReceiptTest,
  type QualificationResult,
  type QualificationSourceEvent,
  qualificationReceiptContract,
  qualificationTestsForReceipt,
  SAFE_TEXT_PATTERN,
  validateArtifacts,
  validatePhaseExecutionContext,
  validateQualificationContract,
  validateQualificationReceipt,
  validateReceiptJob,
  validateRepository,
  validateRepositoryPath,
  validateResult,
  validateRunUrl,
  validateSha,
  validateSourceEvent,
  validateStringArray,
  validateTokenArray,
  validateWorkflowPath,
} from "./openshell-qualification-core.mts";
import {
  parseBoundedJson,
  readQualificationReceiptArchive,
} from "./openshell-qualification-io.mts";
import {
  type QualificationCellResult,
  validateQualificationCellResults,
} from "./openshell-qualification-matrix.mts";

type QualificationProducerRun = {
  conclusion: QualificationResult;
  displayTitle: string;
  event: string;
  headBranch: string;
  headSha: string;
  id: number;
  path: string;
  repository: string;
  runAttempt: number;
  status: string;
  url: string;
  workflowId: number;
};

type QualificationProducerRunInventoryEntry = {
  displayTitle: string;
  id: number;
  value: Record<string, unknown>;
  workflowId: number;
};

type QualificationProducerArtifact = {
  archivePath: string;
  expired: boolean;
  id: number;
  name: string;
  runId: number;
  workflowSha: string;
};

type QualificationSourceAuthenticationOptions = {
  historicalReleaseAuthoritySha?: string;
};

type FinalQualificationAuthenticationOptions = QualificationSourceAuthenticationOptions & {
  expectedReceiptBytes?: Buffer;
};

function validateQualificationProducerRun(
  value: unknown,
  receipt: QualificationReceipt,
  contract: QualificationContract,
  workflowId: number,
): QualificationProducerRun {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    !positiveInteger(value.run_attempt) ||
    value.workflow_id !== workflowId ||
    typeof value.display_title !== "string" ||
    !SAFE_TEXT_PATTERN.test(value.display_title) ||
    typeof value.event !== "string" ||
    typeof value.head_branch !== "string" ||
    typeof value.head_sha !== "string" ||
    typeof value.path !== "string" ||
    typeof value.status !== "string" ||
    typeof value.html_url !== "string" ||
    !isRecord(value.repository) ||
    value.repository.full_name !== receipt.repository
  ) {
    fail("trusted release producer workflow run is malformed or belongs to another repository");
  }
  const conclusion = githubResult(value.conclusion, "trusted release producer workflow run");
  const url = validateRunUrl(
    value.html_url,
    receipt.repository,
    "trusted release producer workflow run URL",
  );
  const expectedTitle = `OpenShell 0.0.101 release candidate ${receipt.candidateSha} base ${receipt.baseSha}`;
  if (
    String(value.id) !== receipt.trustedProducerRunId ||
    value.run_attempt !== receipt.trustedProducerRunAttempt ||
    value.event !== "workflow_dispatch" ||
    value.head_branch !== "main" ||
    value.head_sha !== receipt.candidateSha ||
    value.path !== contract.trustedProducerWorkflowPath ||
    value.status !== "completed" ||
    conclusion !== "success" ||
    value.display_title !== expectedTitle ||
    url !== `https://github.com/${receipt.repository}/actions/runs/${value.id}` ||
    receipt.trustedProducerRunUrl !== `${url}/attempts/${value.run_attempt}`
  ) {
    fail("trusted release producer workflow run is stale, unsuccessful, or identity-mismatched");
  }
  return {
    conclusion,
    displayTitle: value.display_title,
    event: value.event,
    headBranch: value.head_branch,
    headSha: value.head_sha,
    id: value.id,
    path: value.path,
    repository: receipt.repository,
    runAttempt: value.run_attempt,
    status: value.status,
    url,
    workflowId,
  };
}

function validateQualificationProducerRunInventoryEntry(
  value: unknown,
): QualificationProducerRunInventoryEntry {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    !positiveInteger(value.workflow_id) ||
    typeof value.display_title !== "string" ||
    !SAFE_TEXT_PATTERN.test(value.display_title)
  ) {
    fail("trusted release producer workflow-runs response contains a malformed inventory entry");
  }
  return {
    displayTitle: value.display_title,
    id: value.id,
    value,
    workflowId: value.workflow_id,
  };
}

function validateQualificationProducerWorkflow(
  value: unknown,
  contract: QualificationContract,
): number {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    value.path !== contract.trustedProducerWorkflowPath ||
    value.state !== "active"
  ) {
    fail("trusted release producer workflow identity is malformed or inactive");
  }
  return value.id;
}

async function loadNewestFinalProducerRun(
  api: QualificationArtifactReader,
  receipt: QualificationReceipt,
  contract: QualificationContract,
  workflowId: number,
): Promise<QualificationProducerRun> {
  const workflowFile = path.posix.basename(contract.trustedProducerWorkflowPath);
  const runsValue = await api.getJson(
    `repos/${receipt.repository}/actions/workflows/${workflowFile}/runs?branch=main&event=workflow_dispatch&head_sha=${receipt.candidateSha}&per_page=100&page=1`,
  );
  if (
    !isRecord(runsValue) ||
    !Number.isSafeInteger(runsValue.total_count) ||
    (runsValue.total_count as number) < 0 ||
    (runsValue.total_count as number) > 100 ||
    !Array.isArray(runsValue.workflow_runs) ||
    runsValue.workflow_runs.length !== runsValue.total_count
  ) {
    fail("trusted release producer workflow-runs response is malformed or oversized");
  }
  const expectedTitle = `OpenShell 0.0.101 release candidate ${receipt.candidateSha} base ${receipt.baseSha}`;
  const matching = runsValue.workflow_runs
    .map(validateQualificationProducerRunInventoryEntry)
    .filter((run) => run.workflowId === workflowId && run.displayTitle === expectedTitle)
    .sort((left, right) => right.id - left.id);
  const newest = matching[0];
  if (!newest) fail("no exact release producer workflow run was found");
  return validateQualificationProducerRun(newest.value, receipt, contract, workflowId);
}

function validateQualificationProducerArtifact(
  value: unknown,
  receipt: QualificationReceipt,
): QualificationProducerArtifact {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    typeof value.name !== "string" ||
    typeof value.expired !== "boolean" ||
    typeof value.archive_download_url !== "string" ||
    !isRecord(value.workflow_run) ||
    !positiveInteger(value.workflow_run.id) ||
    typeof value.workflow_run.head_sha !== "string"
  ) {
    fail("trusted release producer artifact is malformed");
  }
  const archivePath = `repos/${value.archive_download_url.split("/repos/")[1] ?? ""}`;
  if (archivePath !== `repos/${receipt.repository}/actions/artifacts/${value.id}/zip`) {
    fail("trusted release producer artifact download URL is mismatched");
  }
  return {
    archivePath,
    expired: value.expired,
    id: value.id,
    name: value.name,
    runId: value.workflow_run.id,
    workflowSha: validateSha(
      value.workflow_run.head_sha,
      "trusted release producer artifact workflow SHA",
    ),
  };
}

export async function authenticateFinalQualificationReceipt(
  receiptValue: QualificationReceipt | unknown,
  contractValue: QualificationContract | unknown,
  expected: QualificationReceiptExpectation,
  api: QualificationArtifactReader,
  options: FinalQualificationAuthenticationOptions = {},
): Promise<QualificationReceipt> {
  const contract = validateQualificationContract(contractValue);
  const receipt = validateQualificationReceipt(receiptValue, contract, expected);
  if (receipt.phase !== "final" || receipt.executionContext !== "release") {
    fail("live producer authentication requires a release receipt");
  }
  const workflowFile = path.posix.basename(contract.trustedProducerWorkflowPath);
  const workflowId = validateQualificationProducerWorkflow(
    await api.getJson(`repos/${receipt.repository}/actions/workflows/${workflowFile}`),
    contract,
  );
  const run = await loadNewestFinalProducerRun(api, receipt, contract, workflowId);
  const artifactsValue = await api.getJson(
    `repos/${receipt.repository}/actions/runs/${run.id}/artifacts?per_page=100&page=1`,
  );
  if (
    !isRecord(artifactsValue) ||
    !Number.isSafeInteger(artifactsValue.total_count) ||
    (artifactsValue.total_count as number) < 0 ||
    (artifactsValue.total_count as number) > 100 ||
    !Array.isArray(artifactsValue.artifacts) ||
    artifactsValue.artifacts.length !== artifactsValue.total_count
  ) {
    fail("trusted release producer artifacts response is malformed or oversized");
  }
  const expectedName = `openshell-0.0.101-qualification-release-${run.id}-${run.runAttempt}`;
  const artifacts = artifactsValue.artifacts
    .map((artifact) => validateQualificationProducerArtifact(artifact, receipt))
    .filter((artifact) => artifact.name === expectedName);
  if (
    artifacts.length !== 1 ||
    artifacts[0]?.expired ||
    artifacts[0]?.runId !== run.id ||
    artifacts[0]?.workflowSha !== receipt.candidateSha
  ) {
    fail(
      "trusted release producer receipt artifact is missing, duplicated, expired, or mismatched",
    );
  }
  const artifact = artifacts[0] as QualificationProducerArtifact;
  const archive = await api.getBytes(artifact.archivePath);
  if (options.expectedReceiptBytes !== undefined) {
    if (
      !Buffer.isBuffer(options.expectedReceiptBytes) ||
      options.expectedReceiptBytes.length === 0 ||
      options.expectedReceiptBytes.length > QUALIFICATION_MAX_JSON_BYTES
    ) {
      fail("local release qualification receipt bytes are invalid or oversized");
    }
    const archivedReceiptBytes = readValidatedArtifactZipEntry(
      archive,
      QUALIFICATION_RECEIPT_FILE,
      {
        maxBytes: QUALIFICATION_MAX_JSON_BYTES,
        maxEntries: 1,
      },
    );
    if (
      archivedReceiptBytes === null ||
      !Buffer.from(archivedReceiptBytes).equals(options.expectedReceiptBytes)
    ) {
      fail(
        "local release qualification receipt bytes do not match the authenticated Actions artifact",
      );
    }
  }
  const archivedReceipt = readQualificationReceiptArchive(archive, contract, expected);
  if (JSON.stringify(archivedReceipt) !== JSON.stringify(receipt)) {
    fail("local release qualification receipt does not match the authenticated Actions artifact");
  }
  await authenticateQualificationReceiptSources(receipt, contract, expected, api, options);
  const recheckedRun = await loadNewestFinalProducerRun(api, receipt, contract, workflowId);
  if (recheckedRun.id !== run.id || recheckedRun.runAttempt !== run.runAttempt) {
    fail("trusted release producer workflow run changed during receipt authentication");
  }
  await authenticateQualificationReceiptSources(receipt, contract, expected, api, options);
  const finalRun = await loadNewestFinalProducerRun(api, receipt, contract, workflowId);
  if (finalRun.id !== run.id || finalRun.runAttempt !== run.runAttempt) {
    fail("trusted release producer workflow run changed after source authentication");
  }
  return receipt;
}

type SourceWorkflowRun = {
  conclusion: QualificationResult | null;
  displayTitle: string;
  event: QualificationSourceEvent;
  headBranch: string;
  headSha: string;
  id: number;
  path: string;
  pullRequests: unknown[];
  repository: string;
  runAttempt: number;
  status: string;
  url: string;
  workflowId: number;
};

type SourceWorkflowJob = {
  conclusion: QualificationResult;
  id: number;
  name: string;
  runAttempt: number;
  runId: number;
  status: string;
  url: string;
};

type SourceWorkflowArtifact = {
  archivePath: string;
  expired: boolean;
  id: number;
  name: string;
  runId: number;
  workflowSha: string;
};

type QualificationSourceReceiptTest = {
  cells: QualificationCellResult[];
  id: string;
  jobs: QualificationReceiptJob[];
  requiredCases: string[];
  requiredDimensions: string[];
  result: QualificationResult;
};

type QualificationSourceReceipt = {
  artifacts: QualificationArtifactProvenance[];
  authorityPaths: string[];
  baseSha: string;
  candidateSha: string;
  controllerSha: string;
  event: QualificationSourceEvent;
  executionContext: QualificationExecutionContext;
  openshellCommitSha: string;
  openshellVersion: string;
  phase: QualificationPhase;
  prNumber: number | null;
  repository: string;
  result: QualificationResult;
  runAttempt: number;
  runId: string;
  runUrl: string;
  schemaVersion: typeof QUALIFICATION_CONTRACT_SCHEMA_VERSION;
  scope: typeof QUALIFICATION_SCOPE;
  tests: QualificationSourceReceiptTest[];
  workflowId: number;
  workflowPath: string;
};

type GitTreeEntry = {
  mode: "100644" | "100755";
  path: string;
  sha: string;
};

function githubResult(value: unknown, label: string): QualificationResult {
  return validateResult(value, label);
}

function expectedSourceRunTitle(
  executionContext: QualificationExecutionContext,
  candidateSha: string,
  baseSha: string,
): string {
  return `OpenShell 0.0.101 ${executionContext} source candidate ${candidateSha} base ${baseSha}`;
}

function expectedSourceRunHeadSha(
  executionContext: QualificationExecutionContext,
  event: QualificationSourceEvent,
  candidateSha: string,
  baseSha: string,
): string {
  return executionContext !== "release" && event === "workflow_dispatch" ? baseSha : candidateSha;
}

function validateSourceWorkflowRun(
  value: unknown,
  repository: string,
  descriptor: ActiveQualificationTestDescriptor,
  input: ProduceQualificationReceiptInput,
): SourceWorkflowRun {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    !positiveInteger(value.run_attempt) ||
    value.workflow_id !== descriptor.source.workflowId ||
    typeof value.display_title !== "string" ||
    typeof value.event !== "string" ||
    typeof value.status !== "string" ||
    typeof value.head_branch !== "string" ||
    typeof value.head_sha !== "string" ||
    typeof value.path !== "string" ||
    typeof value.html_url !== "string" ||
    !Array.isArray(value.pull_requests) ||
    !isRecord(value.repository) ||
    value.repository.full_name !== repository
  ) {
    fail("source workflow-run response is malformed or belongs to another repository");
  }
  const url = validateRunUrl(value.html_url, repository, "source workflow run URL");
  if (url !== `https://github.com/${repository}/actions/runs/${value.id}`) {
    fail("source workflow-run URL and ID are mismatched");
  }
  const event = validateSourceEvent(value.event);
  const expectedHeadSha = expectedSourceRunHeadSha(
    input.executionContext,
    descriptor.source.event,
    input.candidateSha,
    input.baseSha,
  );
  if (
    value.display_title !==
      expectedSourceRunTitle(input.executionContext, input.candidateSha, input.baseSha) ||
    event !== descriptor.source.event ||
    value.path !== descriptor.source.workflowPath ||
    ((event === "workflow_dispatch" || event === "push") && value.head_branch !== "main") ||
    value.head_sha !== expectedHeadSha
  ) {
    fail(`qualification source run ${value.id} identity is mismatched`);
  }
  if (event === "pull_request") {
    const pullRequest = value.pull_requests[0];
    if (
      value.pull_requests.length !== 1 ||
      !isRecord(pullRequest) ||
      pullRequest.number !== input.prNumber ||
      !isRecord(pullRequest.base) ||
      pullRequest.base.sha !== input.baseSha ||
      !isRecord(pullRequest.head) ||
      pullRequest.head.sha !== input.candidateSha
    ) {
      fail(`qualification source run ${value.id} pull-request identity is mismatched`);
    }
  }
  return {
    conclusion:
      value.conclusion === null
        ? null
        : githubResult(value.conclusion, `source workflow run ${value.id}`),
    displayTitle: value.display_title,
    event,
    headBranch: value.head_branch,
    headSha: validateSha(value.head_sha, `source workflow run ${value.id} head SHA`),
    id: value.id,
    path: validateWorkflowPath(value.path),
    pullRequests: value.pull_requests,
    repository,
    runAttempt: value.run_attempt,
    status: value.status,
    url,
    workflowId: descriptor.source.workflowId,
  };
}

function validateSourceWorkflowJob(
  value: unknown,
  repository: string,
  expectedName: string,
  run: SourceWorkflowRun,
): SourceWorkflowJob {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    value.run_id !== run.id ||
    value.run_attempt !== run.runAttempt ||
    value.head_sha !== run.headSha ||
    value.name !== expectedName ||
    typeof value.status !== "string" ||
    typeof value.html_url !== "string"
  ) {
    fail(`qualification source job ${expectedName} GitHub Actions identity is mismatched`);
  }
  const url = validateRunUrl(value.html_url, repository, `source job ${expectedName} URL`);
  const conclusion = githubResult(value.conclusion, `source job ${expectedName}`);
  if (value.status !== "completed" || conclusion !== "success") {
    fail(`qualification source job ${expectedName} is incomplete or unsuccessful`);
  }
  return {
    conclusion,
    id: value.id,
    name: expectedName,
    runAttempt: run.runAttempt,
    runId: run.id,
    status: value.status,
    url,
  };
}

async function loadSourceWorkflowRuns(
  api: QualificationGitHubReader,
  descriptor: ActiveQualificationTestDescriptor,
  input: ProduceQualificationReceiptInput,
): Promise<SourceWorkflowRun[]> {
  const runs: SourceWorkflowRun[] = [];
  const ids = new Set<number>();
  for (let page = 1; page <= 10; page += 1) {
    const value = await api.getJson(
      `repos/${input.repository}/actions/workflows/${descriptor.source.workflowId}/runs?event=${descriptor.source.event}&head_sha=${expectedSourceRunHeadSha(input.executionContext, descriptor.source.event, input.candidateSha, input.baseSha)}&per_page=100&page=${page}`,
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value.workflow_runs) ||
      value.workflow_runs.length > 100
    ) {
      fail(`qualification source workflow-runs page ${page} is malformed`);
    }
    for (const entry of value.workflow_runs) {
      if (
        !isRecord(entry) ||
        !positiveInteger(entry.id) ||
        typeof entry.display_title !== "string"
      ) {
        fail(`qualification source workflow-runs page ${page} has a malformed entry`);
      }
      if (
        entry.display_title !==
        expectedSourceRunTitle(input.executionContext, input.candidateSha, input.baseSha)
      ) {
        continue;
      }
      const run = validateSourceWorkflowRun(entry, input.repository, descriptor, input);
      if (ids.has(run.id)) fail(`qualification source run ${run.id} is duplicated`);
      ids.add(run.id);
      runs.push(run);
    }
    if (value.workflow_runs.length < 100) return runs;
  }
  fail("qualification source workflow-runs pagination is incomplete or oversized");
}

async function loadNewestSourceWorkflowRun(
  api: QualificationGitHubReader,
  descriptor: ActiveQualificationTestDescriptor,
  input: ProduceQualificationReceiptInput,
): Promise<SourceWorkflowRun> {
  const runs = await loadSourceWorkflowRuns(api, descriptor, input);
  const newest = runs.sort((left, right) => right.id - left.id)[0];
  if (!newest) fail(`qualification source run for ${descriptor.id} is missing`);
  if (newest.status !== "completed" || newest.conclusion !== "success") {
    fail(
      `newest qualification source run ${newest.id} for ${descriptor.id} is not successful (${newest.status}/${newest.conclusion ?? "none"})`,
    );
  }
  return newest;
}

async function validateSourceWorkflowIdentity(
  api: QualificationGitHubReader,
  repository: string,
  descriptor: ActiveQualificationTestDescriptor,
): Promise<void> {
  const value = await api.getJson(
    `repos/${repository}/actions/workflows/${descriptor.source.workflowId}`,
  );
  if (
    !isRecord(value) ||
    value.id !== descriptor.source.workflowId ||
    value.path !== descriptor.source.workflowPath ||
    value.state !== "active"
  ) {
    fail(`qualification source workflow for ${descriptor.id} is malformed or inactive`);
  }
}

async function loadSourceRunJobs(
  api: QualificationGitHubReader,
  repository: string,
  run: SourceWorkflowRun,
  descriptor: ActiveQualificationTestDescriptor,
): Promise<SourceWorkflowJob[]> {
  const inventory: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const value = await api.getJson(
      `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    if (!isRecord(value) || !Array.isArray(value.jobs) || value.jobs.length > 100) {
      fail(`qualification source run ${run.id} jobs page ${page} is malformed`);
    }
    for (const job of value.jobs) {
      if (!isRecord(job)) fail(`qualification source run ${run.id} has a malformed job`);
      inventory.push(job);
    }
    if (value.jobs.length < 100) break;
    if (page === 10) fail(`qualification source run ${run.id} jobs are oversized`);
  }
  return descriptor.source.jobNames.map((name) => {
    const matching = inventory.filter((job) => job.name === name);
    if (matching.length !== 1) {
      fail(`qualification source job ${name} is missing, ambiguous, or duplicated`);
    }
    return validateSourceWorkflowJob(matching[0], repository, name, run);
  });
}

function validateSourceWorkflowArtifact(
  value: unknown,
  repository: string,
): SourceWorkflowArtifact {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    typeof value.name !== "string" ||
    typeof value.expired !== "boolean" ||
    typeof value.archive_download_url !== "string" ||
    !isRecord(value.workflow_run) ||
    !positiveInteger(value.workflow_run.id) ||
    typeof value.workflow_run.head_sha !== "string"
  ) {
    fail("qualification source artifact is malformed");
  }
  const archivePath = `repos/${value.archive_download_url.split("/repos/")[1] ?? ""}`;
  if (archivePath !== `repos/${repository}/actions/artifacts/${value.id}/zip`) {
    fail("qualification source artifact download URL is mismatched");
  }
  return {
    archivePath,
    expired: value.expired,
    id: value.id,
    name: value.name,
    runId: value.workflow_run.id,
    workflowSha: validateSha(value.workflow_run.head_sha, "qualification source artifact SHA"),
  };
}

async function loadSourceRunArtifact(
  api: QualificationGitHubReader,
  repository: string,
  run: SourceWorkflowRun,
  executionContext: QualificationExecutionContext,
): Promise<Buffer> {
  const value = await api.getJson(
    `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100&page=1`,
  );
  if (
    !isRecord(value) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > 100 ||
    value.total_count !== value.artifacts.length
  ) {
    fail(`qualification source run ${run.id} artifacts response is malformed or oversized`);
  }
  const expectedName = `openshell-0.0.101-qualification-source-${executionContext}-${run.id}-${run.runAttempt}`;
  const artifacts = value.artifacts
    .map((artifact) => validateSourceWorkflowArtifact(artifact, repository))
    .filter((artifact) => artifact.name === expectedName);
  const artifact = artifacts[0];
  if (
    artifacts.length !== 1 ||
    !artifact ||
    artifact.expired ||
    artifact.runId !== run.id ||
    artifact.workflowSha !== run.headSha
  ) {
    fail(
      `qualification source run ${run.id} artifact is missing, duplicated, expired, or mismatched`,
    );
  }
  return api.getBytes(artifact.archivePath);
}

function validateSourceReceiptTest(
  value: unknown,
  repository: string,
  descriptor: ActiveQualificationTestDescriptor,
  liveJobs: SourceWorkflowJob[],
): QualificationSourceReceiptTest {
  if (!isRecord(value)) fail(`qualification source receipt test ${descriptor.id} is malformed`);
  assertExactKeys(
    value,
    ["cells", "id", "jobs", "requiredCases", "requiredDimensions", "result"],
    `qualification source receipt test ${descriptor.id}`,
  );
  if (value.id !== descriptor.id || value.result !== "success" || !Array.isArray(value.jobs)) {
    fail(`qualification source receipt test ${descriptor.id} identity or result is mismatched`);
  }
  const jobs = value.jobs.map((job) => validateReceiptJob(job, repository, descriptor.id));
  const expectedJobs = liveJobs.map((job) => ({
    name: job.name,
    result: job.conclusion,
    url: job.url,
  }));
  const requiredCases = validateTokenArray(
    value.requiredCases,
    `qualification source receipt test ${descriptor.id} requiredCases`,
  );
  const requiredDimensions = validateTokenArray(
    value.requiredDimensions,
    `qualification source receipt test ${descriptor.id} requiredDimensions`,
  );
  if (
    JSON.stringify(jobs) !== JSON.stringify(expectedJobs) ||
    JSON.stringify(requiredCases) !== JSON.stringify(descriptor.requiredCases) ||
    JSON.stringify(requiredDimensions) !== JSON.stringify(descriptor.requiredDimensions)
  ) {
    fail(`qualification source receipt test ${descriptor.id} semantic evidence is mismatched`);
  }
  const cells = validateQualificationCellResults(
    value.cells,
    descriptor.matrix,
    descriptor.approvedExceptions,
    repository,
    descriptor.id,
    new Set(jobs.map((job) => job.url)),
  );
  return { cells, id: descriptor.id, jobs, requiredCases, requiredDimensions, result: "success" };
}

function validateQualificationSourceReceipt(
  value: unknown,
  contract: QualificationContract,
  descriptor: ActiveQualificationTestDescriptor,
  input: ProduceQualificationReceiptInput,
  run: SourceWorkflowRun,
  liveJobs: SourceWorkflowJob[],
): QualificationSourceReceipt {
  if (!isRecord(value)) fail(`qualification source receipt for ${descriptor.id} is not an object`);
  assertExactKeys(
    value,
    [
      "artifacts",
      "authorityPaths",
      "baseSha",
      "candidateSha",
      "controllerSha",
      "event",
      "executionContext",
      "openshellCommitSha",
      "openshellVersion",
      "phase",
      "prNumber",
      "repository",
      "result",
      "runAttempt",
      "runId",
      "runUrl",
      "schemaVersion",
      "scope",
      "tests",
      "workflowId",
      "workflowPath",
    ],
    `qualification source receipt for ${descriptor.id}`,
  );
  const authorityPaths = validateStringArray(
    value.authorityPaths,
    `qualification source receipt for ${descriptor.id} authorityPaths`,
    validateRepositoryPath,
  );
  const artifacts = validateArtifacts(value.artifacts);
  const expectedControllerSha =
    input.executionContext === "release" ? input.candidateSha : input.baseSha;
  const expectedPrNumber = input.executionContext === "release" ? null : input.prNumber;
  if (
    value.schemaVersion !== QUALIFICATION_CONTRACT_SCHEMA_VERSION ||
    value.scope !== QUALIFICATION_SCOPE ||
    value.repository !== input.repository ||
    value.phase !== input.phase ||
    value.executionContext !== input.executionContext ||
    value.event !== descriptor.source.event ||
    value.prNumber !== expectedPrNumber ||
    value.baseSha !== input.baseSha ||
    value.candidateSha !== input.candidateSha ||
    value.controllerSha !== expectedControllerSha ||
    value.workflowId !== descriptor.source.workflowId ||
    value.workflowPath !== descriptor.source.workflowPath ||
    value.runId !== String(run.id) ||
    value.runAttempt !== run.runAttempt ||
    value.runUrl !== `${run.url}/attempts/${run.runAttempt}` ||
    value.openshellVersion !== contract.openshellTargetVersion ||
    value.openshellCommitSha !== contract.openshellTargetCommitSha ||
    value.result !== "success" ||
    JSON.stringify(artifacts) !== JSON.stringify(contract.artifacts) ||
    JSON.stringify(authorityPaths) !== JSON.stringify(descriptor.source.authorityPaths) ||
    !Array.isArray(value.tests)
  ) {
    fail(`qualification source receipt for ${descriptor.id} is stale or identity-mismatched`);
  }
  const matching = value.tests.filter((test) => isRecord(test) && test.id === descriptor.id);
  if (matching.length !== 1) {
    fail(`qualification source receipt test ${descriptor.id} is missing or duplicated`);
  }
  const test = validateSourceReceiptTest(matching[0], input.repository, descriptor, liveJobs);
  return {
    artifacts,
    authorityPaths,
    baseSha: input.baseSha,
    candidateSha: input.candidateSha,
    controllerSha: expectedControllerSha,
    event: descriptor.source.event,
    executionContext: input.executionContext,
    openshellCommitSha: contract.openshellTargetCommitSha,
    openshellVersion: contract.openshellTargetVersion,
    phase: input.phase,
    prNumber: expectedPrNumber ?? null,
    repository: input.repository,
    result: "success",
    runAttempt: run.runAttempt,
    runId: String(run.id),
    runUrl: `${run.url}/attempts/${run.runAttempt}`,
    schemaVersion: QUALIFICATION_CONTRACT_SCHEMA_VERSION,
    scope: QUALIFICATION_SCOPE,
    tests: [test],
    workflowId: descriptor.source.workflowId,
    workflowPath: descriptor.source.workflowPath,
  };
}

function parseQualificationSourceReceiptArchive(archive: Buffer): unknown {
  if (archive.length > QUALIFICATION_MAX_ARTIFACT_BYTES) {
    fail("qualification source artifact is oversized");
  }
  const source = readValidatedArtifactZipEntry(archive, QUALIFICATION_SOURCE_RECEIPT_FILE, {
    maxBytes: QUALIFICATION_MAX_JSON_BYTES,
    maxEntries: 1,
  });
  if (source === null) fail("qualification source artifact archive is malformed or ambiguous");
  return parseBoundedJson(source, "qualification source receipt");
}

async function loadGitTree(
  api: QualificationGitHubReader,
  repository: string,
  commitSha: string,
): Promise<Map<string, GitTreeEntry>> {
  const value = await api.getJson(`repos/${repository}/git/trees/${commitSha}?recursive=1`);
  if (!isRecord(value) || value.truncated !== false || !Array.isArray(value.tree)) {
    fail(`qualification authority tree ${commitSha} is malformed or truncated`);
  }
  const entries = new Map<string, GitTreeEntry>();
  for (const item of value.tree) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const itemPath = validateRepositoryPath(item.path, "qualification authority tree path");
    if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755")) continue;
    if (entries.has(itemPath)) fail(`qualification authority tree path ${itemPath} is duplicated`);
    entries.set(itemPath, {
      mode: item.mode,
      path: itemPath,
      sha: validateSha(item.sha, `qualification authority path ${itemPath} blob SHA`),
    });
  }
  return entries;
}

export async function authenticateQualificationAuthorityPaths(
  api: QualificationGitHubReader,
  repository: string,
  baseSha: string,
  candidateSha: string,
  authorityPaths: readonly string[],
): Promise<void> {
  validateRepository(repository);
  validateSha(baseSha, "qualification authority base SHA");
  validateSha(candidateSha, "qualification authority candidate SHA");
  if (authorityPaths.length === 0 || authorityPaths.length > MAX_AUTHORITY_PATHS) {
    fail("qualification authority path inventory is empty or oversized");
  }
  const paths = authorityPaths.map((authorityPath) =>
    validateRepositoryPath(authorityPath, "qualification authority path"),
  );
  if (new Set(paths).size !== paths.length) fail("qualification authority paths are duplicated");
  const [baseTree, candidateTree] = await Promise.all([
    loadGitTree(api, repository, baseSha),
    loadGitTree(api, repository, candidateSha),
  ]);
  for (const authorityPath of paths) {
    const base = baseTree.get(authorityPath);
    const candidate = candidateTree.get(authorityPath);
    if (!base || !candidate || base.sha !== candidate.sha || base.mode !== candidate.mode) {
      fail(`qualification authority path ${authorityPath} changed or is not a regular blob`);
    }
  }
}

function validateAuthorityPathsUnchanged(
  descriptor: ActiveQualificationTestDescriptor,
  baseTree: Map<string, GitTreeEntry>,
  candidateTree: Map<string, GitTreeEntry>,
): void {
  for (const authorityPath of descriptor.source.authorityPaths) {
    const base = baseTree.get(authorityPath);
    const candidate = candidateTree.get(authorityPath);
    if (!base || !candidate || base.sha !== candidate.sha || base.mode !== candidate.mode) {
      fail(`qualification authority path ${authorityPath} changed or is not a regular file`);
    }
  }
}

async function validateCandidateIdentity(
  api: QualificationGitHubReader,
  input: ProduceQualificationReceiptInput,
  options: QualificationSourceAuthenticationOptions = {},
): Promise<void> {
  validatePhaseExecutionContext(input.phase, input.executionContext);
  if (input.executionContext !== "release") {
    if (options.historicalReleaseAuthoritySha !== undefined) {
      fail("historical release authority is valid only for release receipt authentication");
    }
    if (!positiveInteger(input.prNumber)) {
      fail(`${input.executionContext} receipt requires a positive PR number`);
    }
    const value = await api.getJson(`repos/${input.repository}/pulls/${input.prNumber}`);
    if (
      !isRecord(value) ||
      value.number !== input.prNumber ||
      value.state !== "open" ||
      !isRecord(value.head) ||
      !isRecord(value.head.repo) ||
      !isRecord(value.base) ||
      !isRecord(value.base.repo) ||
      value.head.sha !== input.candidateSha ||
      value.head.repo.full_name !== input.repository ||
      value.base.sha !== input.baseSha ||
      value.base.ref !== "main" ||
      value.base.repo.full_name !== input.repository
    ) {
      fail(`live ${input.executionContext} pull-request identity is closed, stale, or mismatched`);
    }
    return;
  }
  if (input.prNumber !== undefined) fail("release receipt must not carry a pull-request number");
  const expectedMainSha = options.historicalReleaseAuthoritySha ?? input.candidateSha;
  validateSha(expectedMainSha, "release receipt current authority SHA");
  const reference = await api.getJson(`repos/${input.repository}/git/ref/heads/main`);
  if (
    !isRecord(reference) ||
    !isRecord(reference.object) ||
    reference.object.sha !== expectedMainSha
  ) {
    fail(
      options.historicalReleaseAuthoritySha === undefined
        ? "release receipt candidate is not the exact current main commit"
        : "retirement authority is not the exact current main commit",
    );
  }
  const commit = await api.getJson(`repos/${input.repository}/commits/${input.candidateSha}`);
  if (
    !isRecord(commit) ||
    !Array.isArray(commit.parents) ||
    commit.parents.length === 0 ||
    !isRecord(commit.parents[0]) ||
    commit.parents[0].sha !== input.baseSha
  ) {
    fail("release receipt base is not the exact first parent of the main candidate");
  }
}

async function collectAuthenticatedQualificationSourceTests(
  contract: QualificationContract,
  input: ProduceQualificationReceiptInput,
  api: QualificationGitHubReader,
): Promise<QualificationReceiptTest[]> {
  const descriptors = qualificationTestsForReceipt(contract, input.phase);
  const baseTree =
    descriptors.length === 0
      ? new Map<string, GitTreeEntry>()
      : await loadGitTree(api, input.repository, input.baseSha);
  const candidateTree =
    descriptors.length === 0
      ? new Map<string, GitTreeEntry>()
      : await loadGitTree(api, input.repository, input.candidateSha);
  const tests: QualificationReceiptTest[] = [];
  const selectedRuns: Array<{
    descriptor: ActiveQualificationTestDescriptor;
    run: SourceWorkflowRun;
  }> = [];
  for (const descriptor of descriptors) {
    validateAuthorityPathsUnchanged(descriptor, baseTree, candidateTree);
    await validateSourceWorkflowIdentity(api, input.repository, descriptor);
    const run = await loadNewestSourceWorkflowRun(api, descriptor, input);
    const jobs = await loadSourceRunJobs(api, input.repository, run, descriptor);
    const sourceReceipt = validateQualificationSourceReceipt(
      parseQualificationSourceReceiptArchive(
        await loadSourceRunArtifact(api, input.repository, run, input.executionContext),
      ),
      contract,
      descriptor,
      input,
      run,
      jobs,
    );
    selectedRuns.push({ descriptor, run });
    tests.push({
      id: descriptor.id,
      result: "success",
      runs: [
        {
          authorityPaths: sourceReceipt.authorityPaths,
          baseSha: sourceReceipt.baseSha,
          candidateSha: sourceReceipt.candidateSha,
          cells: sourceReceipt.tests[0]?.cells ?? [],
          controllerSha: sourceReceipt.controllerSha,
          event: sourceReceipt.event,
          executionContext: sourceReceipt.executionContext,
          jobs: sourceReceipt.tests[0]?.jobs ?? [],
          openshellCommitSha: sourceReceipt.openshellCommitSha,
          openshellVersion: sourceReceipt.openshellVersion,
          phase: sourceReceipt.phase,
          prNumber: sourceReceipt.prNumber,
          requiredCases: sourceReceipt.tests[0]?.requiredCases ?? [],
          requiredDimensions: sourceReceipt.tests[0]?.requiredDimensions ?? [],
          result: sourceReceipt.result,
          runAttempt: sourceReceipt.runAttempt,
          runId: sourceReceipt.runId,
          runUrl: sourceReceipt.runUrl,
          workflowId: sourceReceipt.workflowId,
          workflowPath: sourceReceipt.workflowPath,
        },
      ],
    });
  }
  for (const { descriptor, run } of selectedRuns) {
    const rechecked = await loadNewestSourceWorkflowRun(api, descriptor, input);
    if (rechecked.id !== run.id || rechecked.runAttempt !== run.runAttempt) {
      fail(`qualification source run for ${descriptor.id} changed during authentication`);
    }
  }
  return tests;
}

export async function authenticateQualificationReceiptSources(
  receiptValue: QualificationReceipt | unknown,
  contractValue: QualificationContract | unknown,
  expected: QualificationReceiptExpectation,
  api: QualificationGitHubReader,
  options: QualificationSourceAuthenticationOptions = {},
): Promise<QualificationReceipt> {
  const contract = validateQualificationContract(contractValue);
  const receipt = validateQualificationReceipt(receiptValue, contract, expected);
  const input: ProduceQualificationReceiptInput = {
    ...expected,
    candidateContract: contract,
    trustedProducerRunAttempt: receipt.trustedProducerRunAttempt,
    trustedProducerRunId: receipt.trustedProducerRunId,
    trustedProducerRunUrl: receipt.trustedProducerRunUrl,
    trustedProducerWorkflowSha: receipt.trustedProducerWorkflowSha,
  };
  validateRepository(input.repository);
  validateSha(input.candidateSha, "source authentication candidate SHA");
  validateSha(input.baseSha, "source authentication base SHA");
  await validateCandidateIdentity(api, input, options);
  const authenticatedTests = await collectAuthenticatedQualificationSourceTests(
    contract,
    input,
    api,
  );
  await validateCandidateIdentity(api, input, options);
  if (JSON.stringify(authenticatedTests) !== JSON.stringify(receipt.tests)) {
    fail("qualification receipt source evidence does not match live authenticated sources");
  }
  return receipt;
}

export async function produceQualificationReceipt(
  contractValue: QualificationContract | unknown,
  input: ProduceQualificationReceiptInput,
  api: QualificationGitHubReader,
): Promise<QualificationReceipt> {
  const baseContract = validateQualificationContract(contractValue);
  const contract = qualificationReceiptContract(
    baseContract,
    input.candidateContract,
    input.phase,
    input.executionContext,
  );
  validateRepository(input.repository);
  validateSha(input.candidateSha, "producer candidate SHA");
  validateSha(input.baseSha, "producer base SHA");
  await validateCandidateIdentity(api, input);
  const tests = await collectAuthenticatedQualificationSourceTests(contract, input, api);
  await validateCandidateIdentity(api, input);
  return createQualificationReceipt(contract, { ...input, tests });
}
