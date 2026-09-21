// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readValidatedArtifactZipEntries } from "../../scripts/lib/read-artifact-zip.mts";
import {
  type CoordinatorDecision,
  type CoordinatorSnapshot,
  decideReviewAction,
  parseCoordinatorSnapshot,
} from "./decision.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const SOURCE_WORKFLOW_PATH = ".github/workflows/pr-review-advisor.yaml";
const SAMPLE_ARTIFACT_NAME = "pr-review-coordinator-shadow-sample";
const SAMPLE_FILE = "sample.json";
const SAMPLE_LIMIT = 5;
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const USER_AGENT = "nemoclaw-review-coordinator-shadow-sample";

type JsonRecord = Record<string, unknown>;

export type CoordinatorShadowResult = Readonly<{
  mode: "read-only-shadow";
  snapshot: CoordinatorSnapshot;
  decision: CoordinatorDecision;
}>;

export type CoordinatorShadowSample = Readonly<{
  version: 1;
  ordinal: number;
  sourceRun: Readonly<{
    id: number;
    attempt: number;
    createdAt: string;
  }>;
  result: CoordinatorShadowResult;
}>;

type SourceRun = Readonly<{
  id: number;
  attempt: number;
  createdAt: string;
}>;

type Artifact = Readonly<{
  archivePath: string;
  digest: string;
  id: number;
  size: number;
  workflowRunId: number;
}>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical GitHub timestamp`);
  }
  return value;
}

export function parseCoordinatorShadowResult(value: unknown): CoordinatorShadowResult {
  const root = record(value, "coordinator shadow result");
  if (root.mode !== "read-only-shadow") {
    throw new Error("coordinator shadow result must remain read-only");
  }
  const snapshot = parseCoordinatorSnapshot(root.snapshot);
  const expectedDecision = decideReviewAction(snapshot);
  const decision = record(root.decision, "coordinator shadow decision");
  if (JSON.stringify(decision) !== JSON.stringify(expectedDecision)) {
    throw new Error("coordinator shadow decision does not match its validated snapshot");
  }
  return {
    mode: "read-only-shadow",
    snapshot,
    decision: expectedDecision,
  };
}

export function parseCoordinatorShadowSample(value: unknown): CoordinatorShadowSample {
  const root = record(value, "coordinator shadow sample");
  if (root.version !== 1) throw new Error("unsupported coordinator shadow sample version");
  const ordinal = positiveInteger(root.ordinal, "coordinator shadow sample ordinal");
  if (ordinal > SAMPLE_LIMIT)
    throw new Error("coordinator shadow sample ordinal exceeds its limit");
  const source = record(root.sourceRun, "coordinator shadow sample source run");
  return {
    version: 1,
    ordinal,
    sourceRun: {
      id: positiveInteger(source.id, "coordinator shadow sample source run id"),
      attempt: positiveInteger(source.attempt, "coordinator shadow sample source run attempt"),
      createdAt: timestamp(source.createdAt, "coordinator shadow sample source run creation"),
    },
    result: parseCoordinatorShadowResult(root.result),
  };
}

export function selectCoordinatorShadowSample(
  result: CoordinatorShadowResult,
  existing: readonly CoordinatorShadowSample[],
  sourceRun: SourceRun,
): CoordinatorShadowSample | null {
  const parsed = parseCoordinatorShadowResult(result);
  const ordered = existing.map(parseCoordinatorShadowSample).sort((left, right) => {
    return left.ordinal - right.ordinal;
  });
  const seenPullRequests = new Set<number>();
  for (const [index, sample] of ordered.entries()) {
    if (sample.ordinal !== index + 1) {
      throw new Error("coordinator shadow samples must have contiguous ordinals");
    }
    const prNumber = sample.result.snapshot.pullRequest.number;
    if (seenPullRequests.has(prNumber)) {
      throw new Error("coordinator shadow samples must describe distinct pull requests");
    }
    seenPullRequests.add(prNumber);
  }
  if (seenPullRequests.has(parsed.snapshot.pullRequest.number) || ordered.length >= SAMPLE_LIMIT) {
    return null;
  }
  return {
    version: 1,
    ordinal: ordered.length + 1,
    sourceRun: {
      id: positiveInteger(sourceRun.id, "source run id"),
      attempt: positiveInteger(sourceRun.attempt, "source run attempt"),
      createdAt: timestamp(sourceRun.createdAt, "source run creation"),
    },
    result: parsed,
  };
}

function token(): string {
  const value = process.env.GITHUB_TOKEN;
  if (!value || value.includes("\r") || value.includes("\n")) {
    throw new Error("coordinator shadow sample requires a GitHub token");
  }
  return value;
}

function sourceRunId(): number {
  const value = process.env.SOURCE_RUN_ID;
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("coordinator shadow sample requires a positive SOURCE_RUN_ID");
  }
  return positiveInteger(Number(value), "source run id");
}

async function githubJson(apiPath: string, githubToken: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${apiPath} failed with HTTP ${response.status}`);
  }
  return response.json();
}

