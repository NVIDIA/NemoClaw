// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripVTControlCharacters } from "node:util";

type SanitizationModule = typeof import("../../src/lib/readiness/sanitize.ts");

const loadedSanitization = (await import("../../src/lib/readiness/sanitize.ts")) as unknown as {
  default?: SanitizationModule;
  sanitizeReadinessText?: SanitizationModule["sanitizeReadinessText"];
};
function resolveSanitizeText(): SanitizationModule["sanitizeReadinessText"] {
  const candidate =
    loadedSanitization.sanitizeReadinessText ?? loadedSanitization.default?.sanitizeReadinessText;
  if (candidate === undefined) throw new Error("shared diagnostic sanitizer is unavailable");
  return candidate;
}
const sanitizeText = resolveSanitizeText();

export type UnitGapClass = "deterministic" | "external" | "harness" | "needs-triage";

export interface E2ERunRecord {
  attempt: number;
  conclusion: string;
  createdAt: string;
  databaseId: number;
  event: string;
  headBranch: string;
  headSha: string;
  name: string;
  status: string;
  url: string;
}

export interface RunLogEvidence {
  error?: string;
  log?: string;
  run: E2ERunRecord;
}

export interface UnitGapGroup {
  classification: UnitGapClass;
  failedJobs: string[];
  requiredAction: string;
  runCount: number;
  runIds: number[];
  sampleUrls: string[];
  signature: string;
  regressionTest: { file: string; title: string } | null;
  reviewStatus: "open";
}

export interface UnitGapReport {
  generatedAt: string;
  incompleteRuns: Array<{ error: string; runId: number; url: string }>;
  range: { from: string; to: string };
  runCounts: Record<string, number>;
  groups: UnitGapGroup[];
}

const TIMESTAMP_PATTERN = /^\uFEFF?\d{4}-\d{2}-\d{2}T\S+Z\s+/u;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const SHA_PATTERN = /\b[0-9a-f]{40,64}\b/giu;
const LONG_ID_PATTERN = /\b[0-9a-f]{12,39}\b/giu;
const RUN_NUMBER_PATTERN = /\b\d{7,}\b/gu;
const URL_PATTERN = /https?:\/\/[^\s)'"<>]+/giu;
const PATH_PATTERN = /(?:\/(?:home|github|tmp|run|opt|usr|var)\/)[^\s)'"<>]+/gu;
const SANDBOX_PATTERN = /\be2e-[a-z0-9][a-z0-9-]{1,63}\b/giu;
const DURATION_PATTERN = /\b\d+(?:\.\d+)?(?:ms|s|m)\b/giu;

const ACTIONS: Record<UnitGapClass, string> = {
  deterministic:
    "Add a unit or package-contract regression test that reproduces this cause before changing the product code.",
  external:
    "Verify the retry and diagnostic contract with a fault-injection unit test; do not imitate the external outage.",
  harness:
    "Add an e2e-support test for the harness decision, cleanup path, or diagnostic that failed.",
  "needs-triage":
    "Confirm the first causal line, assign the owning component, and name the missing unit-test contract.",
};
const MANUAL_CAUSAL_LINE_REVIEW = "Failed job log requires manual causal-line review";

function stripLogPrefix(line: string): { job: string; message: string } | null {
  const fields = line.split("\t");
  if (fields.length < 3) return null;
  const job = fields[0]!.trim();
  const message = stripVTControlCharacters(
    fields.slice(2).join("\t").replace(TIMESTAMP_PATTERN, ""),
  );
  return job.length === 0 ? null : { job, message: message.trim() };
}

