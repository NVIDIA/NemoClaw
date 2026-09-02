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
const WORKFLOW_FILE = "managed-runtime-base-qualification.yaml";
const WORKFLOW_NAME = "E2E / Exact Base Managed Runtime";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const CANDIDATE_JOB = "Candidate all-agent managed runtime activation";
const BASE_JOB = "Exact base all-agent managed runtime activation";
const SCENARIO_ID = "managed-runtime-activation-v1";
const TEST_PATH = "test/e2e/live/managed-image-activation-e2e.test.ts";
const RECEIPT_KIND = "nemoclaw-managed-runtime-activation-v1";
const COMPARISON_KIND = "nemoclaw-managed-runtime-comparison-v1";
const RECEIPT_FILE = "receipt.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[^\0\r\n]{1,200}$/u;
const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const MAX_EVIDENCE_FILES = 1_000;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type Role = "base" | "candidate";
type StepOutcome = "cancelled" | "failure" | "skipped" | "success";
type ComparisonClassification =
  | "base-failure"
  | "candidate-failure"
  | "infrastructure-failure"
  | "pass";

interface ArtifactIdentity {
  readonly id: number;
  readonly name: string;
  readonly digest: string;
  readonly size: number;
}

type EvidenceFailureClass =
  | "artifact-metadata"
  | "artifact-missing"
  | "evidence-download"
  | "evidence-verification"
  | "job-selection"
  | "receipt-download"
  | "receipt-parse";

export interface ManagedRuntimeEvidenceFailure {
  readonly class: EvidenceFailureClass;
  readonly message: string;
}

export interface ManagedRuntimeReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly role: Role;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly sourceSha: string;
  readonly scenario: {
    readonly id: typeof SCENARIO_ID;
    readonly testPath: typeof TEST_PATH;
    readonly platform: "linux/amd64";
    readonly agents: typeof AGENTS;
  };
  readonly workflow: {
    readonly repository: typeof REPOSITORY;
    readonly path: string;
    readonly sha: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly job: string;
  };
  readonly runtime: {
    readonly openshellVersion: string;
    readonly catalogDigest: string;
    readonly images: ReadonlyArray<{
      readonly agent: (typeof AGENTS)[number];
      readonly reference: string;
      readonly sourceRevision: string;
      readonly cohort: string;
    }>;
  };
  readonly evidence: {
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly digest: string;
      readonly size: number;
    }>;
    readonly cleanup: {
      readonly path: string | null;
      readonly proven: boolean;
      readonly failures: number;
    };
  };
  readonly outcome: StepOutcome;
}

export interface ManagedRuntimeRunEvidence {
  readonly run: { readonly id: number; readonly attempt: number };
  readonly job: { readonly id: number; readonly conclusion: StepOutcome };
  readonly receipt: ManagedRuntimeReceipt | null;
  readonly artifacts: {
    readonly receipt: ArtifactIdentity | null;
    readonly evidence: ArtifactIdentity | null;
  };
  readonly failure: ManagedRuntimeEvidenceFailure | null;
}

export interface ManagedRuntimeComparison {
  readonly kind: typeof COMPARISON_KIND;
  readonly classification: ComparisonClassification;
  readonly reason: string;
  readonly candidate: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly jobConclusion: StepOutcome;
    readonly receiptArtifact: ArtifactIdentity | null;
    readonly evidenceArtifact: ArtifactIdentity | null;
    readonly evidenceFailure: ManagedRuntimeEvidenceFailure | null;
  };
  readonly base: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly jobConclusion: StepOutcome;
    readonly receiptArtifact: ArtifactIdentity | null;
    readonly evidenceArtifact: ArtifactIdentity | null;
    readonly evidenceFailure: ManagedRuntimeEvidenceFailure | null;
  };
  readonly scenario: {
    readonly id: typeof SCENARIO_ID;
    readonly candidateSha: string;
    readonly baseSha: string;
  };
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

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
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

