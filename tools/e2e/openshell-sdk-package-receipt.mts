// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listValidatedArtifactZipEntries,
  readValidatedArtifactZipEntryBytes,
} from "../../scripts/scorecard/read-artifact-zip.mts";
import { collectPaginated, githubRequest } from "./base-image-publication.mts";
import {
  bindNamedExactArtifact,
  downloadBoundArtifact,
  type BoundArtifactIdentity,
} from "./exact-artifact-download.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_FILE = "openshell-sdk-package-pr.yaml";
const WORKFLOW_NAME = "Security / Package OpenShell SDK for PR";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const PRODUCER_KIND = "nemoclaw-openshell-sdk-producer-v1";
const SELECTION_KIND = "nemoclaw-openshell-sdk-selection-v1";
const RECEIPT_FILE = "receipt.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9._-]*[.]tgz$/u;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface OpenShellSdkProducerReceipt {
  readonly kind: typeof PRODUCER_KIND;
  readonly pullRequest: number;
  readonly candidate: { readonly repository: typeof REPOSITORY; readonly sha: string };
  readonly base: { readonly repository: typeof REPOSITORY; readonly sha: string };
  readonly workflow: {
    readonly repository: typeof REPOSITORY;
    readonly path: typeof WORKFLOW_PATH;
    readonly sha: string;
  };
  readonly run: { readonly id: number; readonly attempt: number };
  readonly package: { readonly fileName: string; readonly digest: string; readonly size: number };
}

export interface OpenShellSdkSelectionReceipt extends Omit<OpenShellSdkProducerReceipt, "kind"> {
  readonly kind: typeof SELECTION_KIND;
  readonly artifact: {
    readonly id: number;
    readonly name: string;
    readonly digest: string;
    readonly size: number;
  };
}

interface ResolveInput {
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly outputDirectory: string;
  readonly pullRequest: number;
  readonly selectionPath: string;
  readonly token: string;
}

interface ResolveOptions {
  readonly downloadArtifact?: (identity: BoundArtifactIdentity) => Promise<Buffer>;
  readonly pollMilliseconds?: number;
  readonly request?: (apiPath: string) => Promise<unknown>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly waitMilliseconds?: number;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} must contain the complete expected set`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be an immutable SHA-256 digest`);
  }
  return value;
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

function packageName(value: unknown): string {
  if (typeof value !== "string" || !PACKAGE_PATTERN.test(value)) {
    throw new Error("OpenShell SDK package file name is invalid");
  }
  return value;
}

function packageDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function producerArtifactName(candidateSha: string, runId: number, runAttempt: number): string {
  return `openshell-sdk-${candidateSha}-${runId}-${runAttempt}`;
}

export function createOpenShellSdkProducerReceipt(input: {
  readonly archivePath: string;
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly checkedOutSha: string;
  readonly pullRequest: number;
  readonly runAttempt: number;
  readonly runId: number;
  readonly workflowSha: string;
}): OpenShellSdkProducerReceipt {
  const candidateSha = sha(input.candidateSha, "candidate SHA");
  const baseSha = sha(input.baseSha, "base SHA");
  const workflowSha = sha(input.workflowSha, "workflow SHA");
  exactString(sha(input.checkedOutSha, "checked-out SHA"), baseSha, "checked-out SHA");
  exactString(workflowSha, baseSha, "workflow SHA");
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  const runId = positiveInteger(input.runId, "run id");
  const runAttempt = positiveInteger(input.runAttempt, "run attempt");
  const archivePath = path.resolve(input.archivePath);
  let descriptor: number;
  try {
    descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error("OpenShell SDK package must be a readable regular non-symlink file");
  }
  let bytes: Buffer;
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error("OpenShell SDK package must be a readable regular non-symlink file");
    }
    if (metadata.size < 1 || metadata.size > MAX_PACKAGE_BYTES) {
      throw new Error("OpenShell SDK package size is invalid");
    }
    bytes = fs.readFileSync(descriptor);
    if (bytes.length !== metadata.size) {
      throw new Error("OpenShell SDK package changed while its receipt was recorded");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    kind: PRODUCER_KIND,
    pullRequest,
    candidate: { repository: REPOSITORY, sha: candidateSha },
    base: { repository: REPOSITORY, sha: baseSha },
    workflow: { repository: REPOSITORY, path: WORKFLOW_PATH, sha: workflowSha },
    run: { id: runId, attempt: runAttempt },
    package: {
      fileName: packageName(path.basename(archivePath)),
      digest: packageDigest(bytes),
      size: bytes.length,
    },
  };
}

