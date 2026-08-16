#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import {
  listValidatedArtifactZipEntries,
  readValidatedArtifactZipEntry,
} from "../../scripts/scorecard/read-artifact-zip.mts";
import type { RetryEvidence, RetryFailureClass } from "../../test/e2e/fixtures/retry-policy.ts";
import {
  parseClassificationLine,
  TERMINAL_CLASSIFICATIONS,
  type TerminalClassification,
} from "./runner-pressure-core.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const CONTROLLER_WORKFLOW_PATH = ".github/workflows/e2e-main-retry.yaml";
const DISPLAY_TITLE_PREFIX = "E2E ";
const SHA = /^[a-f0-9]{40}$/u;
const MAX_RUNS = 50;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_RUN_ARTIFACT_BYTES = 8 * 1024 * 1024;

const RETRY_FAILURE_CLASSES: readonly RetryFailureClass[] = [
  "authentication",
  "authorization",
  "cleanup",
  "deterministic",
  "malformed-input",
  "policy-denial",
  "transient-external",
  "ambiguous-mutation",
];
const RELIABILITY_FAILURE_CLASSES = new Set<string>([
  ...RETRY_FAILURE_CLASSES,
  ...TERMINAL_CLASSIFICATIONS,
  "unclassified",
]);

export type ReliabilitySource = "manual-qualification" | "trusted-main";
export type ReliabilityOutcome =
  | "exhausted"
  | "failed-first-attempt"
  | "passed-after-retry"
  | "passed-first-attempt"
  | "superseded"
  | "unclassified";
export type ReliabilityFailureClass = RetryFailureClass | TerminalClassification | "unclassified";
export type EvidenceState = "complete" | "malformed" | "missing";

export interface ReliabilitySample {
  runId: number;
  runAttempt: number;
  candidateSha: string | null;
  source: ReliabilitySource | null;
  outcome: ReliabilityOutcome;
  failureClasses: ReliabilityFailureClass[];
  evidence: EvidenceState;
  failureClassEvidence: EvidenceState;
  url: string;
}

export interface ReliabilityGroup {
  candidateSha: string | null;
  source: ReliabilitySource;
  runs: number;
  passedFirstAttempt: number;
  passedAfterRetry: number;
  failedFirstAttempt: number;
  exhausted: number;
  superseded: number;
  unclassified: number;
  passFailFlips: number;
  firstPassRate: number;
  recoveryRate: number | null;
  failureClasses: Record<string, number>;
  evidence: Record<EvidenceState, number>;
  failureClassEvidence: Record<EvidenceState, number>;
}

type WorkflowRun = {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  event: string;
  path: string;
  display_title: string;
  head_branch: string;
  head_sha: string;
  html_url: string;
  repository: { full_name?: string };
  head_repository: { full_name?: string } | null;
};

type Artifact = {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  workflow_run?: { id?: number };
};

type ControllerRun = {
  id: number;
  status: string;
  event: string;
  path: string;
  head_branch: string;
  head_sha: string;
  html_url: string;
  repository: { full_name?: string };
  head_repository: { full_name?: string } | null;
};

type JsonRequest = (path: string) => Promise<unknown>;
type ArchiveRequest = (artifactId: number, maxBytes: number) => Promise<Buffer>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function fixedRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function validateRun(value: unknown): WorkflowRun | null {
  const run = record(value);
  const repository = record(run?.repository);
  const headRepository = record(run?.head_repository);
  if (
    !run ||
    !positiveInteger(run.id) ||
    !positiveInteger(run.run_attempt) ||
    run.status !== "completed" ||
    typeof run.conclusion !== "string" ||
    (run.event !== "push" && run.event !== "workflow_dispatch") ||
    run.path !== WORKFLOW_PATH ||
    typeof run.display_title !== "string" ||
    !run.display_title.startsWith(DISPLAY_TITLE_PREFIX) ||
    run.head_branch !== "main" ||
    typeof run.head_sha !== "string" ||
    !SHA.test(run.head_sha) ||
    repository?.full_name !== REPOSITORY ||
    headRepository?.full_name !== REPOSITORY ||
    run.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${run.id}`
  ) {
    return null;
  }
  return run as unknown as WorkflowRun;
}

function validateControllerRun(value: unknown, expectedId: number): ControllerRun | null {
  const run = record(value);
  const repository = record(run?.repository);
  const headRepository = record(run?.head_repository);
  if (
    !run ||
    run.id !== expectedId ||
    (run.status !== "in_progress" && run.status !== "completed") ||
    run.event !== "workflow_run" ||
    run.path !== CONTROLLER_WORKFLOW_PATH ||
    run.head_branch !== "main" ||
    typeof run.head_sha !== "string" ||
    !SHA.test(run.head_sha) ||
    repository?.full_name !== REPOSITORY ||
    headRepository?.full_name !== REPOSITORY ||
    run.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${run.id}`
  ) {
    return null;
  }
  return run as unknown as ControllerRun;
}