function stepOutcome(value: unknown, label: string): StepOutcome {
  if (value !== "cancelled" && value !== "failure" && value !== "skipped" && value !== "success") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function artifactIdentity(value: BoundArtifactIdentity): ArtifactIdentity {
  return { id: value.id, name: value.name, digest: value.digest, size: value.size };
}

function hash(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readCatalog(catalogPath: string, role: Role, candidateSha: string, imageRevision: string) {
  const bytes = fs.readFileSync(catalogPath);
  let document: JsonRecord;
  try {
    document = record(JSON.parse(bytes.toString("utf8")) as unknown, "managed runtime catalog");
  } catch {
    throw new Error("managed runtime catalog is invalid JSON");
  }
  exactKeys(document, AGENTS, "managed runtime catalog");
  const images = AGENTS.map((agent) => {
    const contract = record(document[agent], `${agent} managed runtime contract`);
    const source = record(contract.source, `${agent} managed runtime source`);
    exactString(contract.agent, agent, `${agent} managed runtime agent`);
    if (contract.contractVersion !== 1) {
      throw new Error(`${agent} managed runtime contract version must be 1`);
    }
    exactString(contract.platform, "linux/amd64", `${agent} managed runtime platform`);
    const reference = contract.reference;
    if (typeof reference !== "string" || !/@sha256:[0-9a-f]{64}$/u.test(reference)) {
      throw new Error(`${agent} managed runtime reference must use an immutable digest`);
    }
    exactString(source.repository, REPOSITORY, `${agent} managed runtime source repository`);
    exactString(source.revision, imageRevision, `${agent} managed runtime image revision`);
    if (role === "candidate") {
      exactString(source.revision, candidateSha, `${agent} candidate image revision`);
    }
    if (
      typeof source.cohort !== "string" ||
      !/^ghrun-[1-9][0-9]*-[1-9][0-9]*$/u.test(source.cohort)
    ) {
      throw new Error(`${agent} managed runtime cohort is invalid`);
    }
    return { agent, reference, sourceRevision: imageRevision, cohort: source.cohort };
  });
  if (new Set(images.map(({ cohort }) => cohort)).size !== 1) {
    throw new Error("managed runtime catalog does not identify one cohort");
  }
  return { digest: hash(bytes), images };
}

function evidenceFiles(root: string) {
  const resolvedRoot = path.resolve(root);
  const files: Array<{ path: string; digest: string; size: number }> = [];
  const pending = [resolvedRoot];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("managed runtime evidence must not contain links");
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("managed runtime evidence must contain regular files");
      const relative = path.relative(resolvedRoot, absolute).split(path.sep).join("/");
      const bytes = fs.readFileSync(absolute);
      totalBytes += bytes.length;
      files.push({ path: relative, digest: hash(bytes), size: bytes.length });
      if (files.length > MAX_EVIDENCE_FILES || totalBytes > MAX_EVIDENCE_BYTES) {
        throw new Error("managed runtime evidence exceeds the receipt limit");
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function cleanupEvidence(root: string, files: ReadonlyArray<{ path: string }>) {
  const matches = files.filter(({ path: value }) => value.endsWith("/cleanup.json"));
  if (matches.length !== 1) return { path: null, proven: false, failures: matches.length };
  const cleanupPath = matches[0]!.path;
  try {
    const cleanup = record(
      JSON.parse(fs.readFileSync(path.join(root, cleanupPath), "utf8")),
      "cleanup receipt",
    );
    const failures = Array.isArray(cleanup.failures) ? cleanup.failures.length : -1;
    return { path: cleanupPath, proven: failures === 0, failures };
  } catch {
    return { path: cleanupPath, proven: false, failures: -1 };
  }
}

export function createManagedRuntimeReceipt(input: {
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly catalogPath: string;
  readonly evidenceDirectory: string;
  readonly imageRevision: string;
  readonly job: string;
  readonly openshellVersion: string;
  readonly outcome: StepOutcome;
  readonly role: Role;
  readonly runAttempt: number;
  readonly runId: number;
  readonly sourceSha: string;
  readonly workflowPath: string;
  readonly workflowSha: string;
}): ManagedRuntimeReceipt {
  const candidateSha = sha(input.candidateSha, "candidate SHA");
  const baseSha = sha(input.baseSha, "base SHA");
  const sourceSha = sha(input.sourceSha, "source SHA");
  const imageRevision = sha(input.imageRevision, "managed image revision");
  exactString(
    sourceSha,
    input.role === "candidate" ? candidateSha : baseSha,
    "managed runtime source SHA",
  );
  const expectedPath = WORKFLOW_PATH;
  const expectedJob = input.role === "candidate" ? CANDIDATE_JOB : BASE_JOB;
  exactString(input.workflowPath, expectedPath, "managed runtime workflow path");
  exactString(input.job, expectedJob, "managed runtime job");
  const workflowSha = sha(input.workflowSha, "workflow SHA");
  if (!VERSION_PATTERN.test(input.openshellVersion)) {
    throw new Error("OpenShell runtime version is invalid");
  }
  const catalog = readCatalog(input.catalogPath, input.role, candidateSha, imageRevision);
  const files = evidenceFiles(input.evidenceDirectory);
  return {
    kind: RECEIPT_KIND,
    role: input.role,
    candidateSha,
    baseSha,
    sourceSha,
    scenario: { id: SCENARIO_ID, testPath: TEST_PATH, platform: "linux/amd64", agents: AGENTS },
    workflow: {
      repository: REPOSITORY,
      path: expectedPath,
      sha: workflowSha,
      runId: positiveInteger(input.runId, "run id"),
      runAttempt: positiveInteger(input.runAttempt, "run attempt"),
      job: expectedJob,
    },
    runtime: {
      openshellVersion: input.openshellVersion,
      catalogDigest: catalog.digest,
      images: catalog.images,
    },
    evidence: { files, cleanup: cleanupEvidence(path.resolve(input.evidenceDirectory), files) },
    outcome: stepOutcome(input.outcome, "managed runtime outcome"),
  };
}

export function parseManagedRuntimeReceipt(
  value: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly role: Role;
    readonly runAttempt: number;
    readonly runId: number;
    readonly workflowSha: string;
  },
): ManagedRuntimeReceipt {
  const receipt = record(value, "managed runtime receipt");
  exactKeys(
    receipt,
    [
      "baseSha",
      "candidateSha",
      "evidence",
      "kind",
      "outcome",
      "role",
      "runtime",
      "scenario",
      "sourceSha",
      "workflow",
    ],
    "managed runtime receipt",
  );
  exactString(receipt.kind, RECEIPT_KIND, "managed runtime receipt kind");
  exactString(receipt.role, expected.role, "managed runtime receipt role");
  exactString(receipt.candidateSha, expected.candidateSha, "managed runtime candidate SHA");
  exactString(receipt.baseSha, expected.baseSha, "managed runtime base SHA");
  exactString(
    receipt.sourceSha,
    expected.role === "candidate" ? expected.candidateSha : expected.baseSha,
    "managed runtime source SHA",
  );
  const scenario = record(receipt.scenario, "managed runtime scenario");
  exactKeys(scenario, ["agents", "id", "platform", "testPath"], "managed runtime scenario");
  exactString(scenario.id, SCENARIO_ID, "managed runtime scenario id");
  exactString(scenario.testPath, TEST_PATH, "managed runtime scenario test");
  exactString(scenario.platform, "linux/amd64", "managed runtime scenario platform");
  if (JSON.stringify(scenario.agents) !== JSON.stringify(AGENTS)) {
    throw new Error("managed runtime scenario agents do not match");
  }
  const workflow = record(receipt.workflow, "managed runtime workflow");
  exactKeys(
    workflow,
    ["job", "path", "repository", "runAttempt", "runId", "sha"],
    "managed runtime workflow",
  );
  exactString(workflow.repository, REPOSITORY, "managed runtime workflow repository");
  exactString(workflow.path, WORKFLOW_PATH, "managed runtime workflow path");
  exactString(
    workflow.job,
    expected.role === "candidate" ? CANDIDATE_JOB : BASE_JOB,
    "managed runtime workflow job",
  );
  exactString(
    workflow.sha,
    sha(expected.workflowSha, "expected managed runtime workflow SHA"),
    "managed runtime workflow SHA",
  );
  if (workflow.runId !== expected.runId || workflow.runAttempt !== expected.runAttempt) {
    throw new Error("managed runtime receipt does not match the workflow attempt");
  }
  const runtime = record(receipt.runtime, "managed runtime identity");
  exactKeys(runtime, ["catalogDigest", "images", "openshellVersion"], "managed runtime identity");
  digest(runtime.catalogDigest, "managed runtime catalog digest");
  if (
    typeof runtime.openshellVersion !== "string" ||
    !VERSION_PATTERN.test(runtime.openshellVersion)
  ) {
    throw new Error("managed runtime OpenShell version is invalid");
  }
  if (!Array.isArray(runtime.images) || runtime.images.length !== AGENTS.length) {
    throw new Error("managed runtime image identities are incomplete");
  }
  const images = runtime.images.map((value) => {
    const image = record(value, "managed runtime image identity");
    exactKeys(
      image,
      ["agent", "cohort", "reference", "sourceRevision"],
      "managed runtime image identity",
    );
    if (!AGENTS.includes(image.agent as (typeof AGENTS)[number])) {
      throw new Error("managed runtime image agent is invalid");
    }
    if (typeof image.reference !== "string" || !/@sha256:[0-9a-f]{64}$/u.test(image.reference)) {
      throw new Error("managed runtime image reference is mutable");
    }
    sha(image.sourceRevision, "managed runtime image source revision");
    if (expected.role === "candidate" && image.sourceRevision !== expected.candidateSha) {
      throw new Error("candidate managed runtime image revision is stale");
    }
    if (
      typeof image.cohort !== "string" ||
      !/^ghrun-[1-9][0-9]*-[1-9][0-9]*$/u.test(image.cohort)
    ) {
      throw new Error("managed runtime image cohort is invalid");
    }
    return {
      agent: image.agent,
      cohort: image.cohort,
      sourceRevision: image.sourceRevision,
    };
  });
  if (
    JSON.stringify(images.map(({ agent }) => agent).sort()) !== JSON.stringify([...AGENTS].sort())
  ) {
    throw new Error("managed runtime image agents do not match");
  }
  if (new Set(images.map(({ sourceRevision }) => sourceRevision)).size !== 1) {
    throw new Error("managed runtime image revisions do not match");
  }
  if (new Set(images.map(({ cohort }) => cohort)).size !== 1) {
    throw new Error("managed runtime image cohorts do not match");
  }
  const evidence = record(receipt.evidence, "managed runtime evidence");
  exactKeys(evidence, ["cleanup", "files"], "managed runtime evidence");
  if (!Array.isArray(evidence.files) || evidence.files.length > MAX_EVIDENCE_FILES) {
    throw new Error("managed runtime evidence file list is invalid");
  }
  const evidencePaths = new Set<string>();
  let evidenceBytes = 0;
  for (const rawFile of evidence.files) {
    const file = record(rawFile, "managed runtime evidence file");
    exactKeys(file, ["digest", "path", "size"], "managed runtime evidence file");
    digest(file.digest, "managed runtime evidence file digest");
    const size = nonnegativeInteger(file.size, "managed runtime evidence file size");
    if (
      typeof file.path !== "string" ||
      !/^[A-Za-z0-9._/-]+$/u.test(file.path) ||
      file.path.includes("..")
    ) {
      throw new Error("managed runtime evidence file path is invalid");
    }
    if (evidencePaths.has(file.path)) {
      throw new Error("managed runtime evidence file paths must be unique");
    }
    evidencePaths.add(file.path);
    evidenceBytes += size;
    if (evidenceBytes > MAX_EVIDENCE_BYTES) {
      throw new Error("managed runtime evidence exceeds the receipt limit");
    }
  }
  const cleanup = record(evidence.cleanup, "managed runtime cleanup evidence");
  exactKeys(cleanup, ["failures", "path", "proven"], "managed runtime cleanup evidence");
  if (
    cleanup.path !== null &&
    (typeof cleanup.path !== "string" || !cleanup.path.endsWith("/cleanup.json"))
  ) {
    throw new Error("managed runtime cleanup receipt path is invalid");
  }
  if (typeof cleanup.proven !== "boolean" || !Number.isSafeInteger(cleanup.failures)) {
    throw new Error("managed runtime cleanup evidence is invalid");
  }
  if (cleanup.path !== null && !evidencePaths.has(cleanup.path)) {
    throw new Error("managed runtime cleanup receipt is absent from the evidence list");
  }
  if (cleanup.proven !== (cleanup.path !== null && cleanup.failures === 0)) {
    throw new Error("managed runtime cleanup verdict does not match its evidence");
  }
  stepOutcome(receipt.outcome, "managed runtime receipt outcome");
  return receipt as unknown as ManagedRuntimeReceipt;
}

function validateWorkflow(value: unknown): number {
  const workflow = record(value, "managed runtime qualification workflow");
  exactString(workflow.name, WORKFLOW_NAME, "managed runtime qualification workflow name");
  exactString(workflow.path, WORKFLOW_PATH, "managed runtime qualification workflow path");
  exactString(workflow.state, "active", "managed runtime qualification workflow state");
  return positiveInteger(workflow.id, "managed runtime qualification workflow id");
}

function bindOptionalArtifact(
  value: unknown,
  expected: {
    readonly headSha: string;
    readonly name: string;
    readonly maxArchiveBytes?: number;
    readonly runAttempt: number;
    readonly runId: number;
  },
): BoundArtifactIdentity | null {
  const page = record(value, "managed runtime artifact response");
  if (page.total_count === 0 && Array.isArray(page.artifacts) && page.artifacts.length === 0)
    return null;
  return bindNamedExactArtifact(
    value,
    { headSha: expected.headSha, runAttempt: expected.runAttempt, runId: expected.runId },
    expected.name,
    expected.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: expected.maxArchiveBytes },
  );
}

function receiptFromArchive(
  archive: Buffer,
  expected: Parameters<typeof parseManagedRuntimeReceipt>[1],
): ManagedRuntimeReceipt {
  const entries = listValidatedArtifactZipEntries(archive, { maxEntries: 2 });
  if (JSON.stringify(entries) !== JSON.stringify([RECEIPT_FILE])) {
    throw new Error("managed runtime receipt artifact must contain one receipt.json file");
  }
  const bytes = readValidatedArtifactZipEntryBytes(archive, RECEIPT_FILE, {
    maxBytes: 512 * 1024,
    maxEntries: 2,
  });
  if (!bytes) throw new Error("managed runtime receipt artifact is malformed");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("managed runtime receipt artifact contains invalid JSON");
  }
  return parseManagedRuntimeReceipt(value, expected);
}

function verifyEvidenceArchive(archive: Buffer, receipt: ManagedRuntimeReceipt): void {
  const expectedFiles = receipt.evidence.files.map(({ path: value }) => value).sort();
  const entries = listValidatedArtifactZipEntries(archive, {
    maxEntries: MAX_EVIDENCE_FILES,
  });
  if (!entries || JSON.stringify(entries) !== JSON.stringify(expectedFiles)) {
    throw new Error("managed runtime evidence artifact does not match the receipt file list");
  }
  for (const file of receipt.evidence.files) {
    const bytes = readValidatedArtifactZipEntryBytes(archive, file.path, {
      maxBytes: Math.max(1, file.size),
      maxEntries: MAX_EVIDENCE_FILES,
    });
    if (!bytes || bytes.length !== file.size || hash(bytes) !== file.digest) {
      throw new Error(`managed runtime evidence file ${file.path} does not match its receipt`);
    }
  }
}

function matchingOutcome(job: StepOutcome, receipt: ManagedRuntimeReceipt): boolean {
  return job === receipt.outcome || (job === "failure" && receipt.outcome === "failure");
}

export function classifyManagedRuntimeComparison(input: {
  readonly base: ManagedRuntimeRunEvidence;
  readonly baseSha: string;
  readonly candidate: ManagedRuntimeRunEvidence;
  readonly candidateSha: string;
}): ManagedRuntimeComparison {
  const candidate = input.candidate;
  const base = input.base;
  const common = {
    kind: COMPARISON_KIND,
    candidate: {
      runId: candidate.run.id,
      runAttempt: candidate.run.attempt,
      jobConclusion: candidate.job.conclusion,
      receiptArtifact: candidate.artifacts.receipt,
      evidenceArtifact: candidate.artifacts.evidence,
      evidenceFailure: candidate.failure,
    },
    base: {
      runId: base.run.id,
      runAttempt: base.run.attempt,
      jobConclusion: base.job.conclusion,
      receiptArtifact: base.artifacts.receipt,
      evidenceArtifact: base.artifacts.evidence,
      evidenceFailure: base.failure,
    },
    scenario: {
      id: SCENARIO_ID,
      candidateSha: sha(input.candidateSha, "comparison candidate SHA"),
      baseSha: sha(input.baseSha, "comparison base SHA"),
    },
  } as const;
  const infrastructure = (reason: string): ManagedRuntimeComparison => ({
    ...common,
    classification: "infrastructure-failure",
    reason,
  });
  if (candidate.job.conclusion === "cancelled" || candidate.job.conclusion === "skipped") {
    return infrastructure("coordination cancellation did not produce a product verdict");
  }
  if (candidate.failure) {
    return infrastructure(
      `candidate evidence failure [${candidate.failure.class}]: ${candidate.failure.message}`,
    );
  }
  if (!candidate.receipt || !candidate.artifacts.receipt || !candidate.artifacts.evidence) {
    return infrastructure("candidate evidence is missing or incomplete");
  }
  if (base.job.conclusion === "cancelled" || base.job.conclusion === "skipped") {
    return infrastructure("coordination cancellation did not produce a product verdict");
  }
  if (base.failure) {
    return infrastructure(`base evidence failure [${base.failure.class}]: ${base.failure.message}`);
  }
  if (!base.receipt || !base.artifacts.receipt || !base.artifacts.evidence) {
    return infrastructure("base evidence is missing or incomplete");
  }
  if (
    !matchingOutcome(candidate.job.conclusion, candidate.receipt) ||
    !matchingOutcome(base.job.conclusion, base.receipt)
  ) {
    return infrastructure("workflow conclusions do not match the authenticated scenario receipts");
  }
  if (
    JSON.stringify(candidate.receipt.scenario) !== JSON.stringify(base.receipt.scenario) ||
    candidate.receipt.candidateSha !== base.receipt.candidateSha ||
    candidate.receipt.baseSha !== base.receipt.baseSha
  ) {
    return infrastructure("candidate and base evidence use different scenario identities");
  }
  if (!candidate.receipt.evidence.cleanup.proven || !base.receipt.evidence.cleanup.proven) {
    return infrastructure("candidate or base cleanup is not proven");
  }
  if (base.job.conclusion === "failure") {
    return {
      ...common,
      classification: "base-failure",
      reason: "the identical exact-base scenario failed",
    };
  }
  if (candidate.job.conclusion === "failure") {
    return {
      ...common,
      classification: "candidate-failure",
      reason: "the candidate failed after the identical exact-base scenario passed",
    };
  }
  if (candidate.job.conclusion !== "success" || base.job.conclusion !== "success") {
    return infrastructure("scenario outcomes are not classifiable");
  }
  return { ...common, classification: "pass", reason: "candidate and exact-base scenarios passed" };
}

function sanitizeEvidenceFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/(authorization\s*:)[^\r\n]*/giu, "$1 [REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED]")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/\/(?:home|Users)\/[^/\s]+/gu, "/[HOME]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return (sanitized || "operation failed without diagnostics").slice(0, 500);
}