export function parseOpenShellSdkProducerReceipt(
  value: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly pullRequest: number;
    readonly runAttempt: number;
    readonly runId: number;
  },
): OpenShellSdkProducerReceipt {
  const receipt = record(value, "OpenShell SDK producer receipt");
  exactKeys(
    receipt,
    ["base", "candidate", "kind", "package", "pullRequest", "run", "workflow"],
    "OpenShell SDK producer receipt",
  );
  exactString(receipt.kind, PRODUCER_KIND, "OpenShell SDK producer receipt kind");
  if (receipt.pullRequest !== positiveInteger(expected.pullRequest, "expected pull request")) {
    throw new Error("OpenShell SDK producer receipt does not match the pull request");
  }
  const candidate = record(receipt.candidate, "OpenShell SDK candidate");
  exactKeys(candidate, ["repository", "sha"], "OpenShell SDK candidate");
  exactString(candidate.repository, REPOSITORY, "OpenShell SDK candidate repository");
  exactString(
    candidate.sha,
    sha(expected.candidateSha, "expected candidate SHA"),
    "OpenShell SDK candidate SHA",
  );
  const base = record(receipt.base, "OpenShell SDK base");
  exactKeys(base, ["repository", "sha"], "OpenShell SDK base");
  exactString(base.repository, REPOSITORY, "OpenShell SDK base repository");
  exactString(base.sha, sha(expected.baseSha, "expected base SHA"), "OpenShell SDK base SHA");
  const workflow = record(receipt.workflow, "OpenShell SDK workflow");
  exactKeys(workflow, ["path", "repository", "sha"], "OpenShell SDK workflow");
  exactString(workflow.repository, REPOSITORY, "OpenShell SDK workflow repository");
  exactString(workflow.path, WORKFLOW_PATH, "OpenShell SDK workflow path");
  exactString(workflow.sha, expected.baseSha, "OpenShell SDK workflow SHA");
  const run = record(receipt.run, "OpenShell SDK run");
  exactKeys(run, ["attempt", "id"], "OpenShell SDK run");
  if (
    run.id !== positiveInteger(expected.runId, "expected run id") ||
    run.attempt !== positiveInteger(expected.runAttempt, "expected run attempt")
  ) {
    throw new Error("OpenShell SDK producer receipt does not match the workflow attempt");
  }
  const packageValue = record(receipt.package, "OpenShell SDK package");
  exactKeys(packageValue, ["digest", "fileName", "size"], "OpenShell SDK package");
  const parsed: OpenShellSdkProducerReceipt = {
    kind: PRODUCER_KIND,
    pullRequest: expected.pullRequest,
    candidate: { repository: REPOSITORY, sha: expected.candidateSha },
    base: { repository: REPOSITORY, sha: expected.baseSha },
    workflow: { repository: REPOSITORY, path: WORKFLOW_PATH, sha: expected.baseSha },
    run: { id: expected.runId, attempt: expected.runAttempt },
    package: {
      fileName: packageName(packageValue.fileName),
      digest: digest(packageValue.digest, "OpenShell SDK package digest"),
      size: positiveInteger(packageValue.size, "OpenShell SDK package size"),
    },
  };
  if (parsed.package.size > MAX_PACKAGE_BYTES) {
    throw new Error("OpenShell SDK package size exceeds the limit");
  }
  return parsed;
}

function validateWorkflow(value: unknown): number {
  const workflow = record(value, "OpenShell SDK workflow");
  exactString(workflow.name, WORKFLOW_NAME, "OpenShell SDK workflow name");
  exactString(workflow.path, WORKFLOW_PATH, "OpenShell SDK workflow path");
  exactString(workflow.state, "active", "OpenShell SDK workflow state");
  return positiveInteger(workflow.id, "OpenShell SDK workflow id");
}

function validateCurrentPullRequest(
  value: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly pullRequest: number;
  },
): void {
  const pull = record(value, "OpenShell SDK pull request");
  exactString(pull.state, "open", "OpenShell SDK pull request state");
  if (pull.number !== expected.pullRequest) {
    throw new Error("OpenShell SDK pull request number does not match");
  }
  exactString(
    record(pull.head, "OpenShell SDK pull request source").sha,
    expected.candidateSha,
    "OpenShell SDK pull request source SHA",
  );
  exactString(
    record(pull.base, "OpenShell SDK pull request base").sha,
    expected.baseSha,
    "OpenShell SDK pull request base SHA",
  );
}