function validateArtifacts(value: unknown): Artifact[] | null {
  const response = record(value);
  if (!response || !Array.isArray(response.artifacts) || response.artifacts.length > 100)
    return null;
  const artifacts: Artifact[] = [];
  for (const value of response.artifacts) {
    const artifact = record(value);
    if (
      !artifact ||
      !positiveInteger(artifact.id) ||
      typeof artifact.name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,256}$/u.test(artifact.name) ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      (artifact.size_in_bytes as number) < 0 ||
      typeof artifact.expired !== "boolean"
    ) {
      return null;
    }
    artifacts.push(artifact as unknown as Artifact);
  }
  return artifacts;
}

function parseDispatchReceipt(text: string | null, run: WorkflowRun): string | null {
  if (text === null || Buffer.byteLength(text) > 16_384) return null;
  try {
    const receipt = record(JSON.parse(text));
    if (
      receipt?.kind !== "nemoclaw-e2e-dispatch-v2" ||
      receipt.repository !== REPOSITORY ||
      receipt.eventName !== "workflow_dispatch" ||
      String(receipt.workflowRunId) !== String(run.id) ||
      receipt.workflowRunAttempt !== run.run_attempt ||
      typeof receipt.candidateSha !== "string" ||
      !SHA.test(receipt.candidateSha)
    ) {
      return null;
    }
    return receipt.candidateSha;
  } catch {
    return null;
  }
}

function parseTerminalEvidenceManifest(
  text: string | null,
  run: WorkflowRun,
  candidateSha: string,
): "cancelled" | "failure" | "success" | null {
  if (text === null || Buffer.byteLength(text) > 16_384) return null;
  try {
    const manifest = record(JSON.parse(text));
    const candidate = record(manifest?.candidate);
    const workflow = record(manifest?.workflow);
    const jobStatus = workflow?.jobStatus;
    const valid =
      manifest?.kind === "nemoclaw-e2e-evidence-v1" &&
      typeof manifest.targetId === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.targetId) &&
      candidate?.repository !== undefined &&
      typeof candidate.repository === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate.repository) &&
      candidate.sha === candidateSha &&
      workflow?.repository === REPOSITORY &&
      workflow.sha === run.head_sha &&
      workflow.runId === String(run.id) &&
      workflow.runAttempt === String(run.run_attempt) &&
      (jobStatus === "cancelled" || jobStatus === "failure" || jobStatus === "success") &&
      typeof manifest.artifactDirectory === "string" &&
      /^e2e-artifacts\/live\/[a-z0-9]+(?:[_-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[_-][a-z0-9]+)*)?$/u.test(
        manifest.artifactDirectory,
      ) &&
      Number.isSafeInteger(manifest.productEvidenceFileCount) &&
      (manifest.productEvidenceFileCount as number) >= (jobStatus === "success" ? 1 : 0);
    if (!valid) return null;
    return jobStatus as "cancelled" | "failure" | "success";
  } catch {
    return null;
  }
}

function parseRetryEvidence(value: unknown): RetryEvidence | null {
  const evidence = record(value);
  if (
    evidence?.schemaVersion !== 1 ||
    typeof evidence.operation !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(evidence.operation) ||
    typeof evidence.owner !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(evidence.owner) ||
    !["read-only", "idempotent", "reconciled-mutation"].includes(String(evidence.idempotence)) ||
    !positiveInteger(evidence.maxAttempts) ||
    (evidence.maxAttempts as number) > 10 ||
    !["failed-no-retry", "exhausted", "passed-after-retry", "passed-first-attempt"].includes(
      String(evidence.outcome),
    ) ||
    !Array.isArray(evidence.attempts) ||
    evidence.attempts.length < 1 ||
    evidence.attempts.length > (evidence.maxAttempts as number)
  ) {
    return null;
  }
  for (let index = 0; index < evidence.attempts.length; index += 1) {
    const attempt = record(evidence.attempts[index]);
    if (
      attempt?.attempt !== index + 1 ||
      (attempt.outcome !== "failed" && attempt.outcome !== "passed") ||
      typeof attempt.retryScheduled !== "boolean" ||
      (attempt.failureClass !== undefined &&
        !RETRY_FAILURE_CLASSES.includes(attempt.failureClass as RetryFailureClass))
    ) {
      return null;
    }
  }
  return evidence as unknown as RetryEvidence;
}