function evidenceFailure(
  failureClass: EvidenceFailureClass,
  error: unknown,
): ManagedRuntimeEvidenceFailure {
  return { class: failureClass, message: sanitizeEvidenceFailure(error) };
}

function artifactNames(role: Role, runId: number, runAttempt: number) {
  const prefix = role === "candidate" ? "managed-runtime-candidate" : "managed-runtime-base";
  return {
    receipt: `${prefix}-receipt-${runId}-${runAttempt}`,
    evidence: `${prefix}-evidence-${runId}-${runAttempt}`,
  };
}

function selectCurrentJob(
  jobs: readonly unknown[],
  role: Role,
  expectedConclusion: StepOutcome,
): { id: number; conclusion: StepOutcome } | ManagedRuntimeEvidenceFailure {
  const expectedName = role === "candidate" ? CANDIDATE_JOB : BASE_JOB;
  const matches = jobs
    .map((value) => record(value, "managed runtime qualification job"))
    .filter((job) => job.name === expectedName);
  if (matches.length !== 1) {
    return evidenceFailure(
      "job-selection",
      new Error(`${role} managed runtime job is missing or ambiguous`),
    );
  }
  const job = matches[0]!;
  try {
    exactString(job.status, "completed", `${role} managed runtime job status`);
    const conclusion = stepOutcome(job.conclusion, `${role} managed runtime job conclusion`);
    exactString(conclusion, expectedConclusion, `${role} managed runtime job conclusion`);
    return { id: positiveInteger(job.id, `${role} managed runtime job id`), conclusion };
  } catch (error) {
    return evidenceFailure("job-selection", error);
  }
}

