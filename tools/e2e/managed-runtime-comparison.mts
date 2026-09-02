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
const SOURCE_WORKFLOW_FILE = "managed-images.yaml";
const SOURCE_WORKFLOW_NAME = "Images / Build, Test, and Publish Managed Images";
const SOURCE_WORKFLOW_PATH = `.github/workflows/${SOURCE_WORKFLOW_FILE}`;
const BASE_WORKFLOW_FILE = "managed-runtime-base-qualification.yaml";
const BASE_WORKFLOW_PATH = ".github/workflows/managed-runtime-base-qualification.yaml";
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
const SCENARIO_ID = "managed-runtime-activation-v1";
const TEST_PATH = "test/e2e/live/managed-image-activation-e2e.test.ts";
const RECEIPT_KIND = "nemoclaw-managed-runtime-activation-v1";
const MCP_SCENARIO_ID = "managed-image-mcp-discovery-v1";
const MCP_TEST_PATH = "test/e2e/live/mcp-bridge.test.ts";
const MCP_RECEIPT_KIND = "nemoclaw-managed-image-mcp-discovery-v1";
const MCP_JOB = "Trusted candidate OpenClaw managed-image MCP discovery";
const SOURCE_SELECTION_KIND = "nemoclaw-managed-runtime-source-selection-v1";
const SELECTION_KIND = "nemoclaw-managed-runtime-candidate-selection-v1";
const COMPARISON_KIND = "nemoclaw-managed-runtime-comparison-v1";
const MULTIARCH_COMPARISON_KIND = "nemoclaw-managed-runtime-multiarch-comparison-v1";
const RECEIPT_FILE = "receipt.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[^\0\r\n]{1,200}$/u;
const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const MAX_EVIDENCE_FILES = 1_000;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const STATUS_CONTEXT = "NemoClaw / Exact-base managed runtime";

type JsonRecord = Record<string, unknown>;
type Role = "base" | "candidate";
type Platform = (typeof PLATFORMS)[number];
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