function parseMainRetryEvidence(
  value: unknown,
  run: WorkflowRun,
): { valid: boolean; outcome: ReliabilityOutcome } {
  const evidence = record(value);
  if (
    evidence?.schemaVersion !== 1 ||
    evidence.sourceRunId !== run.id ||
    evidence.sourceSha !== run.head_sha ||
    evidence.sourceAttempt !== run.run_attempt ||
    !["failed-no-retry", "ignored", "passed-after-retry", "passed-first-attempt"].includes(
      String(evidence.action),
    ) ||
    typeof evidence.reason !== "string"
  ) {
    return { valid: false, outcome: "unclassified" };
  }
  if (evidence.action === "ignored" && evidence.reason === "a newer E2E main push exists") {
    return { valid: true, outcome: "superseded" };
  }
  if (evidence.action === "passed-first-attempt") {
    return { valid: true, outcome: "passed-first-attempt" };
  }
  if (evidence.action === "passed-after-retry") {
    return { valid: true, outcome: "passed-after-retry" };
  }
  if (evidence.action === "failed-no-retry") {
    return {
      valid: true,
      outcome: run.run_attempt === 1 ? "failed-first-attempt" : "exhausted",
    };
  }
  return { valid: true, outcome: "unclassified" };
}

async function readArtifactEntry(
  artifact: Artifact,
  entry: string,
  requestArchive: ArchiveRequest,
): Promise<string | null> {
  if (artifact.expired || artifact.size_in_bytes > MAX_ARTIFACT_BYTES) return null;
  const archive = await requestArchive(artifact.id, MAX_ARTIFACT_BYTES);
  return readValidatedArtifactZipEntry(archive, entry, { maxBytes: 64 * 1024 });
}

async function identifyCandidateSha(
  value: unknown,
  services: { requestJson: JsonRequest; requestArchive: ArchiveRequest },
): Promise<string | null> {
  const run = validateRun(value);
  if (run === null) return null;
  if (run.event === "push") return run.head_sha;
  const artifacts = validateArtifacts(
    await services.requestJson(`repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100`),
  );
  const receipt = artifacts?.find(
    (artifact) => artifact.name === `e2e-dispatch-${run.id}-${run.run_attempt}`,
  );
  return receipt
    ? parseDispatchReceipt(
        await readArtifactEntry(receipt, "dispatch.json", services.requestArchive),
        run,
      )
    : null;
}