function selectSuccessfulRun(
  value: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly pullRequest: number;
    readonly workflowId: number;
  },
): { readonly id: number; readonly attempt: number } | null {
  const page = record(value, "OpenShell SDK workflow runs");
  if (!Array.isArray(page.workflow_runs) || page.total_count !== page.workflow_runs.length) {
    throw new Error("OpenShell SDK workflow run listing is incomplete");
  }
  const successful: Array<{ id: number; attempt: number }> = [];
  const ids = new Set<number>();
  for (const raw of page.workflow_runs) {
    const run = record(raw, "OpenShell SDK workflow run");
    const id = positiveInteger(run.id, "OpenShell SDK workflow run id");
    if (ids.has(id)) throw new Error("OpenShell SDK workflow run listing contains duplicates");
    ids.add(id);
    if (run.workflow_id !== expected.workflowId) {
      throw new Error("OpenShell SDK workflow run does not match the trusted workflow");
    }
    exactString(run.path, WORKFLOW_PATH, "OpenShell SDK workflow run path");
    exactString(run.event, "pull_request_target", "OpenShell SDK workflow run event");
    exactString(run.head_sha, expected.candidateSha, "OpenShell SDK workflow run candidate");
    exactString(
      record(run.repository, "OpenShell SDK workflow repository").full_name,
      REPOSITORY,
      "OpenShell SDK workflow repository",
    );
    exactString(
      record(run.head_repository, "OpenShell SDK workflow source repository").full_name,
      REPOSITORY,
      "OpenShell SDK workflow source repository",
    );
    const expectedTitle = `OpenShell SDK PR #${expected.pullRequest} head ${expected.candidateSha} base ${expected.baseSha}`;
    if (run.display_title !== expectedTitle) continue;
    if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) {
      throw new Error("OpenShell SDK workflow run must identify one pull request");
    }
    const pull = record(run.pull_requests[0], "OpenShell SDK workflow pull request");
    if (pull.number !== expected.pullRequest) {
      throw new Error("OpenShell SDK workflow run does not match the pull request");
    }
    const pullHead = record(pull.head, "OpenShell SDK workflow pull request source");
    exactString(pullHead.sha, expected.candidateSha, "OpenShell SDK workflow pull request source");
    const attempt = positiveInteger(run.run_attempt, "OpenShell SDK workflow run attempt");
    if (run.status === "completed" && run.conclusion === "success") {
      successful.push({ id, attempt });
    }
  }
  if (successful.length > 1) {
    throw new Error("OpenShell SDK producer is ambiguous");
  }
  return successful[0] ?? null;
}