function parseEligibleSourceRun(value: unknown, expectedId: number): SourceRun | null {
  const run = record(value, "source workflow run");
  const repository = record(run.repository, "source workflow repository");
  const headRepository = record(run.head_repository, "source workflow head repository");
  const id = positiveInteger(run.id, "source workflow run id");
  const attempt = positiveInteger(run.run_attempt, "source workflow run attempt");
  const createdAt = timestamp(run.created_at, "source workflow run creation");
  if (
    id !== expectedId ||
    run.path !== SOURCE_WORKFLOW_PATH ||
    run.event !== "workflow_run" ||
    run.status !== "completed" ||
    (run.conclusion !== "success" && run.conclusion !== "failure") ||
    run.head_branch !== "main" ||
    repository.full_name !== REPOSITORY ||
    headRepository.full_name !== REPOSITORY
  ) {
    return null;
  }
  return { id, attempt, createdAt };
}

function parseArtifactList(value: unknown, expectedName: string): Artifact[] {
  const root = record(value, "artifact listing");
  if (!Number.isSafeInteger(root.total_count) || Number(root.total_count) < 0) {
    throw new Error("artifact listing total must be a non-negative integer");
  }
  if (!Array.isArray(root.artifacts) || root.artifacts.length > SAMPLE_LIMIT) {
    throw new Error("artifact listing exceeds the shadow sample bound");
  }
  if (root.total_count !== root.artifacts.length) {
    throw new Error("artifact listing is incomplete");
  }
  return root.artifacts.map((value, index) => {
    const artifact = record(value, `artifact ${index + 1}`);
    const workflowRun = record(artifact.workflow_run, `artifact ${index + 1} workflow run`);
    const id = positiveInteger(artifact.id, `artifact ${index + 1} id`);
    const size = positiveInteger(artifact.size_in_bytes, `artifact ${index + 1} size`);
    if (
      artifact.name !== expectedName ||
      artifact.expired !== false ||
      size > MAX_ARCHIVE_BYTES ||
      typeof artifact.digest !== "string" ||
      !SHA256_PATTERN.test(artifact.digest)
    ) {
      throw new Error(`artifact ${index + 1} identity is invalid`);
    }
    const archivePath = `/repos/${REPOSITORY}/actions/artifacts/${id}/zip`;
    const archiveUrl = new URL(String(artifact.archive_download_url));
    if (archiveUrl.origin !== "https://api.github.com" || archiveUrl.pathname !== archivePath) {
      throw new Error(`artifact ${index + 1} archive URL is invalid`);
    }
    return {
      archivePath,
      digest: artifact.digest,
      id,
      size,
      workflowRunId: positiveInteger(workflowRun.id, `artifact ${index + 1} workflow run id`),
    };
  });
}

async function listArtifacts(
  apiPath: string,
  expectedName: string,
  githubToken: string,
): Promise<Artifact[]> {
  return parseArtifactList(await githubJson(apiPath, githubToken), expectedName);
}