async function collectRunEvidence(
  artifacts: Artifact[],
  run: WorkflowRun,
  candidateSha: string | null,
  requestArchive: ArchiveRequest,
): Promise<{
  classes: ReliabilityFailureClass[];
  failureClassEvidence: EvidenceState;
  terminalEvidence: EvidenceState;
}> {
  const classes = new Set<ReliabilityFailureClass>();
  let failureClassMalformed = false;
  let failureClassRecords = 0;
  let terminalMalformed = false;
  let terminalRecords = 0;
  let bytes = 0;
  for (const artifact of artifacts.filter((item) => item.name.startsWith("e2e-"))) {
    if (artifact.expired || artifact.size_in_bytes > MAX_ARTIFACT_BYTES) continue;
    bytes += artifact.size_in_bytes;
    if (bytes > MAX_RUN_ARTIFACT_BYTES) {
      terminalMalformed = true;
      failureClassMalformed = true;
      break;
    }
    const archive = await requestArchive(artifact.id, MAX_ARTIFACT_BYTES);
    const entries = listValidatedArtifactZipEntries(archive, {
      maxEntries: 1000,
    });
    if (entries === null) {
      terminalMalformed = true;
      failureClassMalformed = true;
      continue;
    }
    for (const entry of entries.filter(
      (name) => name.endsWith("/evidence-manifest.json") || name === "evidence-manifest.json",
    )) {
      const text = readValidatedArtifactZipEntry(archive, entry, {
        maxBytes: 16_384,
      });
      const jobStatus =
        candidateSha === null ? null : parseTerminalEvidenceManifest(text, run, candidateSha);
      if (jobStatus === null) {
        terminalMalformed = true;
      } else if (jobStatus === run.conclusion) {
        terminalRecords += 1;
      }
    }
    for (const entry of entries.filter(
      (name) =>
        name.endsWith("/runner-pressure-classification.jsonl") ||
        (name.includes("/retry/") && name.endsWith(".json")),
    )) {
      const text = readValidatedArtifactZipEntry(archive, entry, {
        maxBytes: 64 * 1024,
      });
      if (text === null) {
        failureClassMalformed = true;
        continue;
      }
      try {
        if (entry.endsWith("/runner-pressure-classification.jsonl")) {
          classes.add(parseClassificationLine(text).classification);
          failureClassRecords += 1;
        } else {
          const evidence = parseRetryEvidence(JSON.parse(text));
          if (evidence === null) {
            failureClassMalformed = true;
            continue;
          }
          failureClassRecords += 1;
          for (const attempt of evidence.attempts) {
            if (attempt.failureClass) classes.add(attempt.failureClass);
          }
        }
      } catch {
        failureClassMalformed = true;
      }
    }
  }
  return {
    classes: [...classes].sort(),
    failureClassEvidence: failureClassMalformed
      ? "malformed"
      : failureClassRecords > 0
        ? "complete"
        : "missing",
    terminalEvidence: terminalMalformed
      ? "malformed"
      : terminalRecords > 0
        ? "complete"
        : "missing",
  };
}

async function trustedMainRetryArtifact(
  artifacts: Artifact[] | null,
  expectedName: string,
  requestJson: JsonRequest,
): Promise<{
  artifact: Artifact | null;
  evidence: "complete" | "malformed" | "missing";
}> {
  if (artifacts === null) return { artifact: null, evidence: "malformed" };
  const matches = artifacts.filter((artifact) => artifact.name === expectedName);
  if (matches.length === 0) return { artifact: null, evidence: "missing" };
  if (matches.length !== 1) return { artifact: null, evidence: "malformed" };
  const artifact = matches[0]!;
  const controllerId = record(artifact.workflow_run)?.id;
  if (!positiveInteger(controllerId)) return { artifact: null, evidence: "malformed" };
  try {
    const controller = await requestJson(`repos/${REPOSITORY}/actions/runs/${controllerId}`);
    if (validateControllerRun(controller, controllerId) === null) {
      return { artifact: null, evidence: "malformed" };
    }
  } catch {
    return { artifact: null, evidence: "malformed" };
  }
  return { artifact, evidence: "complete" };
}

function deriveOutcome(run: WorkflowRun): ReliabilityOutcome {
  if (run.conclusion === "success") {
    return run.run_attempt === 1 ? "passed-first-attempt" : "passed-after-retry";
  }
  if (run.conclusion === "failure") {
    return run.run_attempt === 1 ? "failed-first-attempt" : "exhausted";
  }
  return "unclassified";
}