export function normalizeFailureSignature(message: string): string {
  const normalized = sanitizeText(message.replace(URL_PATTERN, "<url>"), Number.MAX_SAFE_INTEGER)
    .replace(/^##\[error\]\s*/u, "")
    .replace(PATH_PATTERN, "<path>")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(SHA_PATTERN, "<sha>")
    .replace(LONG_ID_PATTERN, "<id>")
    .replace(RUN_NUMBER_PATTERN, "<number>")
    .replace(SANDBOX_PATTERN, "<sandbox>")
    .replace(DURATION_PATTERN, "<duration>")
    .replace(/::<[a-z]+>|::[a-z0-9]{12,}/giu, "::<ref>")
    .replace(/\s+/gu, " ")
    .trim();
  if (/failed to compute cache key:.*reviewed-runtime-bundle\/.*: not found/iu.test(normalized)) {
    return "ERROR: reviewed runtime bundle is missing from the image build context";
  }
  if (/failed to build:.*security_inventory=/iu.test(normalized)) {
    return "ERROR: sandbox security inventory verification failed during image build";
  }
  if (/Starting the managed portable registry failed: Unable to find image/iu.test(normalized)) {
    return "Error: starting the managed portable registry failed while loading its pinned image";
  }
  return normalized.slice(0, 240);
}

function candidateScore(message: string): number {
  if (/^##\[error\]Process completed with exit code/iu.test(message)) return 0;
  if (
    /^(?:\{\s*)?echo\b|^(?:if|set|test|printf|throw new Error)\b|^\[\[|^\w+=|^[❯×]\s|^⎯|^"(?:[a-z_]+_)?matrix"|^Tests?\s+\d+\s+failed|^\d+\||^#\d+\s|^Timeout:|^openshell CLI not found|^OpenShell gateway managed service failed.*using standalone fallback|^\[install\] gh CLI download failed.*falling back|^Onboarding did not finish|^AssertionError:\s*(?:\[|test\/e2e\/.*:\s.*OK)|^FAIL\s/iu.test(
      message,
    )
  ) {
    return 0;
  }
  if (
    /(?:Release qualification did not pass|FAILED: producer run|\[e2e target=.*\]\s+\[phase|AssertionError:\s*\[non-interactive\] Agent|AssertionError:\s*✓ Active gateway|Error:.*failed:\s*[█▓]|Error:.*failed:\s*\[non-interactive\] Agent)/iu.test(
      message,
    )
  ) {
    return 30;
  }
  if (
    /(?:EAI_AGAIN|ECONNRESET|ETIMEDOUT|CORPORATE_CA_PROBE_FAIL|WSServerHandshakeError|locked file seal|No space left|Docker Hub login failed|CreateArtifact.*ETIMEDOUT|docker: Error response)/iu.test(
      message,
    )
  ) {
    return 120;
  }
  if (/^##\[error\](?!Process completed)/iu.test(message)) return 110;
  if (/^AssertionError:\s+\S/iu.test(message)) return 100;
  if (/^(?:Error|ERROR):\s+\S/iu.test(message)) return 95;
  if (/^npm error (?:code|request|403|404|5\d\d)/iu.test(message)) return 90;
  if (/^\[nemoclaw\].*(?:exhausted|failed|missing|refus)/iu.test(message)) return 90;
  if (/^curl:\s*\(\d+\)/iu.test(message)) return 85;
  if (/\b(?:failed|timed out|timeout|not found|missing)\b/iu.test(message)) return 60;
  return 0;
}

function selectJobSignature(messages: readonly string[]): string | null {
  const candidates = messages
    .map((message, index) => ({ index, message, score: candidateScore(message) }))
    .filter((candidate) => candidate.score > 0);
  const selected = candidates.sort(
    (left, right) => right.score - left.score || left.index - right.index,
  )[0];
  if (selected === undefined || selected.score < 60) return null;
  const signature = normalizeFailureSignature(selected.message);
  return signature.length === 0 ? null : signature;
}

export function extractJobSignatures(log: string): Array<{ job: string; signature: string }> {
  const messagesByJob = new Map<string, string[]>();
  for (const line of log.split(/\r?\n/gu)) {
    const parsed = stripLogPrefix(line);
    if (parsed === null) continue;
    const messages = messagesByJob.get(parsed.job) ?? [];
    messages.push(parsed.message);
    messagesByJob.set(parsed.job, messages);
  }
  return [...messagesByJob]
    .map(([job, messages]) => ({
      job,
      signature:
        selectJobSignature(messages) ??
        (messages.some((message) =>
          /(?:##\[error\]|AssertionError|Failed Tests|Tests?\s+\d+\s+failed|^FAIL\s)/iu.test(
            message,
          ),
        )
          ? MANUAL_CAUSAL_LINE_REVIEW
          : null),
    }))
    .filter((entry): entry is { job: string; signature: string } => entry.signature !== null);
}

export function classifyFailureSignature(signature: string): UnitGapClass {
  if (signature === MANUAL_CAUSAL_LINE_REVIEW) return "needs-triage";
  if (
    /\b(?:EAI_AGAIN|ECONNRESET|ETIMEDOUT|connection reset|temporary failure|rate limit|HTTP (?:408|429|5\d\d)|returned error: (?:408|429|5\d\d)|Docker Hub login failed|CreateArtifact.*ETIMEDOUT)\b/iu.test(
      signature,
    )
  ) {
    return "external";
  }
  if (/(?:CORPORATE_CA_PROBE_FAIL|WSServerHandshakeError|locked file seal)/iu.test(signature)) {
    return "deterministic";
  }
  if (
    /(?:E2E cleanup failed|Live E2E selection ran no tests|risk signal requires|workflow run total_count changed)/iu.test(
      signature,
    )
  ) {
    return "harness";
  }
  if (
    /(?:AssertionError|\bexpected\b|\bmissing\b|\bnot found\b|\brequires\b|\binvalid\b|\bdid not\b|\bcannot\b|\bunsupported\b|owner-mode|locked file seal)/iu.test(
      signature,
    )
  ) {
    return "deterministic";
  }
  return "needs-triage";
}

function conclusionKey(run: E2ERunRecord): string {
  if (run.status !== "completed") return run.status;
  return run.conclusion || "unknown";
}

export function buildUnitGapReport(
  evidence: readonly RunLogEvidence[],
  range: UnitGapReport["range"],
  generatedAt = new Date().toISOString(),
): UnitGapReport {
  const runCounts: Record<string, number> = {};
  const incompleteRuns: UnitGapReport["incompleteRuns"] = [];
  const grouped = new Map<
    string,
    {
      classification: UnitGapClass;
      jobs: Set<string>;
      runIds: Set<number>;
      signature: string;
      urls: Set<string>;
    }
  >();

  for (const item of evidence) {
    const key = conclusionKey(item.run);
    runCounts[key] = (runCounts[key] ?? 0) + 1;
    if (item.run.status !== "completed") {
      incompleteRuns.push({
        error: `run was ${normalizeFailureSignature(item.run.status)} at the collection cutoff`,
        runId: item.run.databaseId,
        url: item.run.url,
      });
      continue;
    }
    if (item.run.conclusion !== "failure") continue;
    if (item.log === undefined || item.error !== undefined) {
      incompleteRuns.push({
        error: normalizeFailureSignature(item.error ?? "failed log unavailable"),
        runId: item.run.databaseId,
        url: item.run.url,
      });
      continue;
    }
    const signatures = extractJobSignatures(item.log);
    if (signatures.length === 0) {
      incompleteRuns.push({
        error: "failed log contained no specific causal signature",
        runId: item.run.databaseId,
        url: item.run.url,
      });
      continue;
    }
    for (const { job, signature } of signatures) {
      const classification = classifyFailureSignature(signature);
      const groupKey = `${classification}\0${signature}`;
      const group = grouped.get(groupKey) ?? {
        classification,
        jobs: new Set<string>(),
        runIds: new Set<number>(),
        signature,
        urls: new Set<string>(),
      };
      group.jobs.add(job);
      group.runIds.add(item.run.databaseId);
      group.urls.add(item.run.url);
      grouped.set(groupKey, group);
    }
  }

  const groups = [...grouped.values()]
    .map((group): UnitGapGroup => ({
      classification: group.classification,
      failedJobs: [...group.jobs].sort(),
      requiredAction: ACTIONS[group.classification],
      runCount: group.runIds.size,
      runIds: [...group.runIds].sort((left, right) => left - right),
      sampleUrls: [...group.urls].sort().slice(0, 3),
      signature: group.signature,
      regressionTest: null,
      reviewStatus: "open",
    }))
    .sort(
      (left, right) =>
        right.runCount - left.runCount || left.signature.localeCompare(right.signature),
    );

  return { generatedAt, groups, incompleteRuns, range, runCounts };
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatUnitGapReport(report: UnitGapReport): string {
  const counts = Object.entries(report.runCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");
  const lines = [
    "# E2E unit-test gap report",
    "",
    `Range: ${report.range.from} through ${report.range.to}`,
    "",
    `Runs: ${counts || "none"}`,
    "",
    "Each row is a cause candidate, not a final root-cause decision. Review the linked runs before assigning the test contract.",
    "",
    "| Cause candidate | Class | Runs | Failed jobs | Review status | Regression test | Required test action | Evidence |",
    "| --- | --- | ---: | --- | --- | --- | --- | --- |",
  ];
  for (const group of report.groups) {
    const evidence = group.sampleUrls.map((url, index) => `[run ${index + 1}](${url})`).join(", ");
    lines.push(
      `| ${escapeCell(group.signature)} | ${group.classification} | ${group.runCount} | ${escapeCell(group.failedJobs.join(", "))} | ${group.reviewStatus} | — | ${escapeCell(group.requiredAction)} | ${evidence} |`,
    );
  }
  if (report.groups.length === 0) {
    lines.push("| No failed-job signatures found | — | 0 | — | — | — | — | — |");
  }
  lines.push("", `Incomplete selected runs: ${report.incompleteRuns.length}`, "");
  if (report.incompleteRuns.length > 0) {
    lines.push(
      "The report is incomplete. Wait for unfinished runs and resolve unavailable failed logs before using it as a weekly test-gap ledger.",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