async function downloadArtifact(artifact: Artifact, githubToken: string): Promise<Buffer> {
  const response = await fetch(`https://api.github.com${artifact.archivePath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`artifact ${artifact.id} download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== artifact.size || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`artifact ${artifact.id} download size is invalid`);
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== artifact.digest) {
    throw new Error(`artifact ${artifact.id} download digest is invalid`);
  }
  return bytes;
}

async function readArtifactJson(
  artifact: Artifact,
  fileName: string,
  githubToken: string,
): Promise<unknown> {
  const entries = readValidatedArtifactZipEntries(await downloadArtifact(artifact, githubToken), {
    maxEntries: 1,
    maxTotalUncompressedBytes: MAX_JSON_BYTES,
  });
  if (entries?.length !== 1 || entries[0]?.name !== fileName) {
    throw new Error(`artifact ${artifact.id} must contain exactly one ${fileName}`);
  }
  return JSON.parse(entries[0].bytes.toString("utf8"));
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output) fs.appendFileSync(output, `${name}=${value}\n`);
}

function appendSummary(lines: readonly string[]): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const githubToken = token();
  const expectedSourceRunId = sourceRunId();
  const source = parseEligibleSourceRun(
    await githubJson(`repos/${REPOSITORY}/actions/runs/${expectedSourceRunId}`, githubToken),
    expectedSourceRunId,
  );
  if (!source) {
    appendOutput("sampled", "false");
    appendSummary(["## Coordinator shadow sample", "", "Ignored an ineligible Advisor run."]);
    return;
  }
  const sourceArtifactName = `pr-review-coordinator-shadow-${source.attempt}`;
  const sourceArtifacts = await listArtifacts(
    `repos/${REPOSITORY}/actions/runs/${source.id}/artifacts?name=${sourceArtifactName}&per_page=5`,
    sourceArtifactName,
    githubToken,
  );
  if (sourceArtifacts.length === 0) {
    appendOutput("sampled", "false");
    appendSummary(["## Coordinator shadow sample", "", "This Advisor run has no shadow decision."]);
    return;
  }
  if (sourceArtifacts.length !== 1 || sourceArtifacts[0]!.workflowRunId !== source.id) {
    throw new Error("source Advisor run has an ambiguous shadow decision artifact");
  }
  const result = parseCoordinatorShadowResult(
    await readArtifactJson(sourceArtifacts[0]!, "decision.json", githubToken),
  );
  const existingArtifacts = await listArtifacts(
    `repos/${REPOSITORY}/actions/artifacts?name=${SAMPLE_ARTIFACT_NAME}&per_page=5`,
    SAMPLE_ARTIFACT_NAME,
    githubToken,
  );
  const existing: CoordinatorShadowSample[] = [];
  for (const artifact of existingArtifacts) {
    existing.push(
      parseCoordinatorShadowSample(await readArtifactJson(artifact, SAMPLE_FILE, githubToken)),
    );
  }
  const sample = selectCoordinatorShadowSample(result, existing, source);
  if (!sample) {
    appendOutput("sampled", "false");
    appendSummary([
      "## Coordinator shadow sample",
      "",
      existing.length >= SAMPLE_LIMIT
        ? "The five-PR shadow sample is complete."
        : `PR #${result.snapshot.pullRequest.number} is already in the shadow sample.`,
    ]);
    return;
  }
  const outputDirectory = path.resolve("artifacts/pr-review-coordinator-shadow-sample");
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, SAMPLE_FILE),
    `${JSON.stringify(sample, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  appendOutput("sampled", "true");
  appendOutput("ordinal", String(sample.ordinal));
  appendOutput("pr_number", String(sample.result.snapshot.pullRequest.number));
  appendSummary([
    "## Coordinator shadow sample",
    "",
    `Captured PR #${sample.result.snapshot.pullRequest.number} as sample ${sample.ordinal} of ${SAMPLE_LIMIT}.`,
    "",
    `Decision: \`${sample.result.decision.action}\``,
    "",
    "The sample workflow is read-only and does not post reviews or comments.",
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(
      `::error title=Coordinator shadow sample failed::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