export async function normalizeReliabilityRun(
  value: unknown,
  services: { requestJson: JsonRequest; requestArchive: ArchiveRequest },
): Promise<ReliabilitySample | null> {
  const run = validateRun(value);
  if (run === null) return null;
  const artifacts = validateArtifacts(
    await services.requestJson(`repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100`),
  );
  if (artifacts === null) {
    return {
      runId: run.id,
      runAttempt: run.run_attempt,
      candidateSha: run.event === "push" ? run.head_sha : null,
      source: run.event === "push" ? "trusted-main" : "manual-qualification",
      outcome: "unclassified",
      failureClasses: ["unclassified"],
      evidence: "malformed",
      failureClassEvidence: "malformed",
      url: run.html_url,
    };
  }
  let candidateSha: string | null = run.head_sha;
  let evidence: ReliabilitySample["evidence"] = "complete";
  if (run.event === "workflow_dispatch") {
    const receiptArtifact = artifacts.find(
      (artifact) => artifact.name === `e2e-dispatch-${run.id}-${run.run_attempt}`,
    );
    candidateSha = receiptArtifact
      ? parseDispatchReceipt(
          await readArtifactEntry(receiptArtifact, "dispatch.json", services.requestArchive),
          run,
        )
      : null;
    if (candidateSha === null) evidence = receiptArtifact ? "malformed" : "missing";
  }
  let outcome = candidateSha === null ? "unclassified" : deriveOutcome(run);
  if (run.event === "push") {
    const response = record(
      await services.requestJson(
        `repos/${REPOSITORY}/actions/artifacts?name=e2e-main-retry-${run.id}-${run.run_attempt}&per_page=100`,
      ),
    );
    const retryArtifacts = validateArtifacts(response);
    const selected = await trustedMainRetryArtifact(
      retryArtifacts,
      `e2e-main-retry-${run.id}-${run.run_attempt}`,
      services.requestJson,
    );
    if (!selected.artifact) {
      evidence = selected.evidence;
      outcome = "unclassified";
    } else {
      const text = await readArtifactEntry(
        selected.artifact,
        "e2e-main-retry-evidence.json",
        services.requestArchive,
      );
      try {
        const parsed =
          text === null
            ? { valid: false, outcome: "unclassified" as const }
            : parseMainRetryEvidence(JSON.parse(text), run);
        outcome = parsed.outcome;
        if (!parsed.valid) evidence = "malformed";
      } catch {
        evidence = "malformed";
        outcome = "unclassified";
      }
    }
  }
  const collected = await collectRunEvidence(artifacts, run, candidateSha, services.requestArchive);
  if (run.event === "workflow_dispatch" && candidateSha !== null) {
    evidence = collected.terminalEvidence;
    if (evidence !== "complete") outcome = "unclassified";
  }
  const failed = outcome === "exhausted" || outcome === "failed-first-attempt";
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    candidateSha,
    source: run.event === "push" ? "trusted-main" : "manual-qualification",
    outcome,
    failureClasses: failed && collected.classes.length === 0 ? ["unclassified"] : collected.classes,
    evidence,
    failureClassEvidence: collected.failureClassEvidence,
    url: run.html_url,
  };
}

function passState(outcome: ReliabilityOutcome): boolean | null {
  if (outcome === "passed-first-attempt" || outcome === "passed-after-retry") return true;
  if (outcome === "failed-first-attempt" || outcome === "exhausted") return false;
  return null;
}

export function summarizeReliability(samples: readonly ReliabilitySample[]): ReliabilityGroup[] {
  const grouped = new Map<string, ReliabilitySample[]>();
  for (const sample of samples) {
    if (!sample.source) continue;
    const key = `${sample.source}:${sample.candidateSha ?? `unknown-run-${sample.runId}`}`;
    grouped.set(key, [...(grouped.get(key) ?? []), sample]);
  }
  return [...grouped.values()]
    .map((values) => {
      const ordered = [...values].sort((a, b) => a.runId - b.runId || a.runAttempt - b.runAttempt);
      const count = (outcome: ReliabilityOutcome) =>
        ordered.filter((sample) => sample.outcome === outcome).length;
      const first = count("passed-first-attempt");
      const recovered = count("passed-after-retry");
      const exhausted = count("exhausted");
      const failedFirst = count("failed-first-attempt");
      const states = ordered
        .map((sample) => passState(sample.outcome))
        .filter((state) => state !== null);
      let flips = 0;
      for (let index = 1; index < states.length; index += 1) {
        if (states[index] !== states[index - 1]) flips += 1;
      }
      const classes: Record<string, number> = {};
      for (const sample of ordered) {
        for (const failureClass of sample.failureClasses) {
          if (!RELIABILITY_FAILURE_CLASSES.has(failureClass)) continue;
          classes[failureClass] = (classes[failureClass] ?? 0) + 1;
        }
      }
      const evidence = { complete: 0, malformed: 0, missing: 0 };
      const failureClassEvidence = { complete: 0, malformed: 0, missing: 0 };
      for (const sample of ordered) {
        evidence[sample.evidence] += 1;
        failureClassEvidence[sample.failureClassEvidence] += 1;
      }
      return {
        candidateSha: ordered[0]!.candidateSha,
        source: ordered[0]!.source!,
        runs: ordered.length,
        passedFirstAttempt: first,
        passedAfterRetry: recovered,
        failedFirstAttempt: failedFirst,
        exhausted,
        superseded: count("superseded"),
        unclassified: count("unclassified"),
        passFailFlips: flips,
        firstPassRate: fixedRate(first, first + recovered + failedFirst + exhausted),
        recoveryRate:
          recovered + exhausted === 0 ? null : fixedRate(recovered, recovered + exhausted),
        failureClasses: classes,
        evidence,
        failureClassEvidence,
      };
    })
    .sort((a, b) => {
      const sourceOrder = a.source.localeCompare(b.source);
      if (sourceOrder !== 0) return sourceOrder;
      return (a.candidateSha ?? "").localeCompare(b.candidateSha ?? "");
    });
}