async function readCurrentRunEvidence(
  role: Role,
  input: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly expectedConclusion: StepOutcome;
    readonly headSha: string;
    readonly jobs: readonly unknown[];
    readonly runAttempt: number;
    readonly runId: number;
    readonly workflowSha: string;
  },
  request: (apiPath: string) => Promise<unknown>,
  download: (identity: BoundArtifactIdentity) => Promise<Buffer>,
): Promise<ManagedRuntimeRunEvidence> {
  const selectedJob = selectCurrentJob(input.jobs, role, input.expectedConclusion);
  const run = { id: input.runId, attempt: input.runAttempt };
  if ("class" in selectedJob) {
    return {
      run,
      job: { id: 0, conclusion: input.expectedConclusion },
      receipt: null,
      artifacts: { receipt: null, evidence: null },
      failure: selectedJob,
    };
  }
  const names = artifactNames(role, input.runId, input.runAttempt);
  let receiptIdentity: BoundArtifactIdentity | null = null;
  let evidenceIdentity: BoundArtifactIdentity | null = null;
  try {
    const [receiptMetadata, evidenceMetadata] = await Promise.all([
      request(
        `/repos/${REPOSITORY}/actions/runs/${input.runId}/artifacts?name=${encodeURIComponent(names.receipt)}&per_page=100`,
      ),
      request(
        `/repos/${REPOSITORY}/actions/runs/${input.runId}/artifacts?name=${encodeURIComponent(names.evidence)}&per_page=100`,
      ),
    ]);
    receiptIdentity = bindOptionalArtifact(receiptMetadata, {
      headSha: input.headSha,
      name: names.receipt,
      runAttempt: input.runAttempt,
      runId: input.runId,
    });
    evidenceIdentity = bindOptionalArtifact(evidenceMetadata, {
      headSha: input.headSha,
      maxArchiveBytes: 128 * 1024 * 1024,
      name: names.evidence,
      runAttempt: input.runAttempt,
      runId: input.runId,
    });
  } catch (error) {
    return {
      run,
      job: selectedJob,
      receipt: null,
      artifacts: { receipt: null, evidence: null },
      failure: evidenceFailure("artifact-metadata", error),
    };
  }
  const artifacts = {
    receipt: receiptIdentity ? artifactIdentity(receiptIdentity) : null,
    evidence: evidenceIdentity ? artifactIdentity(evidenceIdentity) : null,
  };
  if (!receiptIdentity || !evidenceIdentity) {
    return {
      run,
      job: selectedJob,
      receipt: null,
      artifacts,
      failure: evidenceFailure(
        "artifact-missing",
        new Error(`${role} receipt or evidence artifact is missing`),
      ),
    };
  }
  let receiptArchive: Buffer;
  try {
    receiptArchive = await download(receiptIdentity);
  } catch (error) {
    return {
      run,
      job: selectedJob,
      receipt: null,
      artifacts,
      failure: evidenceFailure("receipt-download", error),
    };
  }
  let receipt: ManagedRuntimeReceipt;
  try {
    receipt = receiptFromArchive(receiptArchive, {
      baseSha: input.baseSha,
      candidateSha: input.candidateSha,
      role,
      runAttempt: input.runAttempt,
      runId: input.runId,
      workflowSha: input.workflowSha,
    });
  } catch (error) {
    return {
      run,
      job: selectedJob,
      receipt: null,
      artifacts,
      failure: evidenceFailure("receipt-parse", error),
    };
  }
  let evidenceArchive: Buffer;
  try {
    evidenceArchive = await download(evidenceIdentity);
  } catch (error) {
    return {
      run,
      job: selectedJob,
      receipt,
      artifacts,
      failure: evidenceFailure("evidence-download", error),
    };
  }
  try {
    verifyEvidenceArchive(evidenceArchive, receipt);
  } catch (error) {
    return {
      run,
      job: selectedJob,
      receipt,
      artifacts,
      failure: evidenceFailure("evidence-verification", error),
    };
  }
  return { run, job: selectedJob, receipt, artifacts, failure: null };
}