function materializeProducerArchive(
  archive: Buffer,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly pullRequest: number;
    readonly runAttempt: number;
    readonly runId: number;
  },
  outputDirectory: string,
): OpenShellSdkProducerReceipt {
  const entries = listValidatedArtifactZipEntries(archive, { maxEntries: 3 });
  if (!entries || entries.length !== 2 || !entries.includes(RECEIPT_FILE)) {
    throw new Error("OpenShell SDK artifact must contain one package and one producer receipt");
  }
  const receiptBytes = readValidatedArtifactZipEntryBytes(archive, RECEIPT_FILE, {
    maxBytes: 32 * 1024,
    maxEntries: 3,
  });
  if (!receiptBytes) throw new Error("OpenShell SDK producer receipt is missing");
  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(receiptBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("OpenShell SDK producer receipt is invalid JSON");
  }
  const receipt = parseOpenShellSdkProducerReceipt(receiptValue, expected);
  const packageEntry = entries.find((entry) => entry !== RECEIPT_FILE);
  if (packageEntry !== receipt.package.fileName) {
    throw new Error("OpenShell SDK package does not match the producer receipt");
  }
  const packageBytes = readValidatedArtifactZipEntryBytes(archive, receipt.package.fileName, {
    maxBytes: MAX_PACKAGE_BYTES,
    maxEntries: 3,
  });
  if (
    !packageBytes ||
    packageBytes.length !== receipt.package.size ||
    packageDigest(packageBytes) !== receipt.package.digest
  ) {
    throw new Error("OpenShell SDK package bytes do not match the producer receipt");
  }
  const destination = path.resolve(outputDirectory);
  fs.mkdirSync(destination, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(destination, receipt.package.fileName), packageBytes, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

export async function resolveOpenShellSdkPackage(
  input: ResolveInput,
  options: ResolveOptions = {},
): Promise<OpenShellSdkSelectionReceipt> {
  const baseSha = sha(input.baseSha, "base SHA");
  const candidateSha = sha(input.candidateSha, "candidate SHA");
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  const waitMilliseconds = options.waitMilliseconds ?? 420_000;
  const pollMilliseconds = options.pollMilliseconds ?? 5_000;
  if (
    !Number.isSafeInteger(waitMilliseconds) ||
    waitMilliseconds < 0 ||
    waitMilliseconds > 420_000
  ) {
    throw new Error("OpenShell SDK wait duration is invalid");
  }
  if (
    !Number.isSafeInteger(pollMilliseconds) ||
    pollMilliseconds < 1 ||
    pollMilliseconds > 30_000
  ) {
    throw new Error("OpenShell SDK poll duration is invalid");
  }
  const request = options.request ?? ((apiPath: string) => githubRequest(apiPath, input.token));
  const download =
    options.downloadArtifact ??
    ((identity: BoundArtifactIdentity) =>
      downloadBoundArtifact(identity, input.token, { log: console.error }));
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  validateCurrentPullRequest(await request(`/repos/${REPOSITORY}/pulls/${pullRequest}`), {
    baseSha,
    candidateSha,
    pullRequest,
  });
  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`),
  );
  const runsPath = `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?event=pull_request_target&head_sha=${candidateSha}&per_page=100`;
  const deadline = Date.now() + waitMilliseconds;
  let selected: { readonly id: number; readonly attempt: number } | null = null;
  do {
    selected = selectSuccessfulRun(await collectPaginated(request, runsPath, "workflow_runs"), {
      baseSha,
      candidateSha,
      pullRequest,
      workflowId,
    });
    if (selected) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMilliseconds, Math.max(0, deadline - Date.now())));
  } while (true);
  if (!selected) throw new Error("OpenShell SDK producer is missing");

  const artifactName = producerArtifactName(candidateSha, selected.id, selected.attempt);
  const metadata = await request(
    `/repos/${REPOSITORY}/actions/runs/${selected.id}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
  );
  const identity = bindNamedExactArtifact(
    metadata,
    { headSha: candidateSha, runAttempt: selected.attempt, runId: selected.id },
    artifactName,
    { maxArchiveBytes: MAX_PACKAGE_BYTES + 512 * 1024 },
  );
  const producer = materializeProducerArchive(
    await download(identity),
    { baseSha, candidateSha, pullRequest, runAttempt: selected.attempt, runId: selected.id },
    input.outputDirectory,
  );
  const selection: OpenShellSdkSelectionReceipt = {
    ...producer,
    kind: SELECTION_KIND,
    artifact: {
      id: identity.id,
      name: identity.name,
      digest: identity.digest,
      size: identity.size,
    },
  };
  const selectionPath = path.resolve(input.selectionPath);
  fs.mkdirSync(path.dirname(selectionPath), { mode: 0o700, recursive: true });
  fs.writeFileSync(selectionPath, `${JSON.stringify(selection)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return selection;
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv[0] === "create") {
    if (argv.length !== 3) throw new Error("expected package path and receipt output path");
    const receipt = createOpenShellSdkProducerReceipt({
      archivePath: argv[1],
      baseSha: env.BASE_SHA ?? "",
      candidateSha: env.CANDIDATE_SHA ?? "",
      checkedOutSha: env.CHECKED_OUT_SHA ?? "",
      pullRequest: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
      runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
      runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
    });
    const receiptPath = path.resolve(argv[2]);
    fs.mkdirSync(path.dirname(receiptPath), { mode: 0o700, recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  if (argv[0] === "resolve") {
    if (argv.length !== 3) throw new Error("expected package directory and selection path");
    const selection = await resolveOpenShellSdkPackage({
      baseSha: env.BASE_SHA ?? "",
      candidateSha: env.CANDIDATE_SHA ?? "",
      outputDirectory: argv[1],
      pullRequest: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
      selectionPath: argv[2],
      token: env.GITHUB_TOKEN ?? "",
    });
    process.stdout.write(`${selection.package.fileName}\n`);
    return;
  }
  throw new Error("expected create or resolve");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown OpenShell SDK receipt error");
    process.exitCode = 1;
  }
}