export function formatReliabilityReport(groups: readonly ReliabilityGroup[]): string {
  const lines = [
    "## Same-commit E2E reliability",
    "",
    "Advisory history only; it does not change required checks, release conclusions, or rerun decisions.",
    "",
  ];
  if (groups.length === 0)
    return [...lines, "No authenticated same-commit history is available."].join("\n");
  lines.push(
    "| Source | Commit | Runs | First pass | After retry | Exhausted | Failed first | Superseded | Unclassified | Flips | First-pass rate | Recovery rate | Failure classes | Outcome evidence | Failure-class evidence |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
  );
  for (const group of groups) {
    const classes = Object.entries(group.failureClasses)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}: ${count}`)
      .join(", ");
    lines.push(
      `| ${group.source} | ${group.candidateSha ? `\`${group.candidateSha.slice(0, 12)}\`` : "unclassified"} | ${group.runs} | ${group.passedFirstAttempt} | ${group.passedAfterRetry} | ${group.exhausted} | ${group.failedFirstAttempt} | ${group.superseded} | ${group.unclassified} | ${group.passFailFlips} | ${(group.firstPassRate * 100).toFixed(1)}% | ${group.recoveryRate === null ? "n/a" : `${(group.recoveryRate * 100).toFixed(1)}%`} | ${classes || "none"} | ${formatEvidenceCounts(group.evidence)} | ${formatEvidenceCounts(group.failureClassEvidence)} |`,
    );
  }
  return lines.join("\n");
}

function formatEvidenceCounts(counts: Record<EvidenceState, number>): string {
  return `complete: ${counts.complete}, malformed: ${counts.malformed}, missing: ${counts.missing}`;
}

async function githubJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}`);
  return response.json();
}

async function githubArchive(artifactId: number, maxBytes: number, token: string): Promise<Buffer> {
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifactId}/zip`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub artifact ${artifactId} failed with ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes)
    throw new Error("GitHub artifact exceeds bound");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("GitHub artifact exceeds bound");
  return bytes;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const currentRunId = Number(requiredEnvironment("SOURCE_RUN_ID"));
  if (!positiveInteger(currentRunId)) throw new Error("SOURCE_RUN_ID must be a positive integer");
  const requestJson = (path: string) => githubJson(path, token);
  const requestArchive = (artifactId: number, maxBytes: number) =>
    githubArchive(artifactId, maxBytes, token);
  const response = record(
    await requestJson(
      `repos/${REPOSITORY}/actions/workflows/e2e.yaml/runs?status=completed&per_page=${MAX_RUNS}`,
    ),
  );
  if (!response || !Array.isArray(response.workflow_runs)) {
    throw new Error("GitHub returned no E2E workflow run history");
  }
  const current = response.workflow_runs.find((run) => record(run)?.id === currentRunId);
  const currentSample = await normalizeReliabilityRun(current, {
    requestJson,
    requestArchive,
  });
  const samples: ReliabilitySample[] = [];
  for (const run of response.workflow_runs) {
    if (!currentSample?.candidateSha) break;
    const candidateSha = await identifyCandidateSha(run, {
      requestJson,
      requestArchive,
    });
    if (candidateSha !== currentSample.candidateSha) continue;
    const sample = await normalizeReliabilityRun(run, {
      requestJson,
      requestArchive,
    });
    if (sample && sample.candidateSha === currentSample.candidateSha) {
      samples.push(sample);
    }
  }
  if (currentSample && !samples.some((sample) => sample.runId === currentSample.runId)) {
    samples.push(currentSample);
  }
  const groups = summarizeReliability(samples);
  const report = {
    schemaVersion: 1,
    currentRunId,
    candidateSha: currentSample?.candidateSha ?? null,
    groups,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`${formatReliabilityReport(groups)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