export async function classifyManagedRuntimeCurrentRun(
  input: {
    readonly baseJobConclusion: StepOutcome;
    readonly baseSha: string;
    readonly candidateJobConclusion: StepOutcome;
    readonly candidateSha: string;
    readonly eventName: "pull_request_target" | "workflow_dispatch";
    readonly pullRequest: number;
    readonly runAttempt: number;
    readonly runId: number;
    readonly token: string;
    readonly workflowSha: string;
  },
  options: {
    readonly request?: (apiPath: string) => Promise<unknown>;
    readonly downloadArtifact?: (identity: BoundArtifactIdentity) => Promise<Buffer>;
  } = {},
): Promise<ManagedRuntimeComparison> {
  const baseSha = sha(input.baseSha, "base SHA");
  const candidateSha = sha(input.candidateSha, "candidate SHA");
  const workflowSha = sha(input.workflowSha, "qualification workflow SHA");
  exactString(workflowSha, baseSha, "qualification workflow source");
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  const runId = positiveInteger(input.runId, "qualification run id");
  const runAttempt = positiveInteger(input.runAttempt, "qualification run attempt");
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  const request = options.request ?? ((apiPath: string) => githubRequest(apiPath, input.token));
  const download =
    options.downloadArtifact ??
    ((identity: BoundArtifactIdentity) => downloadBoundArtifact(identity, input.token));
  const pull = record(await request(`/repos/${REPOSITORY}/pulls/${pullRequest}`), "pull request");
  exactString(pull.state, "open", "pull request state");
  const pullBase = record(pull.base, "pull request base");
  const pullHead = record(pull.head, "pull request source");
  exactString(pullBase.sha, baseSha, "pull request base SHA");
  exactString(pullHead.sha, candidateSha, "pull request source SHA");
  exactString(
    record(pullBase.repo, "pull request base repository").full_name,
    REPOSITORY,
    "pull request base repository",
  );
  exactString(
    record(pullHead.repo, "pull request source repository").full_name,
    REPOSITORY,
    "pull request source repository",
  );
  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`),
  );
  const runPayload = record(
    await request(`/repos/${REPOSITORY}/actions/runs/${runId}`),
    "qualification workflow run",
  );
  if (runPayload.workflow_id !== workflowId || runPayload.run_attempt !== runAttempt) {
    throw new Error("qualification run does not match the current workflow attempt");
  }
  exactString(runPayload.name, WORKFLOW_NAME, "qualification workflow run name");
  exactString(runPayload.path, WORKFLOW_PATH, "qualification workflow run path");
  exactString(runPayload.event, input.eventName, "qualification workflow run event");
  const headSha = sha(runPayload.head_sha, "qualification workflow run head SHA");
  exactString(headSha, baseSha, "qualification workflow run head SHA");
  exactString(
    record(runPayload.repository, "qualification workflow repository").full_name,
    REPOSITORY,
    "qualification workflow repository",
  );
  const jobsPayload = record(
    await collectPaginated(
      request,
      `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
      "jobs",
    ),
    "qualification workflow jobs",
  );
  if (!Array.isArray(jobsPayload.jobs)) {
    throw new Error("qualification workflow job listing is invalid");
  }
  const common = {
    baseSha,
    candidateSha,
    headSha,
    jobs: jobsPayload.jobs,
    runAttempt,
    runId,
    workflowSha,
  } as const;
  const [candidate, base] = await Promise.all([
    readCurrentRunEvidence(
      "candidate",
      { ...common, expectedConclusion: input.candidateJobConclusion },
      request,
      download,
    ),
    readCurrentRunEvidence(
      "base",
      { ...common, expectedConclusion: input.baseJobConclusion },
      request,
      download,
    ),
  ]);
  return classifyManagedRuntimeComparison({ base, baseSha, candidate, candidateSha });
}