export interface ManagedRuntimeReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly role: Role;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly sourceSha: string;
  readonly candidateSource: {
    readonly workflowPath: typeof SOURCE_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly scenario: {
    readonly id: typeof SCENARIO_ID;
    readonly testPath: typeof TEST_PATH;
    readonly platform: Platform;
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

export interface ManagedMcpDiscoveryReceipt {
  readonly kind: typeof MCP_RECEIPT_KIND;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly candidateSource: {
    readonly workflowPath: typeof SOURCE_WORKFLOW_PATH;
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly scenario: {
    readonly id: typeof MCP_SCENARIO_ID;
    readonly testPath: typeof MCP_TEST_PATH;
  };
  readonly workflow: {
    readonly repository: typeof REPOSITORY;
    readonly path: typeof BASE_WORKFLOW_PATH;
    readonly sha: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly job: string;
    readonly controllerDigest: string;
  };
  readonly runtime: {
    readonly openshellVersion: string;
    readonly catalogDigest: string;
    readonly image: {
      readonly agent: "openclaw";
      readonly reference: string;
      readonly sourceRevision: string;
      readonly cohort: string;
    };
  };
  readonly evidence: ManagedRuntimeReceipt["evidence"];
  readonly outcome: StepOutcome;
}

export interface ManagedRuntimeSourceSelection {
  readonly kind: typeof SOURCE_SELECTION_KIND;
  readonly pullRequest: number;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly workflow: {
    readonly id: number;
    readonly path: typeof SOURCE_WORKFLOW_PATH;
  };
  readonly run: { readonly id: number; readonly attempt: number };
}

export interface ManagedRuntimeCandidateSelection {
  readonly kind: typeof SELECTION_KIND;
  readonly pullRequest: number;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly platform: Platform;
  readonly workflow: {
    readonly id: number;
    readonly path: typeof BASE_WORKFLOW_PATH;
    readonly sha: string;
  };
  readonly run: { readonly id: number; readonly attempt: number };
  readonly source: { readonly runId: number; readonly runAttempt: number };
  readonly job: { readonly id: number; readonly conclusion: StepOutcome };
  readonly evidenceError: string | null;
  readonly receipt: ManagedRuntimeReceipt | null;
  readonly artifacts: {
    readonly receipt: ArtifactIdentity | null;
    readonly evidence: ArtifactIdentity | null;
  };
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
    readonly evidenceError: string | null;
  };
  readonly base: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly jobConclusion: StepOutcome;
    readonly receiptArtifact: ArtifactIdentity | null;
    readonly evidenceArtifact: ArtifactIdentity | null;
    readonly evidenceError: string | null;
  };
  readonly scenario: {
    readonly id: typeof SCENARIO_ID;
    readonly platform: Platform;
    readonly candidateSha: string;
    readonly baseSha: string;
    readonly candidateSourceRunId: number;
    readonly candidateSourceRunAttempt: number;
  };
}

export interface ManagedRuntimeMultiarchComparison {
  readonly kind: typeof MULTIARCH_COMPARISON_KIND;
  readonly classification: ComparisonClassification;
  readonly platforms: Readonly<Record<Platform, ManagedRuntimeComparison>>;
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

function platform(value: unknown, label: string): Platform {
  if (!PLATFORMS.includes(value as Platform)) throw new Error(`${label} is invalid`);
  return value as Platform;
}

function platformArch(value: Platform): "amd64" | "arm64" {
  return value.slice("linux/".length) as "amd64" | "arm64";
}

function activationJob(role: Role, value: Platform): string {
  const subject = role === "candidate" ? "Trusted candidate" : "Exact base";
  return `${subject} all-agent managed runtime activation (${platformArch(value)})`;
}

function artifactIdentity(value: BoundArtifactIdentity): ArtifactIdentity {
  return {
    id: value.id,
    name: value.name,
    digest: value.digest,
    size: value.size,
  };
}

function parseArtifactIdentity(value: unknown, label: string): ArtifactIdentity | null {
  if (value === null) return null;
  const artifact = record(value, label);
  exactKeys(artifact, ["digest", "id", "name", "size"], label);
  if (
    typeof artifact.name !== "string" ||
    artifact.name.length > 255 ||
    !/^[A-Za-z0-9._-]+$/u.test(artifact.name)
  ) {
    throw new Error(`${label} name is invalid`);
  }
  return {
    id: positiveInteger(artifact.id, `${label} id`),
    name: artifact.name,
    digest: digest(artifact.digest, `${label} digest`),
    size: positiveInteger(artifact.size, `${label} size`),
  };
}

function hash(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readCatalog(
  catalogPath: string,
  role: Role,
  candidateSha: string,
  imageRevision: string,
  candidateSourceRunId: number,
  candidateSourceRunAttempt: number,
  expectedPlatform: Platform,
) {
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
    exactString(contract.platform, expectedPlatform, `${agent} managed runtime platform`);
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
    if (
      role === "candidate" &&
      source.cohort !== `ghrun-${candidateSourceRunId}-${candidateSourceRunAttempt}`
    ) {
      throw new Error(`${agent} candidate image cohort does not match the source workflow attempt`);
    }
    return {
      agent,
      reference,
      sourceRevision: imageRevision,
      cohort: source.cohort,
    };
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

function parseEvidence(value: unknown, label: string): ManagedRuntimeReceipt["evidence"] {
  const evidence = record(value, label);
  exactKeys(evidence, ["cleanup", "files"], label);
  if (!Array.isArray(evidence.files) || evidence.files.length > MAX_EVIDENCE_FILES) {
    throw new Error(`${label} file list is invalid`);
  }
  const evidencePaths = new Set<string>();
  let evidenceBytes = 0;
  for (const rawFile of evidence.files) {
    const file = record(rawFile, `${label} file`);
    exactKeys(file, ["digest", "path", "size"], `${label} file`);
    digest(file.digest, `${label} file digest`);
    const size = nonnegativeInteger(file.size, `${label} file size`);
    if (
      typeof file.path !== "string" ||
      !/^[A-Za-z0-9._/-]+$/u.test(file.path) ||
      file.path.includes("..")
    ) {
      throw new Error(`${label} file path is invalid`);
    }
    if (evidencePaths.has(file.path)) throw new Error(`${label} file paths must be unique`);
    evidencePaths.add(file.path);
    evidenceBytes += size;
    if (evidenceBytes > MAX_EVIDENCE_BYTES) throw new Error(`${label} exceeds the receipt limit`);
  }
  const cleanup = record(evidence.cleanup, `${label} cleanup`);
  exactKeys(cleanup, ["failures", "path", "proven"], `${label} cleanup`);
  if (
    cleanup.path !== null &&
    (typeof cleanup.path !== "string" || !cleanup.path.endsWith("/cleanup.json"))
  ) {
    throw new Error(`${label} cleanup receipt path is invalid`);
  }
  if (typeof cleanup.proven !== "boolean" || !Number.isSafeInteger(cleanup.failures)) {
    throw new Error(`${label} cleanup is invalid`);
  }
  if (cleanup.path !== null && !evidencePaths.has(cleanup.path)) {
    throw new Error(`${label} cleanup receipt is absent from the file list`);
  }
  if (cleanup.proven !== (cleanup.path !== null && cleanup.failures === 0)) {
    throw new Error(`${label} cleanup verdict does not match its evidence`);
  }
  return evidence as unknown as ManagedRuntimeReceipt["evidence"];
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
  readonly platform: Platform;
  readonly candidateSourceRunAttempt: number;
  readonly candidateSourceRunId: number;
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
  if (input.role === "base") {
    exactString(imageRevision, baseSha, "exact-base managed image revision");
  }
  const expectedPath = BASE_WORKFLOW_PATH;
  const expectedPlatform = platform(input.platform, "managed runtime platform");
  const expectedJob = activationJob(input.role, expectedPlatform);
  exactString(input.workflowPath, expectedPath, "managed runtime workflow path");
  exactString(input.job, expectedJob, "managed runtime job");
  const workflowSha = sha(input.workflowSha, "workflow SHA");
  if (!VERSION_PATTERN.test(input.openshellVersion)) {
    throw new Error("OpenShell runtime version is invalid");
  }
  const candidateSourceRunId = positiveInteger(
    input.candidateSourceRunId,
    "candidate source run id",
  );
  const candidateSourceRunAttempt = positiveInteger(
    input.candidateSourceRunAttempt,
    "candidate source run attempt",
  );
  const catalog = readCatalog(
    input.catalogPath,
    input.role,
    candidateSha,
    imageRevision,
    candidateSourceRunId,
    candidateSourceRunAttempt,
    expectedPlatform,
  );
  const files = evidenceFiles(input.evidenceDirectory);
  return {
    kind: RECEIPT_KIND,
    role: input.role,
    candidateSha,
    baseSha,
    sourceSha,
    candidateSource: {
      workflowPath: SOURCE_WORKFLOW_PATH,
      runId: candidateSourceRunId,
      runAttempt: candidateSourceRunAttempt,
    },
    scenario: {
      id: SCENARIO_ID,
      testPath: TEST_PATH,
      platform: expectedPlatform,
      agents: AGENTS,
    },
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
    evidence: {
      files,
      cleanup: cleanupEvidence(path.resolve(input.evidenceDirectory), files),
    },
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
    readonly candidateSourceRunAttempt: number;
    readonly candidateSourceRunId: number;
    readonly platform: Platform;
    readonly workflowSha: string;
  },
): ManagedRuntimeReceipt {
  const receipt = record(value, "managed runtime receipt");
  exactKeys(
    receipt,
    [
      "baseSha",
      "candidateSource",
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
  const candidateSource = record(receipt.candidateSource, "managed runtime candidate source");
  exactKeys(
    candidateSource,
    ["runAttempt", "runId", "workflowPath"],
    "managed runtime candidate source",
  );
  exactString(
    candidateSource.workflowPath,
    SOURCE_WORKFLOW_PATH,
    "managed runtime candidate source workflow path",
  );
  if (
    candidateSource.runId !== expected.candidateSourceRunId ||
    candidateSource.runAttempt !== expected.candidateSourceRunAttempt
  ) {
    throw new Error("managed runtime receipt does not match the candidate source attempt");
  }
  const scenario = record(receipt.scenario, "managed runtime scenario");
  exactKeys(scenario, ["agents", "id", "platform", "testPath"], "managed runtime scenario");
  exactString(scenario.id, SCENARIO_ID, "managed runtime scenario id");
  exactString(scenario.testPath, TEST_PATH, "managed runtime scenario test");
  exactString(scenario.platform, expected.platform, "managed runtime scenario platform");
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
  exactString(workflow.path, BASE_WORKFLOW_PATH, "managed runtime workflow path");
  exactString(
    workflow.job,
    activationJob(expected.role, expected.platform),
    "managed runtime workflow job",
  );
  exactString(workflow.sha, expected.workflowSha, "managed runtime workflow SHA");
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
    const expectedImageRevision =
      expected.role === "candidate" ? expected.candidateSha : expected.baseSha;
    if (image.sourceRevision !== expectedImageRevision) {
      throw new Error(`${expected.role} managed runtime image revision is stale`);
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
  parseEvidence(receipt.evidence, "managed runtime evidence");
  stepOutcome(receipt.outcome, "managed runtime receipt outcome");
  return receipt as unknown as ManagedRuntimeReceipt;
}

export function createManagedMcpDiscoveryReceipt(input: {
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly candidateSourceRunAttempt: number;
  readonly candidateSourceRunId: number;
  readonly catalogPath: string;
  readonly controllerDigest: string;
  readonly evidenceDirectory: string;
  readonly job: string;
  readonly openshellVersion: string;
  readonly outcome: StepOutcome;
  readonly runAttempt: number;
  readonly runId: number;
  readonly workflowSha: string;
}): ManagedMcpDiscoveryReceipt {
  const candidateSha = sha(input.candidateSha, "MCP candidate SHA");
  const baseSha = sha(input.baseSha, "MCP base SHA");
  exactString(input.job, MCP_JOB, "MCP workflow job");
  if (!VERSION_PATTERN.test(input.openshellVersion)) {
    throw new Error("MCP OpenShell runtime version is invalid");
  }
  const candidateSourceRunId = positiveInteger(
    input.candidateSourceRunId,
    "MCP candidate source run id",
  );
  const candidateSourceRunAttempt = positiveInteger(
    input.candidateSourceRunAttempt,
    "MCP candidate source run attempt",
  );
  const catalog = readCatalog(
    input.catalogPath,
    "candidate",
    candidateSha,
    candidateSha,
    candidateSourceRunId,
    candidateSourceRunAttempt,
    "linux/amd64",
  );
  const image = catalog.images.find(({ agent }) => agent === "openclaw");
  if (!image || image.agent !== "openclaw") throw new Error("MCP OpenClaw image is missing");
  const files = evidenceFiles(input.evidenceDirectory);
  return {
    kind: MCP_RECEIPT_KIND,
    candidateSha,
    baseSha,
    candidateSource: {
      workflowPath: SOURCE_WORKFLOW_PATH,
      runId: candidateSourceRunId,
      runAttempt: candidateSourceRunAttempt,
    },
    scenario: { id: MCP_SCENARIO_ID, testPath: MCP_TEST_PATH },
    workflow: {
      repository: REPOSITORY,
      path: BASE_WORKFLOW_PATH,
      sha: sha(input.workflowSha, "MCP workflow SHA"),
      runId: positiveInteger(input.runId, "MCP run id"),
      runAttempt: positiveInteger(input.runAttempt, "MCP run attempt"),
      job: MCP_JOB,
      controllerDigest: digest(input.controllerDigest, "MCP controller digest"),
    },
    runtime: {
      openshellVersion: input.openshellVersion,
      catalogDigest: catalog.digest,
      image: {
        agent: "openclaw",
        reference: image.reference,
        sourceRevision: image.sourceRevision,
        cohort: image.cohort,
      },
    },
    evidence: {
      files,
      cleanup: cleanupEvidence(path.resolve(input.evidenceDirectory), files),
    },
    outcome: stepOutcome(input.outcome, "MCP outcome"),
  };
}

export function parseManagedMcpDiscoveryReceipt(
  value: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly candidateSourceRunAttempt: number;
    readonly candidateSourceRunId: number;
    readonly runAttempt: number;
    readonly runId: number;
    readonly workflowSha: string;
  },
): ManagedMcpDiscoveryReceipt {
  const receipt = record(value, "MCP discovery receipt");
  exactKeys(
    receipt,
    [
      "baseSha",
      "candidateSource",
      "candidateSha",
      "evidence",
      "kind",
      "outcome",
      "runtime",
      "scenario",
      "workflow",
    ],
    "MCP discovery receipt",
  );
  exactString(receipt.kind, MCP_RECEIPT_KIND, "MCP discovery receipt kind");
  exactString(receipt.candidateSha, expected.candidateSha, "MCP candidate SHA");
  exactString(receipt.baseSha, expected.baseSha, "MCP base SHA");
  const source = record(receipt.candidateSource, "MCP candidate source");
  exactKeys(source, ["runAttempt", "runId", "workflowPath"], "MCP candidate source");
  exactString(source.workflowPath, SOURCE_WORKFLOW_PATH, "MCP source workflow path");
  if (
    source.runId !== expected.candidateSourceRunId ||
    source.runAttempt !== expected.candidateSourceRunAttempt
  ) {
    throw new Error("MCP receipt does not match the candidate source attempt");
  }
  const scenario = record(receipt.scenario, "MCP scenario");
  exactKeys(scenario, ["id", "testPath"], "MCP scenario");
  exactString(scenario.id, MCP_SCENARIO_ID, "MCP scenario id");
  exactString(scenario.testPath, MCP_TEST_PATH, "MCP scenario test");
  const workflow = record(receipt.workflow, "MCP workflow");
  exactKeys(
    workflow,
    ["controllerDigest", "job", "path", "repository", "runAttempt", "runId", "sha"],
    "MCP workflow",
  );
  exactString(workflow.repository, REPOSITORY, "MCP workflow repository");
  exactString(workflow.path, BASE_WORKFLOW_PATH, "MCP workflow path");
  exactString(workflow.sha, expected.workflowSha, "MCP workflow SHA");
  exactString(workflow.job, MCP_JOB, "MCP workflow job");
  if (workflow.runId !== expected.runId || workflow.runAttempt !== expected.runAttempt) {
    throw new Error("MCP receipt does not match the workflow attempt");
  }
  digest(workflow.controllerDigest, "MCP controller digest");
  const runtime = record(receipt.runtime, "MCP runtime identity");
  exactKeys(runtime, ["catalogDigest", "image", "openshellVersion"], "MCP runtime identity");
  digest(runtime.catalogDigest, "MCP catalog digest");
  if (
    typeof runtime.openshellVersion !== "string" ||
    !VERSION_PATTERN.test(runtime.openshellVersion)
  ) {
    throw new Error("MCP OpenShell runtime version is invalid");
  }
  const image = record(runtime.image, "MCP image identity");
  exactKeys(image, ["agent", "cohort", "reference", "sourceRevision"], "MCP image identity");
  exactString(image.agent, "openclaw", "MCP image agent");
  if (typeof image.reference !== "string" || !/@sha256:[0-9a-f]{64}$/u.test(image.reference)) {
    throw new Error("MCP image reference is mutable");
  }
  exactString(image.sourceRevision, expected.candidateSha, "MCP image source revision");
  if (typeof image.cohort !== "string" || !/^ghrun-[1-9][0-9]*-[1-9][0-9]*$/u.test(image.cohort)) {
    throw new Error("MCP image cohort is invalid");
  }
  parseEvidence(receipt.evidence, "MCP evidence");
  stepOutcome(receipt.outcome, "MCP outcome");
  return receipt as unknown as ManagedMcpDiscoveryReceipt;
}

function verifyMcpEvidenceDirectory(root: string, receipt: ManagedMcpDiscoveryReceipt): void {
  const files = evidenceFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(receipt.evidence.files)) {
    throw new Error("MCP evidence files do not match the protected receipt");
  }
  if (
    JSON.stringify(cleanupEvidence(path.resolve(root), files)) !==
    JSON.stringify(receipt.evidence.cleanup)
  ) {
    throw new Error("MCP cleanup evidence does not match the protected receipt");
  }
}

export function verifyCurrentMcpDiscovery(
  receiptPath: string,
  evidenceDirectory: string,
  expected: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly candidateSourceRunAttempt: number;
    readonly candidateSourceRunId: number;
    readonly runAttempt: number;
    readonly runId: number;
    readonly workflowSha: string;
  },
): ManagedMcpDiscoveryReceipt {
  const receipt = parseManagedMcpDiscoveryReceipt(
    JSON.parse(fs.readFileSync(receiptPath, "utf8")) as unknown,
    expected,
  );
  verifyMcpEvidenceDirectory(evidenceDirectory, receipt);
  if (!receipt.evidence.cleanup.proven) {
    throw new Error("MCP discovery cleanup is not proven");
  }
  if (receipt.outcome !== "success") {
    throw new Error("authenticated MCP discovery did not pass");
  }
  return receipt;
}
function validateWorkflow(
  value: unknown,
  expected: { readonly name: string; readonly path: string },
): number {
  const workflow = record(value, "managed runtime workflow");
  exactString(workflow.name, expected.name, "managed runtime workflow name");
  exactString(workflow.path, expected.path, "managed runtime workflow path");
  exactString(workflow.state, "active", "managed runtime workflow state");
  return positiveInteger(workflow.id, "managed runtime workflow id");
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
    {
      headSha: expected.headSha,
      runAttempt: expected.runAttempt,
      runId: expected.runId,
    },
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

export async function selectManagedRuntimeSource(
  input: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly pullRequest: number;
    readonly runAttempt: number;
    readonly runId: number;
    readonly token: string;
  },
  options: {
    readonly request?: (apiPath: string) => Promise<unknown>;
  } = {},
): Promise<ManagedRuntimeSourceSelection> {
  const baseSha = sha(input.baseSha, "base SHA");
  const candidateSha = sha(input.candidateSha, "candidate SHA");
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  const runId = positiveInteger(input.runId, "source run id");
  const runAttempt = positiveInteger(input.runAttempt, "source run attempt");
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  const request = options.request ?? ((apiPath: string) => githubRequest(apiPath, input.token));
  const pull = record(await request(`/repos/${REPOSITORY}/pulls/${pullRequest}`), "pull request");
  exactString(pull.state, "open", "pull request state");
  exactString(
    record(pull.head, "pull request source").sha,
    candidateSha,
    "pull request source SHA",
  );
  exactString(record(pull.base, "pull request base").sha, baseSha, "pull request base SHA");
  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${SOURCE_WORKFLOW_FILE}`),
    { name: SOURCE_WORKFLOW_NAME, path: SOURCE_WORKFLOW_PATH },
  );
  const run = record(
    await request(`/repos/${REPOSITORY}/actions/runs/${runId}`),
    "source workflow run",
  );
  if (run.workflow_id !== workflowId || run.run_attempt !== runAttempt) {
    throw new Error("source workflow run does not match the requested workflow attempt");
  }
  exactString(run.path, SOURCE_WORKFLOW_PATH, "source workflow run path");
  exactString(run.event, "pull_request", "source workflow run event");
  exactString(run.head_sha, candidateSha, "source workflow run commit");
  exactString(run.status, "completed", "source workflow run status");
  exactString(run.conclusion, "success", "source workflow run conclusion");
  exactString(
    record(run.repository, "source workflow repository").full_name,
    REPOSITORY,
    "source workflow repository",
  );
  exactString(
    record(run.head_repository, "source workflow source repository").full_name,
    REPOSITORY,
    "source workflow source repository",
  );
  if (
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1 ||
    record(run.pull_requests[0], "source workflow pull request").number !== pullRequest
  ) {
    throw new Error("source workflow run does not match the pull request");
  }
  exactString(
    record(
      record(run.pull_requests[0], "source workflow pull request").head,
      "source workflow pull request source",
    ).sha,
    candidateSha,
    "source workflow pull request source SHA",
  );
  exactString(
    record(
      record(run.pull_requests[0], "source workflow pull request").base,
      "source workflow pull request base",
    ).sha,
    baseSha,
    "source workflow pull request base SHA",
  );
  return {
    kind: SOURCE_SELECTION_KIND,
    pullRequest,
    candidateSha,
    baseSha,
    workflow: { id: workflowId, path: SOURCE_WORKFLOW_PATH },
    run: { id: runId, attempt: runAttempt },
  };
}

export async function selectManagedRuntimeCandidate(
  input: {
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly controllerHeadSha: string;
    readonly pullRequest: number;
    readonly platform: Platform;
    readonly runAttempt: number;
    readonly runId: number;
    readonly sourceRunAttempt: number;
    readonly sourceRunId: number;
    readonly token: string;
    readonly workflowSha: string;
  },
  options: {
    readonly request?: (apiPath: string) => Promise<unknown>;
    readonly downloadArtifact?: (identity: BoundArtifactIdentity) => Promise<Buffer>;
  } = {},
): Promise<ManagedRuntimeCandidateSelection> {
  const baseSha = sha(input.baseSha, "base SHA");
  const candidateSha = sha(input.candidateSha, "candidate SHA");
  const controllerHeadSha = sha(input.controllerHeadSha, "controller head SHA");
  const workflowSha = sha(input.workflowSha, "workflow SHA");
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  const runId = positiveInteger(input.runId, "qualification run id");
  const runAttempt = positiveInteger(input.runAttempt, "qualification run attempt");
  const sourceRunId = positiveInteger(input.sourceRunId, "candidate source run id");
  const sourceRunAttempt = positiveInteger(input.sourceRunAttempt, "candidate source run attempt");
  const expectedPlatform = platform(input.platform, "managed runtime platform");
  const arch = platformArch(expectedPlatform);
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  const request = options.request ?? ((apiPath: string) => githubRequest(apiPath, input.token));
  const download =
    options.downloadArtifact ??
    ((identity: BoundArtifactIdentity) => downloadBoundArtifact(identity, input.token));
  const pull = record(await request(`/repos/${REPOSITORY}/pulls/${pullRequest}`), "pull request");
  exactString(pull.state, "open", "pull request state");
  exactString(
    record(pull.head, "pull request source").sha,
    candidateSha,
    "pull request source SHA",
  );
  exactString(record(pull.base, "pull request base").sha, baseSha, "pull request base SHA");
  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${BASE_WORKFLOW_FILE}`),
    { name: "E2E / Exact Base Managed Runtime", path: BASE_WORKFLOW_PATH },
  );
  const run = record(
    await request(`/repos/${REPOSITORY}/actions/runs/${runId}`),
    "qualification workflow run",
  );
  if (run.workflow_id !== workflowId || run.run_attempt !== runAttempt) {
    throw new Error("qualification run does not match the requested workflow attempt");
  }
  exactString(run.path, BASE_WORKFLOW_PATH, "qualification workflow run path");
  if (run.event !== "workflow_run" && run.event !== "workflow_dispatch") {
    throw new Error("qualification workflow run event is invalid");
  }
  exactString(run.head_sha, controllerHeadSha, "qualification workflow run commit");
  exactString(
    record(run.repository, "qualification workflow repository").full_name,
    REPOSITORY,
    "qualification workflow repository",
  );
  const jobs = record(
    await collectPaginated(
      request,
      `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
      "jobs",
    ),
    "qualification workflow jobs",
  );
  if (!Array.isArray(jobs.jobs)) throw new Error("qualification workflow job listing is invalid");
  const matches = jobs.jobs
    .map((value) => record(value, "qualification workflow job"))
    .filter((job) => job.name === activationJob("candidate", expectedPlatform));
  if (matches.length !== 1)
    throw new Error("candidate managed runtime job is missing or ambiguous");
  const job = matches[0]!;
  exactString(job.status, "completed", "candidate managed runtime job status");
  const conclusion = stepOutcome(job.conclusion, "candidate managed runtime job conclusion");
  const jobId = positiveInteger(job.id, "candidate managed runtime job id");
  const receiptName = `managed-runtime-candidate-receipt-${runId}-${runAttempt}-${arch}`;
  const evidenceName = `managed-runtime-candidate-evidence-${runId}-${runAttempt}-${arch}`;
  const [receiptMetadata, evidenceMetadata] = await Promise.all([
    request(
      `/repos/${REPOSITORY}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(receiptName)}&per_page=100`,
    ),
    request(
      `/repos/${REPOSITORY}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(evidenceName)}&per_page=100`,
    ),
  ]);
  const receiptIdentity = bindOptionalArtifact(receiptMetadata, {
    headSha: controllerHeadSha,
    name: receiptName,
    runAttempt,
    runId,
  });
  const evidenceIdentity = bindOptionalArtifact(evidenceMetadata, {
    headSha: controllerHeadSha,
    maxArchiveBytes: 128 * 1024 * 1024,
    name: evidenceName,
    runAttempt,
    runId,
  });
  let receipt: ManagedRuntimeReceipt | null = null;
  let evidenceError: string | null = null;
  if (receiptIdentity) {
    try {
      receipt = receiptFromArchive(await download(receiptIdentity), {
        baseSha,
        candidateSha,
        candidateSourceRunAttempt: sourceRunAttempt,
        candidateSourceRunId: sourceRunId,
        role: "candidate",
        platform: expectedPlatform,
        runAttempt,
        runId,
        workflowSha,
      });
    } catch {
      evidenceError = "receipt download or validation failed";
    }
  }
  if (receipt && evidenceIdentity) {
    try {
      verifyEvidenceArchive(await download(evidenceIdentity), receipt);
    } catch {
      evidenceError ??= "evidence download or digest validation failed";
    }
  }
  return {
    kind: SELECTION_KIND,
    pullRequest,
    candidateSha,
    baseSha,
    platform: expectedPlatform,
    workflow: { id: workflowId, path: BASE_WORKFLOW_PATH, sha: workflowSha },
    run: { id: runId, attempt: runAttempt },
    source: { runId: sourceRunId, runAttempt: sourceRunAttempt },
    job: { id: jobId, conclusion },
    evidenceError,
    receipt,
    artifacts: {
      receipt: receiptIdentity ? artifactIdentity(receiptIdentity) : null,
      evidence: evidenceIdentity ? artifactIdentity(evidenceIdentity) : null,
    },
  };
}

function matchingOutcome(job: StepOutcome, receipt: ManagedRuntimeReceipt): boolean {
  return job === receipt.outcome || (job === "failure" && receipt.outcome === "failure");
}

export function classifyManagedRuntimeComparison(input: {
  readonly baseArtifact: ArtifactIdentity | null;
  readonly baseEvidenceError?: string | null;
  readonly baseEvidenceArtifact: ArtifactIdentity | null;
  readonly baseJobConclusion: StepOutcome;
  readonly baseReceipt: ManagedRuntimeReceipt | null;
  readonly baseRunAttempt: number;
  readonly baseRunId: number;
  readonly candidate: ManagedRuntimeCandidateSelection;
}): ManagedRuntimeComparison {
  const candidate = input.candidate;
  const common = {
    kind: COMPARISON_KIND,
    candidate: {
      runId: candidate.run.id,
      runAttempt: candidate.run.attempt,
      jobConclusion: candidate.job.conclusion,
      receiptArtifact: candidate.artifacts.receipt,
      evidenceArtifact: candidate.artifacts.evidence,
      evidenceError: candidate.evidenceError,
    },
    base: {
      runId: input.baseRunId,
      runAttempt: input.baseRunAttempt,
      jobConclusion: input.baseJobConclusion,
      receiptArtifact: input.baseArtifact,
      evidenceArtifact: input.baseEvidenceArtifact,
      evidenceError: input.baseEvidenceError ?? null,
    },
    scenario: {
      id: SCENARIO_ID,
      platform: candidate.platform,
      candidateSha: candidate.candidateSha,
      baseSha: candidate.baseSha,
      candidateSourceRunId: candidate.source.runId,
      candidateSourceRunAttempt: candidate.source.runAttempt,
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
  if (candidate.evidenceError) {
    return infrastructure(`candidate evidence validation failed: ${candidate.evidenceError}`);
  }
  if (!candidate.receipt || !candidate.artifacts.receipt || !candidate.artifacts.evidence) {
    return infrastructure("candidate evidence is missing or incomplete");
  }
  if (input.baseJobConclusion === "cancelled" || input.baseJobConclusion === "skipped") {
    return infrastructure("coordination cancellation did not produce a product verdict");
  }
  if (input.baseEvidenceError) {
    return infrastructure(`base evidence validation failed: ${input.baseEvidenceError}`);
  }
  if (!input.baseReceipt || !input.baseArtifact || !input.baseEvidenceArtifact) {
    return infrastructure("base evidence is missing or incomplete");
  }
  if (
    !matchingOutcome(candidate.job.conclusion, candidate.receipt) ||
    !matchingOutcome(input.baseJobConclusion, input.baseReceipt)
  ) {
    return infrastructure("workflow conclusions do not match the authenticated scenario receipts");
  }
  if (
    JSON.stringify(candidate.receipt.scenario) !== JSON.stringify(input.baseReceipt.scenario) ||
    candidate.receipt.candidateSha !== input.baseReceipt.candidateSha ||
    candidate.receipt.baseSha !== input.baseReceipt.baseSha
  ) {
    return infrastructure("candidate and base evidence use different scenario identities");
  }
  if (
    candidate.receipt.workflow.sha !== input.baseReceipt.workflow.sha ||
    candidate.receipt.workflow.runId !== input.baseReceipt.workflow.runId ||
    candidate.receipt.workflow.runAttempt !== input.baseReceipt.workflow.runAttempt ||
    candidate.receipt.runtime.openshellVersion !== input.baseReceipt.runtime.openshellVersion
  ) {
    return infrastructure(
      "candidate and base evidence use different controller runtime identities",
    );
  }
  if (!candidate.receipt.evidence.cleanup.proven || !input.baseReceipt.evidence.cleanup.proven) {
    return infrastructure("candidate or base cleanup is not proven");
  }
  if (input.baseJobConclusion === "failure") {
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
  if (candidate.job.conclusion !== "success" || input.baseJobConclusion !== "success") {
    return infrastructure("scenario outcomes are not classifiable");
  }
  return {
    ...common,
    classification: "pass",
    reason: "candidate and exact-base scenarios passed",
  };
}

export function combineManagedRuntimeComparisons(
  comparisons: readonly ManagedRuntimeComparison[],
): ManagedRuntimeMultiarchComparison {
  if (comparisons.length !== PLATFORMS.length) {
    throw new Error("managed runtime multiarch comparison requires every platform exactly once");
  }
  const byPlatform = new Map<Platform, ManagedRuntimeComparison>();
  for (const comparison of comparisons) {
    if (comparison.kind !== COMPARISON_KIND) {
      throw new Error("managed runtime comparison kind is invalid");
    }
    const selectedPlatform = platform(
      comparison.scenario.platform,
      "managed runtime comparison platform",
    );
    if (byPlatform.has(selectedPlatform)) {
      throw new Error("managed runtime multiarch comparison contains a duplicate platform");
    }
    byPlatform.set(selectedPlatform, comparison);
  }
  for (const selectedPlatform of PLATFORMS) {
    if (!byPlatform.has(selectedPlatform)) {
      throw new Error(`managed runtime multiarch comparison is missing ${selectedPlatform}`);
    }
  }
  const reference = comparisons[0]!.scenario;
  for (const comparison of comparisons.slice(1)) {
    const scenario = comparison.scenario;
    if (
      scenario.id !== reference.id ||
      scenario.candidateSha !== reference.candidateSha ||
      scenario.baseSha !== reference.baseSha ||
      scenario.candidateSourceRunId !== reference.candidateSourceRunId ||
      scenario.candidateSourceRunAttempt !== reference.candidateSourceRunAttempt
    ) {
      throw new Error("managed runtime platform comparisons use different scenario identities");
    }
  }
  const precedence: Readonly<Record<ComparisonClassification, number>> = {
    pass: 0,
    "candidate-failure": 1,
    "base-failure": 2,
    "infrastructure-failure": 3,
  };
  const classification = comparisons.reduce<ComparisonClassification>(
    (overall, comparison) =>
      precedence[comparison.classification] > precedence[overall]
        ? comparison.classification
        : overall,
    "pass",
  );
  return {
    kind: MULTIARCH_COMPARISON_KIND,
    classification,
    platforms: Object.fromEntries(
      PLATFORMS.map((selectedPlatform) => [selectedPlatform, byPlatform.get(selectedPlatform)!]),
    ) as Record<Platform, ManagedRuntimeComparison>,
  };
}

function readCandidateSelection(target: string): ManagedRuntimeCandidateSelection {
  const selection = record(
    JSON.parse(fs.readFileSync(target, "utf8")) as unknown,
    "managed runtime candidate selection",
  );
  exactString(selection.kind, SELECTION_KIND, "managed runtime candidate selection kind");
  exactKeys(
    selection,
    [
      "artifacts",
      "baseSha",
      "candidateSha",
      "evidenceError",
      "job",
      "kind",
      "pullRequest",
      "platform",
      "receipt",
      "run",
      "source",
      "workflow",
    ],
    "managed runtime candidate selection",
  );
  const run = record(selection.run, "managed runtime candidate selection run");
  exactKeys(run, ["attempt", "id"], "managed runtime candidate selection run");
  const job = record(selection.job, "managed runtime candidate selection job");
  exactKeys(job, ["conclusion", "id"], "managed runtime candidate selection job");
  const artifacts = record(selection.artifacts, "managed runtime candidate selection artifacts");
  exactKeys(artifacts, ["evidence", "receipt"], "managed runtime candidate selection artifacts");
  const workflow = record(selection.workflow, "managed runtime candidate selection workflow");
  exactKeys(workflow, ["id", "path", "sha"], "managed runtime candidate selection workflow");
  exactString(
    workflow.path,
    BASE_WORKFLOW_PATH,
    "managed runtime candidate selection workflow path",
  );
  const workflowSha = sha(workflow.sha, "managed runtime candidate selection workflow SHA");
  const source = record(selection.source, "managed runtime candidate selection source");
  exactKeys(source, ["runAttempt", "runId"], "managed runtime candidate selection source");
  const sourceRunId = positiveInteger(source.runId, "managed runtime candidate source run id");
  const sourceRunAttempt = positiveInteger(
    source.runAttempt,
    "managed runtime candidate source run attempt",
  );
  const candidateSha = sha(selection.candidateSha, "managed runtime selection candidate SHA");
  const baseSha = sha(selection.baseSha, "managed runtime selection base SHA");
  const expectedPlatform = platform(selection.platform, "managed runtime selection platform");
  const arch = platformArch(expectedPlatform);
  const runId = positiveInteger(run.id, "managed runtime selection run id");
  const runAttempt = positiveInteger(run.attempt, "managed runtime selection run attempt");
  const receipt = selection.receipt
    ? parseManagedRuntimeReceipt(selection.receipt, {
        baseSha,
        candidateSha,
        candidateSourceRunAttempt: sourceRunAttempt,
        candidateSourceRunId: sourceRunId,
        role: "candidate",
        platform: expectedPlatform,
        runAttempt,
        runId,
        workflowSha,
      })
    : null;
  const evidenceError = selection.evidenceError;
  if (
    evidenceError !== null &&
    (typeof evidenceError !== "string" || !VERSION_PATTERN.test(evidenceError))
  ) {
    throw new Error("managed runtime candidate evidence error is invalid");
  }
  const receiptArtifact = parseArtifactIdentity(
    artifacts.receipt,
    "managed runtime candidate receipt artifact",
  );
  const evidenceArtifact = parseArtifactIdentity(
    artifacts.evidence,
    "managed runtime candidate evidence artifact",
  );
  if (
    receiptArtifact &&
    receiptArtifact.name !== `managed-runtime-candidate-receipt-${runId}-${runAttempt}-${arch}`
  ) {
    throw new Error("managed runtime candidate receipt artifact name is invalid");
  }
  if (
    evidenceArtifact &&
    evidenceArtifact.name !== `managed-runtime-candidate-evidence-${runId}-${runAttempt}-${arch}`
  ) {
    throw new Error("managed runtime candidate evidence artifact name is invalid");
  }
  return {
    kind: SELECTION_KIND,
    pullRequest: positiveInteger(selection.pullRequest, "managed runtime selection pull request"),
    candidateSha,
    baseSha,
    platform: expectedPlatform,
    workflow: {
      id: positiveInteger(workflow.id, "managed runtime candidate selection workflow id"),
      path: BASE_WORKFLOW_PATH,
      sha: workflowSha,
    },
    run: { id: runId, attempt: runAttempt },
    source: { runId: sourceRunId, runAttempt: sourceRunAttempt },
    job: {
      id: positiveInteger(job.id, "managed runtime selection job id"),
      conclusion: stepOutcome(job.conclusion, "managed runtime selection job conclusion"),
    },
    evidenceError: evidenceError as string | null,
    receipt,
    artifacts: {
      receipt: receiptArtifact,
      evidence: evidenceArtifact,
    },
  };
}

async function readBaseArtifact(
  name: string,
  maxArchiveBytes: number | undefined,
  input: {
    readonly headSha: string;
    readonly runAttempt: number;
    readonly runId: number;
    readonly token: string;
  },
  request: (apiPath: string) => Promise<unknown>,
): Promise<BoundArtifactIdentity | null> {
  return bindOptionalArtifact(
    await request(
      `/repos/${REPOSITORY}/actions/runs/${input.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    ),
    {
      headSha: input.headSha,
      name,
      runAttempt: input.runAttempt,
      runId: input.runId,
      ...(maxArchiveBytes === undefined ? {} : { maxArchiveBytes }),
    },
  );
}

export async function classifyCurrentRun(
  candidate: ManagedRuntimeCandidateSelection,
  input: {
    readonly headSha: string;
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
  const request = options.request ?? ((apiPath: string) => githubRequest(apiPath, input.token));
  const download =
    options.downloadArtifact ??
    ((identity: BoundArtifactIdentity) => downloadBoundArtifact(identity, input.token));
  const workflowSha = sha(input.workflowSha, "workflow SHA");
  const arch = platformArch(candidate.platform);
  const jobs = record(
    await collectPaginated(
      request,
      `/repos/${REPOSITORY}/actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100`,
      "jobs",
    ),
    "qualification workflow jobs",
  );
  if (!Array.isArray(jobs.jobs)) throw new Error("qualification workflow job listing is invalid");
  const baseJobs = jobs.jobs
    .map((value) => record(value, "qualification workflow job"))
    .filter((job) => job.name === activationJob("base", candidate.platform));
  if (baseJobs.length !== 1) throw new Error("base managed runtime job is missing or ambiguous");
  const baseJob = baseJobs[0]!;
  exactString(baseJob.status, "completed", "base managed runtime job status");
  const baseJobConclusion = stepOutcome(baseJob.conclusion, "base managed runtime job conclusion");
  const receiptName = `managed-runtime-base-receipt-${input.runId}-${input.runAttempt}-${arch}`;
  const evidenceName = `managed-runtime-base-evidence-${input.runId}-${input.runAttempt}-${arch}`;
  let receiptIdentity: BoundArtifactIdentity | null = null;
  let evidenceIdentity: BoundArtifactIdentity | null = null;
  let receipt: ManagedRuntimeReceipt | null = null;
  let evidenceError: string | null = null;
  try {
    receiptIdentity = await readBaseArtifact(receiptName, undefined, input, request);
  } catch {
    evidenceError = "receipt metadata lookup failed";
  }
  try {
    evidenceIdentity = await readBaseArtifact(evidenceName, 128 * 1024 * 1024, input, request);
  } catch {
    evidenceError ??= "evidence metadata lookup failed";
  }
  if (receiptIdentity) {
    try {
      receipt = receiptFromArchive(await download(receiptIdentity), {
        baseSha: candidate.baseSha,
        candidateSha: candidate.candidateSha,
        candidateSourceRunAttempt: candidate.source.runAttempt,
        candidateSourceRunId: candidate.source.runId,
        role: "base",
        platform: candidate.platform,
        runAttempt: input.runAttempt,
        runId: input.runId,
        workflowSha,
      });
    } catch {
      evidenceError ??= "receipt download or validation failed";
    }
  }
  if (receipt && evidenceIdentity) {
    try {
      verifyEvidenceArchive(await download(evidenceIdentity), receipt);
    } catch {
      evidenceError ??= "evidence download or digest validation failed";
    }
  }
  return classifyManagedRuntimeComparison({
    baseArtifact: receiptIdentity ? artifactIdentity(receiptIdentity) : null,
    baseEvidenceError: evidenceError,
    baseEvidenceArtifact: evidenceIdentity ? artifactIdentity(evidenceIdentity) : null,
    baseJobConclusion,
    baseReceipt: receipt,
    baseRunAttempt: input.runAttempt,
    baseRunId: input.runId,
    candidate,
  });
}

function readManagedRuntimeComparison(target: string): ManagedRuntimeComparison {
  const comparison = record(
    JSON.parse(fs.readFileSync(target, "utf8")) as unknown,
    "managed runtime comparison",
  );
  exactString(comparison.kind, COMPARISON_KIND, "managed runtime comparison kind");
  if (
    comparison.classification !== "pass" &&
    comparison.classification !== "candidate-failure" &&
    comparison.classification !== "base-failure" &&
    comparison.classification !== "infrastructure-failure"
  ) {
    throw new Error("managed runtime comparison classification is invalid");
  }
  const scenario = record(comparison.scenario, "managed runtime comparison scenario");
  platform(scenario.platform, "managed runtime comparison platform");
  return comparison as unknown as ManagedRuntimeComparison;
}

function writeJsonExclusive(target: string, value: unknown): void {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { mode: 0o700, recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export function commitStatusForClassification(classification: ComparisonClassification): {
  readonly state: "error" | "failure" | "success";
  readonly description: string;
} {
  if (classification === "pass") {
    return {
      state: "success",
      description: "Candidate and exact-base scenarios passed",
    };
  }
  if (classification === "candidate-failure") {
    return {
      state: "failure",
      description: "Candidate failed after the exact base passed",
    };
  }
  if (classification === "base-failure") {
    return {
      state: "failure",
      description: "The identical exact-base scenario failed",
    };
  }
  return {
    state: "error",
    description: "Qualification evidence was incomplete or invalid",
  };
}

export function coordinationCommitStatus(state: "cancelled" | "error"): {
  readonly state: "error";
  readonly description: string;
} {
  if (state === "cancelled") {
    return {
      state: "error",
      description: "Qualification cancelled; use Re-run all jobs",
    };
  }
  return {
    state: "error",
    description: "Qualification evidence could not be classified",
  };
}

export async function publishManagedRuntimeCommitStatus(
  input: {
    readonly description: string;
    readonly runId: number;
    readonly sha: string;
    readonly state: "error" | "failure" | "success";
    readonly token: string;
  },
  request: typeof githubRequest = githubRequest,
): Promise<void> {
  const candidateSha = sha(input.sha, "candidate SHA");
  const runId = positiveInteger(input.runId, "qualification run id");
  if (!input.token || /[\r\n]/u.test(input.token)) throw new Error("GITHUB_TOKEN is invalid");
  if (!VERSION_PATTERN.test(input.description)) throw new Error("status description is invalid");
  await request(`/repos/${REPOSITORY}/statuses/${candidateSha}`, input.token, {
    method: "POST",
    body: {
      state: input.state,
      context: STATUS_CONTEXT,
      description: input.description,
      target_url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    },
  });
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv[0] === "record-mcp") {
    if (argv.length !== 2) throw new Error("expected one MCP discovery receipt path");
    writeJsonExclusive(
      argv[1],
      createManagedMcpDiscoveryReceipt({
        baseSha: env.BASE_SHA ?? "",
        candidateSha: env.CANDIDATE_SHA ?? "",
        candidateSourceRunAttempt: requiredInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT"),
        candidateSourceRunId: requiredInteger(env.SOURCE_RUN_ID, "SOURCE_RUN_ID"),
        catalogPath: env.MANAGED_MCP_CATALOG ?? "",
        controllerDigest: env.MANAGED_MCP_CONTROLLER_DIGEST ?? "",
        evidenceDirectory: env.MANAGED_MCP_EVIDENCE_DIRECTORY ?? "",
        job: env.MANAGED_MCP_JOB ?? "",
        openshellVersion: env.OPENSHELL_VERSION ?? "",
        outcome: stepOutcome(env.MANAGED_MCP_OUTCOME, "MANAGED_MCP_OUTCOME"),
        runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
        runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
        workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
      }),
    );
    return;
  }
  if (argv[0] === "verify-mcp") {
    if (argv.length !== 3) {
      throw new Error("expected MCP receipt path and evidence directory");
    }
    verifyCurrentMcpDiscovery(argv[1], argv[2], {
      baseSha: sha(env.BASE_SHA, "BASE_SHA"),
      candidateSha: sha(env.CANDIDATE_SHA, "CANDIDATE_SHA"),
      candidateSourceRunAttempt: requiredInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT"),
      candidateSourceRunId: requiredInteger(env.SOURCE_RUN_ID, "SOURCE_RUN_ID"),
      runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
      runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      workflowSha: sha(env.GITHUB_WORKFLOW_SHA, "GITHUB_WORKFLOW_SHA"),
    });
    return;
  }
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
        platform: platform(env.MANAGED_RUNTIME_PLATFORM, "MANAGED_RUNTIME_PLATFORM"),
        role:
          env.MANAGED_RUNTIME_ROLE === "base"
            ? "base"
            : env.MANAGED_RUNTIME_ROLE === "candidate"
              ? "candidate"
              : (() => {
                  throw new Error("MANAGED_RUNTIME_ROLE is invalid");
                })(),
        candidateSourceRunAttempt: requiredInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT"),
        candidateSourceRunId: requiredInteger(env.SOURCE_RUN_ID, "SOURCE_RUN_ID"),
        runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
        runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
        sourceSha: env.MANAGED_RUNTIME_SOURCE_SHA ?? "",
        workflowPath: env.MANAGED_RUNTIME_WORKFLOW_PATH ?? "",
        workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
      }),
    );
    return;
  }
  if (argv[0] === "select-source") {
    if (argv.length !== 2) throw new Error("expected one source selection path");
    const selection = await selectManagedRuntimeSource({
      baseSha: env.BASE_SHA ?? "",
      candidateSha: env.CANDIDATE_SHA ?? "",
      pullRequest: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
      runAttempt: requiredInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT"),
      runId: requiredInteger(env.SOURCE_RUN_ID, "SOURCE_RUN_ID"),
      token: env.GITHUB_TOKEN ?? "",
    });
    writeJsonExclusive(argv[1], selection);
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `candidate_sha=${selection.candidateSha}\nbase_sha=${selection.baseSha}\npr_number=${selection.pullRequest}\nsource_run_id=${selection.run.id}\nsource_run_attempt=${selection.run.attempt}\n`,
      "utf8",
    );
    return;
  }
  if (argv[0] === "select-candidate") {
    if (argv.length !== 2) throw new Error("expected one candidate selection path");
    const selection = await selectManagedRuntimeCandidate({
      baseSha: env.BASE_SHA ?? "",
      candidateSha: env.CANDIDATE_SHA ?? "",
      controllerHeadSha: env.GITHUB_SHA ?? "",
      platform: platform(env.MANAGED_RUNTIME_PLATFORM, "MANAGED_RUNTIME_PLATFORM"),
      pullRequest: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
      runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
      runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      sourceRunAttempt: requiredInteger(env.SOURCE_RUN_ATTEMPT, "SOURCE_RUN_ATTEMPT"),
      sourceRunId: requiredInteger(env.SOURCE_RUN_ID, "SOURCE_RUN_ID"),
      token: env.GITHUB_TOKEN ?? "",
      workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
    });
    writeJsonExclusive(argv[1], selection);
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `candidate_sha=${selection.candidateSha}\nbase_sha=${selection.baseSha}\ncandidate_outcome=${selection.job.conclusion}\ncandidate_ready=${selection.receipt && selection.artifacts.receipt && selection.artifacts.evidence ? "true" : "false"}\n`,
      "utf8",
    );
    return;
  }
  if (argv[0] === "classify") {
    if (argv.length !== 3) throw new Error("expected candidate selection and comparison paths");
    const comparison = await classifyCurrentRun(readCandidateSelection(argv[1]), {
      headSha: sha(env.GITHUB_SHA, "GITHUB_SHA"),
      runAttempt: requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
      runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      token: env.GITHUB_TOKEN ?? "",
      workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
    });
    writeJsonExclusive(argv[2], comparison);
    if (comparison.classification === "infrastructure-failure") process.exitCode = 2;
    if (comparison.classification === "base-failure") process.exitCode = 3;
    if (comparison.classification === "candidate-failure") process.exitCode = 4;
    return;
  }
  if (argv[0] === "combine") {
    if (argv.length !== 4) {
      throw new Error("expected amd64, arm64, and multiarch comparison paths");
    }
    const comparison = combineManagedRuntimeComparisons([
      readManagedRuntimeComparison(argv[1]),
      readManagedRuntimeComparison(argv[2]),
    ]);
    writeJsonExclusive(argv[3], comparison);
    if (comparison.classification === "infrastructure-failure") process.exitCode = 2;
    if (comparison.classification === "base-failure") process.exitCode = 3;
    if (comparison.classification === "candidate-failure") process.exitCode = 4;
    return;
  }
  if (argv[0] === "publish-status") {
    if (argv.length !== 2 && argv.length !== 3) {
      throw new Error("expected an error state or one comparison path");
    }
    const state = argv[1];
    let status: {
      state: "error" | "failure" | "success";
      description: string;
    };
    if ((state === "error" || state === "cancelled") && argv.length === 2) {
      status = coordinationCommitStatus(state);
    } else if (state === "result" && argv.length === 3) {
      const comparison = record(
        JSON.parse(fs.readFileSync(argv[2]!, "utf8")) as unknown,
        "managed runtime comparison",
      );
      if (
        comparison.classification !== "pass" &&
        comparison.classification !== "candidate-failure" &&
        comparison.classification !== "base-failure" &&
        comparison.classification !== "infrastructure-failure"
      ) {
        throw new Error("managed runtime comparison classification is invalid");
      }
      status = commitStatusForClassification(comparison.classification);
    } else {
      throw new Error("expected error, cancelled, or result with one comparison path");
    }
    await publishManagedRuntimeCommitStatus({
      ...status,
      runId: requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      sha: env.CANDIDATE_SHA ?? "",
      token: env.GITHUB_TOKEN ?? "",
    });
    return;
  }
  throw new Error(
    "expected classify, combine, publish-status, record, record-mcp, select-candidate, select-source, or verify-mcp",
  );
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