function writeJsonExclusive(target: string, value: unknown): void {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { mode: 0o700, recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv[0] === "record") {
    if (argv.length !== 2) throw new Error("expected one managed runtime receipt path");
    writeJsonExclusive(
      argv[1],
      createManagedRuntimeReceipt({
        baseSha: env.BASE_SHA ?? "",
        candidateSha: env.CANDIDATE_SHA ?? "",
        catalogPath: env.MANAGED_RUNTIME_CATALOG ?? "",
        evidenceDirectory: env.MANAGED_RUNTIME_EVIDENCE_DIRECTORY ?? "",
        imageRevision: env.MANAGED_IMAGE_REVISION ?? "",
        job: env.MANAGED_RUNTIME_JOB ?? "",
        openshellVersion: env.OPENSHELL_VERSION ?? "",
        outcome: stepOutcome(env.MANAGED_RUNTIME_OUTCOME, "MANAGED_RUNTIME_OUTCOME"),
        role:
          env.MANAGED_RUNTIME_ROLE === "base"
            ? "base"
            : env.MANAGED_RUNTIME_ROLE === "candidate"
              ? "candidate"
              : (() => {
                  throw new Error("MANAGED_RUNTIME_ROLE is invalid");
                })(),
        runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
        runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
        sourceSha: env.MANAGED_RUNTIME_SOURCE_SHA ?? "",
        workflowPath: env.MANAGED_RUNTIME_WORKFLOW_PATH ?? "",
        workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
      }),
    );
    return;
  }
  if (argv[0] === "classify") {
    if (argv.length !== 2) throw new Error("expected one comparison receipt path");
    const eventName = env.GITHUB_EVENT_NAME;
    if (eventName !== "pull_request_target" && eventName !== "workflow_dispatch") {
      throw new Error("managed runtime qualification event is invalid");
    }
    const comparison = await classifyManagedRuntimeCurrentRun({
      baseJobConclusion: stepOutcome(env.BASE_JOB_CONCLUSION, "BASE_JOB_CONCLUSION"),
      baseSha: env.BASE_SHA ?? "",
      candidateJobConclusion: stepOutcome(env.CANDIDATE_JOB_CONCLUSION, "CANDIDATE_JOB_CONCLUSION"),
      candidateSha: env.CANDIDATE_SHA ?? "",
      eventName,
      pullRequest: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
      runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
      runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      token: env.GITHUB_TOKEN ?? "",
      workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
    });
    writeJsonExclusive(argv[1], comparison);
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `classification=${comparison.classification}\nreason=${comparison.reason}\n`,
      "utf8",
    );
    if (comparison.classification === "infrastructure-failure") process.exitCode = 2;
    if (comparison.classification === "base-failure") process.exitCode = 3;
    if (comparison.classification === "candidate-failure") process.exitCode = 4;
    return;
  }
  throw new Error("expected classify or record");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "unknown managed runtime comparison error",
    );
    process.exitCode = 1;
  }
}
