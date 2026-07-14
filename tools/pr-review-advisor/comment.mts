#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  credentialFreeTestIdForFile,
  type TrustedE2eRecommendationInventory,
  trustedE2eRecommendationInventory,
} from "../advisors/e2e-recommendations.mts";
import { deleteBotOwnedStickyComments, upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";

const MARKER = "<!-- nemoclaw-pr-review-advisor -->";
const COMMENT_TITLE = "PR Review Advisor";
const E2E_RENDER_LIMIT = 20;
const MAX_COMMENT_BYTES = 60 * 1024;
const COMMENT_TRUNCATION_NOTICE =
  "\n\n_Comment truncated to fit GitHub's size limit. The workflow artifact contains the complete review._\n";
let cachedE2eInventory: TrustedE2eRecommendationInventory | undefined;

type ReviewAdvisorResult = {
  headSha?: string;
  changedFiles?: string[];
  summary?: {
    recommendation?: string;
    confidence?: string;
    oneLine?: string;
    topItem?: string;
    sinceLastReview?: {
      resolved?: number;
      stillApplies?: number;
      newItems?: number;
    };
  };
  findings?: Array<{
    severity?: string;
    category?: string;
    title?: string;
    file?: string | null;
    line?: number | null;
    description?: string;
    impact?: string;
    recommendation?: string;
    verificationHint?: string;
    missingRegressionTest?: string;
    evidence?: string;
    simplification?: {
      tag?: string;
      cut?: string;
      replacement?: string;
      estimatedNetLines?: number | null;
      safetyBoundary?: string;
    };
  }>;
  e2e?: {
    coverage?: {
      requiredTests?: Array<{ id?: string; reason?: string }>;
      optionalTests?: Array<{ id?: string; reason?: string }>;
      newE2eRecommendations?: Array<{
        domain?: string;
        reason?: string;
        suggestedTest?: string;
      }>;
      noE2eReason?: string | null;
    };
    targets?: {
      exactHeadCredentialFreeTests?: Array<{
        id?: string;
        file?: string;
        headSha?: string;
      }>;
      required?: Array<{
        id?: string;
        workflow?: string;
        selectorType?: string;
        required?: boolean;
        reason?: string;
      }>;
      optional?: Array<{
        id?: string;
        workflow?: string;
        selectorType?: string;
        required?: boolean;
        reason?: string;
      }>;
      noTargetE2eReason?: string | null;
    };
  };
};

type CommentMetadata = {
  runId?: string;
  runAttempt?: string;
  commentId?: string;
  eventName?: string;
  prNumber?: string;
  workflowSha?: string;
  baseSha?: string;
  workflowPath?: string;
};

type Finding = NonNullable<ReviewAdvisorResult["findings"]>[number];

type FindingRecord = {
  id: string;
  finding: Finding;
};

type FindingCounts = {
  blockers: number;
  warnings: number;
  suggestions: number;
};

type LaneFingerprints = {
  findings: string;
  e2e: string;
};

export type AdvisorLaneReport = {
  status: "completed" | "failed" | "skipped" | "unavailable";
  partial: boolean;
  counts?: FindingCounts;
  confidence?: "low" | "medium" | "high";
  fingerprints?: LaneFingerprints;
};

export type AdvisorLaneReports = {
  primary: AdvisorLaneReport;
  secondOpinion: AdvisorLaneReport;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const pr = args.pr || process.env.PR_NUMBER;
  const summaryPath = args.summary || "artifacts/pr-review-advisor/pr-review-advisor-summary.md";
  const resultPath =
    args.result || "artifacts/pr-review-advisor/pr-review-advisor-final-result.json";
  if (!args.analysisResult) {
    throw new Error("--analysis-result is required");
  }
  if (Boolean(args.secondOpinionAnalysisResult) !== Boolean(args.secondOpinionResult)) {
    throw new Error(
      "--second-opinion-analysis-result and --second-opinion-result must be provided together",
    );
  }
  const { marker, title, label } = normalizeCommentOptions({
    marker: args.marker || process.env.PR_REVIEW_ADVISOR_COMMENT_MARKER || MARKER,
    title: args.title || process.env.PR_REVIEW_ADVISOR_COMMENT_TITLE || COMMENT_TITLE,
    label: args.label || process.env.PR_REVIEW_ADVISOR_COMMENT_LABEL || "PR review advisor",
  });
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  if (!repo || !pr) {
    console.log("Skipping PR review advisor comment: repo or PR number not provided");
    return;
  }
  if (!token) {
    console.log("Skipping PR review advisor comment: GITHUB_TOKEN/GH_TOKEN not provided");
    return;
  }

  const { summary, result } = readCommentArtifacts(summaryPath, resultPath, {
    summaryExplicit: Boolean(args.summary),
    resultExplicit: Boolean(args.result),
  });
  const lanes = readAdvisorLaneReports({
    primaryAnalysisResultPath: args.analysisResult,
    primaryResult: result,
    secondOpinionAnalysisResultPath: args.secondOpinionAnalysisResult,
    secondOpinionResultPath: args.secondOpinionResult,
  });
  const baseMetadata = {
    runId: process.env.PR_REVIEW_ADVISOR_RUN_ID || process.env.GITHUB_RUN_ID,
    runAttempt: process.env.PR_REVIEW_ADVISOR_RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT,
    eventName: process.env.PR_REVIEW_ADVISOR_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
    prNumber: pr,
    workflowSha: process.env.TRUSTED_WORKFLOW_SHA,
    baseSha: process.env.PR_BASE_SHA,
    workflowPath: process.env.PR_REVIEW_ADVISOR_WORKFLOW_PATH,
  };
  const body = buildComment({
    summary,
    result,
    runUrl,
    marker,
    title,
    metadata: baseMetadata,
    lanes,
  });

  await upsertStickyComment({
    repo,
    pr,
    token,
    marker,
    body,
    label,
    bodyForComment: (comment) =>
      buildComment({
        summary,
        result,
        runUrl,
        marker,
        title,
        metadata: { ...baseMetadata, commentId: String(comment.id) },
        lanes,
      }),
  });
  await deleteBotOwnedStickyComments({
    repo,
    pr,
    token,
    markers: ["<!-- nemoclaw-e2e-advisor -->", "<!-- nemoclaw-e2e-target-advisor -->"],
    label: "legacy E2E advisor",
  });
}

export function normalizeCommentOptions({
  marker,
  title,
  label,
}: {
  marker: string;
  title: string;
  label: string;
}): { marker: string; title: string; label: string } {
  return {
    marker: validateCommentMarker(marker),
    title: validateSingleLineCommentField(title, "title"),
    label: validateSingleLineCommentField(label, "label"),
  };
}

function validateCommentMarker(marker: string): string {
  const value = marker.trim();
  if (!/^<!--\s+nemoclaw-pr-review-advisor(?:-[a-z0-9-]+)?\s+-->$/.test(value)) {
    throw new Error(
      "PR review advisor marker must be a safe nemoclaw-pr-review-advisor HTML comment",
    );
  }
  return value;
}

function validateSingleLineCommentField(value: string, field: "title" | "label"): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`PR review advisor ${field} must be a non-empty single-line string`);
  }
  return normalized;
}

export function readCommentArtifacts(
  summaryPath: string,
  resultPath: string,
  options: { summaryExplicit?: boolean; resultExplicit?: boolean } = {},
): { summary: string; result?: ReviewAdvisorResult } {
  const summary = options.summaryExplicit
    ? readIfExists(summaryPath)
    : readIfExists(summaryPath) ||
      readIfExists("artifacts/pr-review-advisor/pr-review-advisor-summary.md");
  if (!summary) throw new Error(`No PR review advisor summary found at ${summaryPath}`);
  const result = readJsonIfExists<ReviewAdvisorResult>(resultPath);
  if (options.resultExplicit && !result) {
    throw new Error(`No PR review advisor result found at ${resultPath}`);
  }
  return { summary, result };
}

export function readAdvisorLaneReports({
  primaryAnalysisResultPath,
  primaryResult,
  secondOpinionAnalysisResultPath,
  secondOpinionResultPath,
}: {
  primaryAnalysisResultPath: string;
  primaryResult?: ReviewAdvisorResult;
  secondOpinionAnalysisResultPath?: string;
  secondOpinionResultPath?: string;
}): AdvisorLaneReports {
  const primaryAnalysisResult = readJsonIfExists<unknown>(primaryAnalysisResultPath);
  if (!primaryAnalysisResult) {
    throw new Error(`No primary advisor analysis result found at ${primaryAnalysisResultPath}`);
  }
  const primary = normalizeAdvisorLaneReport(primaryAnalysisResult, primaryResult);
  if (!secondOpinionAnalysisResultPath || !secondOpinionResultPath) {
    return { primary, secondOpinion: unavailableLaneReport() };
  }

  try {
    const secondOpinionAnalysisResult = readJsonIfExists<unknown>(secondOpinionAnalysisResultPath);
    const secondOpinionResult = readJsonIfExists<ReviewAdvisorResult>(secondOpinionResultPath);
    return {
      primary,
      secondOpinion: normalizeAdvisorLaneReport(
        secondOpinionAnalysisResult,
        secondOpinionResult,
        primaryResult?.headSha,
      ),
    };
  } catch {
    // The evaluation lane is deliberately non-blocking. A malformed or
    // unreadable second-opinion artifact is reported as unavailable and can
    // never suppress publication of the trusted primary result.
    return { primary, secondOpinion: unavailableLaneReport() };
  }
}

export function normalizeAdvisorLaneReport(
  analysisResult: unknown,
  finalResult: unknown,
  expectedHeadSha?: string,
): AdvisorLaneReport {
  if (!isRecord(analysisResult)) return unavailableLaneReport();
  const failed = analysisResult.failed === true;
  const skipped = analysisResult.skipped === true;
  if (failed && skipped) return unavailableLaneReport();
  if (skipped) return { status: "skipped", partial: false };

  const partial = failed && analysisResult.partial === true;
  if (failed && !partial) return { status: "failed", partial: false };
  const structure = trustedLaneStructure(finalResult, expectedHeadSha);
  if (failed) {
    return {
      status: "failed",
      partial: true,
      ...(structure ?? {}),
    };
  }
  if (analysisResult.version !== 1 || !structure) return unavailableLaneReport();
  return { status: "completed", partial: false, ...structure };
}

export function buildComment({
  summary: _summary,
  result,
  runUrl,
  marker,
  title,
  metadata,
  lanes,
}: {
  summary: string;
  result?: ReviewAdvisorResult;
  runUrl?: string;
  marker?: string;
  title?: string;
  metadata?: CommentMetadata;
  lanes?: AdvisorLaneReports;
}): string {
  const findingRecords = collectFindingRecords(result);
  const blockerCount = findingRecords.filter(
    (record) => record.finding.severity === "blocker",
  ).length;
  const warningCount = findingRecords.filter(
    (record) => record.finding.severity === "warning",
  ).length;
  const suggestionCount = findingRecords.filter(
    (record) => record.finding.severity === "suggestion",
  ).length;
  const reviewHistory = buildSecondarySummary(result);
  const informational =
    result?.summary?.recommendation === "info_only" && result.summary.oneLine
      ? `**Status:** ${escapeCommentText(result.summary.oneLine)}\n`
      : "";
  const findingsDetails = renderFindingsDetails(findingRecords);
  const e2eDetails = renderE2eDetails(result);
  const laneDetails = renderAdvisorLanes(lanes);
  const details = runUrl ? `\n[Workflow run details](${runUrl})` : "";
  const hiddenMetadata = renderHiddenMetadata(result, metadata);
  const posture = reviewPosture(
    result?.summary?.recommendation,
    result?.summary?.confidence,
    blockerCount,
  );
  const headline = reviewHeadline(result?.summary?.recommendation, blockerCount);
  const heading = validateSingleLineCommentField(title || COMMENT_TITLE, "title");
  const renderedMarker = validateCommentMarker(marker || MARKER);
  const prefix = `${renderedMarker}\n${hiddenMetadata}`;
  const content = `## ${heading} — ${headline}

**Advisor assessment:** ${posture}
**Primary next action:** ${primaryNextAction(findingRecords)}
**Findings:** ${compactCount(blockerCount, "blocker")} · ${compactCount(warningCount, "warning")} · ${compactCount(suggestionCount, "optional suggestion")}
${informational}${laneDetails}${reviewHistory}${e2eDetails}${findingsDetails}${details}

This is an automated, non-authoritative review. Findings are inputs to maintainer adjudication. Warnings and optional suggestions do not require a response or follow-up. A human maintainer makes the final merge decision.

`;
  return boundedComment(prefix, content);
}

function renderAdvisorLanes(lanes?: AdvisorLaneReports): string {
  if (!lanes) return "";
  const lines = [
    "",
    "### Model lanes",
    `- **GPT-5.6 Terra (primary):** ${renderLaneReport(lanes.primary)}`,
    `- **Nemotron 3 Ultra (non-blocking second opinion):** ${renderLaneReport(lanes.secondOpinion)}`,
  ];
  const comparison = renderLaneComparison(lanes.primary, lanes.secondOpinion);
  if (comparison) lines.push(`- **Model comparison:** ${comparison}`);
  lines.push(
    "",
    "_Nemotron is a non-blocking second opinion. Its prose, findings, and E2E guidance do not change the primary assessment above and remain in workflow artifacts only._",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function renderLaneReport(report: AdvisorLaneReport): string {
  const status =
    report.status === "completed"
      ? "Completed"
      : report.status === "failed"
        ? report.partial
          ? "Failed after a partial review"
          : "Failed"
        : report.status === "skipped"
          ? "Skipped"
          : "Unavailable";
  if (!report.counts) return status;
  const confidence = report.confidence ? ` · ${report.confidence} confidence` : "";
  return `${status}${confidence} · ${compactCount(report.counts.blockers, "blocker")} · ${compactCount(report.counts.warnings, "warning")} · ${compactCount(report.counts.suggestions, "suggestion")}`;
}

function renderLaneComparison(
  primary: AdvisorLaneReport,
  secondOpinion: AdvisorLaneReport,
): string | undefined {
  if (
    primary.status !== "completed" ||
    secondOpinion.status !== "completed" ||
    !primary.counts ||
    !secondOpinion.counts ||
    !primary.fingerprints ||
    !secondOpinion.fingerprints
  ) {
    return undefined;
  }
  const differences = [
    countDifference(secondOpinion.counts.blockers - primary.counts.blockers, "blocker"),
    countDifference(secondOpinion.counts.warnings - primary.counts.warnings, "warning"),
    countDifference(secondOpinion.counts.suggestions - primary.counts.suggestions, "suggestion"),
  ];
  const findingComparison =
    primary.fingerprints.findings === secondOpinion.fingerprints.findings
      ? "normalized findings match"
      : "normalized findings differ";
  const e2eComparison =
    primary.fingerprints.e2e === secondOpinion.fingerprints.e2e
      ? "normalized E2E selections match"
      : "normalized E2E selections differ";
  const countComparison = differences.every((difference) =>
    difference.startsWith("the same number"),
  )
    ? "severity counts match"
    : `Nemotron reported ${differences.join(", ")}`;
  return `${findingComparison}; ${e2eComparison}; ${countComparison}.`;
}

function countDifference(difference: number, label: string): string {
  if (difference === 0) return `the same number of ${label}s`;
  const direction = difference > 0 ? "more" : "fewer";
  const count = Math.abs(difference);
  return `${count} ${direction} ${count === 1 ? label : `${label}s`}`;
}

function renderE2eDetails(result?: ReviewAdvisorResult): string {
  const coverage = result?.e2e?.coverage;
  const targets = result?.e2e?.targets;
  if (!coverage && !targets) return "";

  const inventory = commentE2eInventory();
  const exactHeadCredentialFreeJobIds = trustedExactHeadCredentialFreeJobIds(result);
  const requiredCoverage = trustedCoverageItems(coverage?.requiredTests, inventory);
  const optionalCoverage = trustedCoverageItems(coverage?.optionalTests, inventory);
  const newRecommendations: NonNullable<
    NonNullable<ReviewAdvisorResult["e2e"]>["coverage"]
  >["newE2eRecommendations"] = [];
  const requiredTargets = trustedTargetItems(
    targets?.required,
    true,
    inventory,
    exactHeadCredentialFreeJobIds,
  );
  const optionalTargets = trustedTargetItems(
    targets?.optional,
    false,
    inventory,
    exactHeadCredentialFreeJobIds,
  );
  const noE2eReason = "No deterministic or trusted-inventory E2E coverage was selected.";
  const noTargetE2eReason = "No trusted E2E selector was selected.";
  const lines = [
    "",
    "### E2E guidance",
    "_Advisory only: coverage and selector recommendations are non-authoritative. E2E / PR Gate independently computes and dispatches trusted jobs without consuming this output._",
    "",
  ];

  lines.push(
    `**Recommended coverage:** ${renderE2eIds(requiredCoverage) || "_None_"}`,
    `**Recommended selectors:** ${renderE2eIds(requiredTargets) || "_None_"}`,
  );
  if (requiredCoverage.length > 0) {
    lines.push("");
    for (const item of requiredCoverage.slice(0, E2E_RENDER_LIMIT)) {
      const id = escapeLocationHtml(item.id || "E2E test");
      const reason = item.reason ? ` — ${escapeCommentText(item.reason)}` : "";
      lines.push(`- <code>${id}</code>${reason}`);
    }
  }
  if (requiredTargets.length > 0) {
    lines.push("");
    for (const item of requiredTargets.slice(0, E2E_RENDER_LIMIT)) {
      const id = escapeLocationHtml(item.id || "E2E target");
      const reason = item.reason ? ` — ${escapeCommentText(item.reason)}` : "";
      lines.push(`- <code>${id}</code>${reason}`);
    }
  }

  if (optionalCoverage.length > 0 || optionalTargets.length > 0 || newRecommendations.length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>${compactCount(optionalCoverage.length, "optional coverage item")} · ${compactCount(optionalTargets.length, "optional selector")} · ${compactCount(newRecommendations.length, "new-test recommendation")}</summary>`,
      "",
    );
    for (const item of optionalCoverage.slice(0, E2E_RENDER_LIMIT)) {
      lines.push(
        `- Optional coverage <code>${escapeLocationHtml(item.id || "unnamed")}</code>${item.reason ? ` — ${escapeCommentText(item.reason)}` : ""}`,
      );
    }
    for (const item of optionalTargets.slice(0, E2E_RENDER_LIMIT)) {
      lines.push(
        `- Optional selector <code>${escapeLocationHtml(item.id || "unnamed")}</code>${item.reason ? ` — ${escapeCommentText(item.reason)}` : ""}`,
      );
    }
    for (const item of newRecommendations.slice(0, E2E_RENDER_LIMIT)) {
      const name = item.suggestedTest || item.domain || "E2E test";
      lines.push(
        `- New test: ${escapeCommentText(name)}${item.reason ? ` — ${escapeCommentText(item.reason)}` : ""}`,
      );
    }
    lines.push("", "</details>");
  }

  if (requiredCoverage.length === 0 && optionalCoverage.length === 0 && noE2eReason) {
    lines.push("", `**Why no E2E coverage is recommended:** ${escapeCommentText(noE2eReason)}`);
  }
  if (requiredTargets.length === 0 && optionalTargets.length === 0 && noTargetE2eReason) {
    lines.push("", `**Why no selector is recommended:** ${escapeCommentText(noTargetE2eReason)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function trustedCoverageItems(
  items: Array<{ id?: string; reason?: string }> | undefined,
  inventory: TrustedE2eRecommendationInventory,
): Array<{ id: string; reason: string }> {
  const allowedIds = new Set([...inventory.allowedJobIds, ...inventory.liveSupportedTargetIds]);
  const seen = new Set<string>();
  return (items ?? []).flatMap((item) => {
    const id = item.id;
    if (!id || !allowedIds.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, reason: "Selected from the trusted checked-in E2E coverage inventory." }];
  });
}

function trustedTargetItems(
  items:
    | Array<{
        id?: string;
        workflow?: string;
        selectorType?: string;
        required?: boolean;
        reason?: string;
      }>
    | undefined,
  required: boolean,
  inventory: TrustedE2eRecommendationInventory,
  exactHeadCredentialFreeJobIds: ReadonlySet<string>,
): Array<{ id: string; reason: string }> {
  const allowedJobs = new Set(inventory.allowedJobIds);
  const allowedTargets = new Set(inventory.liveSupportedTargetIds);
  const seen = new Set<string>();
  return (items ?? []).flatMap((item) => {
    const id = item.id;
    const selectorType = item.selectorType;
    if (!id || item.workflow !== inventory.workflow || item.required !== required) return [];
    const trustedTuple =
      (selectorType === "all" && id === inventory.fanoutId) ||
      (selectorType === "job" && (allowedJobs.has(id) || exactHeadCredentialFreeJobIds.has(id))) ||
      (selectorType === "target" && allowedTargets.has(id));
    const key = `${selectorType}:${id}`;
    if (!trustedTuple || seen.has(key)) return [];
    seen.add(key);
    const reason =
      selectorType === "all"
        ? "Selected as the trusted full E2E fan-out selector."
        : selectorType === "job"
          ? exactHeadCredentialFreeJobIds.has(id) && !allowedJobs.has(id)
            ? "Selected as a trusted exact-head credential-free E2E job."
            : "Selected as a trusted checked-in E2E job."
          : "Selected as a trusted live-supported E2E target.";
    return [{ id, reason }];
  });
}

function trustedExactHeadCredentialFreeJobIds(result?: ReviewAdvisorResult): Set<string> {
  const ids = new Set<string>();
  const headSha = result?.headSha;
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) return ids;
  const changedFiles = new Set(
    (result.changedFiles ?? []).filter((file): file is string => typeof file === "string"),
  );
  const evidence = result.e2e?.targets?.exactHeadCredentialFreeTests;
  if (!Array.isArray(evidence)) return ids;

  for (const item of evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (Object.keys(item).some((key) => !["id", "file", "headSha"].includes(key))) continue;
    const { id, file, headSha: evidenceHeadSha } = item;
    if (!id || !file || evidenceHeadSha !== headSha || !changedFiles.has(file)) continue;
    if (credentialFreeTestIdForFile(file) !== id) continue;
    ids.add(id);
  }
  return ids;
}

function commentE2eInventory(): TrustedE2eRecommendationInventory {
  cachedE2eInventory ??= trustedE2eRecommendationInventory();
  return cachedE2eInventory;
}

function renderE2eIds(items: Array<{ id?: string }>): string {
  return items
    .slice(0, E2E_RENDER_LIMIT)
    .map((item) => `<code>${escapeLocationHtml(item.id || "unnamed")}</code>`)
    .join(", ");
}

function collectFindingRecords(result?: ReviewAdvisorResult): FindingRecord[] {
  return (result?.findings || []).map((finding, index) => ({
    id: `PRA-${index + 1}`,
    finding,
  }));
}

function trustedLaneStructure(
  value: unknown,
  expectedHeadSha?: string,
):
  | {
      counts: FindingCounts;
      confidence?: "low" | "medium" | "high";
      fingerprints: LaneFingerprints;
    }
  | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.findings)) return undefined;
  if (expectedHeadSha && value.headSha !== expectedHeadSha) return undefined;
  const counts: FindingCounts = { blockers: 0, warnings: 0, suggestions: 0 };
  for (const finding of value.findings) {
    if (!isRecord(finding)) continue;
    if (finding.severity === "blocker") counts.blockers += 1;
    else if (finding.severity === "warning") counts.warnings += 1;
    else if (finding.severity === "suggestion") counts.suggestions += 1;
  }
  const summary = isRecord(value.summary) ? value.summary : undefined;
  const confidence = trustedLaneConfidence(summary?.confidence);
  return {
    counts,
    ...(confidence ? { confidence } : {}),
    fingerprints: {
      findings: opaqueFingerprint(normalizedFindingRecords(value.findings)),
      e2e: opaqueFingerprint(e2eDecisionSets(value.e2e)),
    },
  };
}

function normalizedFindingRecords(value: unknown[]): unknown[] {
  return value
    .filter(isRecord)
    .map((finding) => ({ ...finding }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function trustedLaneConfidence(value: unknown): "low" | "medium" | "high" | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function e2eDecisionSets(value: unknown): Record<string, string[]> {
  const e2e = isRecord(value) ? value : {};
  const coverage = isRecord(e2e.coverage) ? e2e.coverage : {};
  const targets = isRecord(e2e.targets) ? e2e.targets : {};
  return {
    requiredCoverage: normalizedIds(coverage.requiredTests),
    optionalCoverage: normalizedIds(coverage.optionalTests),
    requiredSelectors: normalizedSelectors(targets.required),
    optionalSelectors: normalizedSelectors(targets.optional),
  };
}

function normalizedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
    ),
  ].sort();
}

function normalizedSelectors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          typeof item.workflow !== "string" ||
          typeof item.selectorType !== "string"
        ) {
          return [];
        }
        return [`${item.workflow}:${item.selectorType}:${item.id}`];
      }),
    ),
  ].sort();
}

function opaqueFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function unavailableLaneReport(): AdvisorLaneReport {
  return { status: "unavailable", partial: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderHiddenMetadata(result?: ReviewAdvisorResult, metadata?: CommentMetadata): string {
  const fields = [
    result?.headSha ? `head_sha: ${safeMetadataValue(result.headSha)}` : undefined,
    result?.summary?.recommendation
      ? `recommendation: ${safeMetadataValue(result.summary.recommendation)}`
      : undefined,
    metadata?.runId ? `run_id: ${safeMetadataValue(metadata.runId)}` : undefined,
    metadata?.runAttempt ? `run_attempt: ${safeMetadataValue(metadata.runAttempt)}` : undefined,
    metadata?.commentId ? `comment_id: ${safeMetadataValue(metadata.commentId)}` : undefined,
    metadata?.eventName ? `event: ${safeMetadataValue(metadata.eventName)}` : undefined,
    metadata?.prNumber ? `pr_number: ${safeMetadataValue(metadata.prNumber)}` : undefined,
    metadata?.workflowSha ? `workflow_sha: ${safeMetadataValue(metadata.workflowSha)}` : undefined,
    metadata?.baseSha ? `base_sha: ${safeMetadataValue(metadata.baseSha)}` : undefined,
    metadata?.workflowPath
      ? `workflow_path: ${safeMetadataValue(metadata.workflowPath)}`
      : undefined,
  ].filter((field): field is string => Boolean(field));
  return fields.length > 0 ? `<!-- ${fields.join("; ")} -->\n` : "";
}

function safeMetadataValue(value: string): string {
  return value
    .replace(/[;\n\r<>]/g, "")
    .trim()
    .slice(0, 120);
}

function boundedComment(prefix: string, content: string): string {
  const full = `${prefix}${content}`;
  if (Buffer.byteLength(full, "utf8") <= MAX_COMMENT_BYTES) return full;
  const contentBytes =
    MAX_COMMENT_BYTES -
    Buffer.byteLength(prefix, "utf8") -
    Buffer.byteLength(COMMENT_TRUNCATION_NOTICE, "utf8");
  if (contentBytes <= 0) throw new Error("PR review advisor metadata exceeds comment size limit");
  return `${prefix}${truncateUtf8(content, contentBytes).trimEnd()}${COMMENT_TRUNCATION_NOTICE}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function reviewHeadline(recommendation: string | undefined, blockerCount: number): string {
  if (blockerCount > 0) return "Blocking findings reported";
  if (recommendation === "superseded") return "Superseded";
  if (recommendation === "info_only") return "Informational";
  return "No blocking findings reported";
}

function reviewPosture(
  recommendation: string | undefined,
  confidence: string | undefined,
  blockerCount: number,
): string {
  if (blockerCount > 0) return "Blocking findings require maintainer adjudication";
  if (recommendation === "superseded") return "Superseded by other work";
  if (recommendation === "info_only") {
    return `Informational / ${trustedConfidence(confidence)} confidence`;
  }
  return "No blocking advisor findings reported";
}

function trustedConfidence(confidence: string | undefined): string {
  return confidence === "low" || confidence === "medium" || confidence === "high"
    ? confidence
    : "unknown";
}

function primaryNextAction(records: FindingRecord[]): string {
  if (records.some((record) => record.finding.severity === "blocker")) {
    return "Review the blocking findings below.";
  }
  if (records.some((record) => record.finding.severity === "warning")) {
    return "Review the warnings below.";
  }
  if (records.some((record) => record.finding.severity === "suggestion")) {
    return "Optional suggestions are listed below.";
  }
  return "No advisor follow-up required beyond maintainer review.";
}

function buildSecondarySummary(result?: ReviewAdvisorResult): string {
  const sinceLastReview = result?.summary?.sinceLastReview;
  if (sinceLastReview) {
    return `**Since last review:** ${countLabel(sinceLastReview.resolved, "prior item")} resolved · ${countLabel(sinceLastReview.stillApplies, "still applies", "still apply")} · ${countLabel(sinceLastReview.newItems, "new item")} found\n`;
  }
  return "";
}

function renderFindingsDetails(records: FindingRecord[]): string {
  if (records.length === 0) return "";
  const blockerFindings = records.filter((record) => record.finding.severity === "blocker");
  const warningFindings = records.filter((record) => record.finding.severity === "warning");
  const suggestionFindings = records.filter((record) => record.finding.severity === "suggestion");
  const lines: string[] = [];
  if (blockerFindings.length > 0) {
    lines.push("", "### Blocking findings for maintainer adjudication", "");
    for (const record of blockerFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  if (warningFindings.length === 0 && suggestionFindings.length === 0)
    return `${lines.join("\n")}\n`;
  lines.push(
    "",
    "<details>",
    `<summary>${countLabel(warningFindings.length, "warning")} · ${countLabel(suggestionFindings.length, "optional suggestion")}</summary>`,
    "",
  );
  if (warningFindings.length > 0) {
    lines.push(
      "### Warnings",
      "_These merit maintainer attention but do not block by themselves._",
      "",
    );
    for (const record of warningFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  if (suggestionFindings.length > 0) {
    lines.push(
      "### Suggestions (optional)",
      "_No response or follow-up is expected for these suggestions._",
      "",
    );
    for (const record of suggestionFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  lines.push("</details>", "");
  return `${lines.join("\n")}\n`;
}

function formatFinding(record: FindingRecord): string {
  const finding = record.finding;
  const title = escapeCommentText(findingTitle(finding));
  const lines = [`#### \`${record.id}\` ${severityLabel(finding.severity)} — ${title}`];
  lines.push(`- **Location:** ${formatInlineLocation(finding) || "not file-specific"}`);
  lines.push(`- **Category:** ${escapeCommentText(finding.category || "uncategorized")}`);
  if (finding.description) lines.push(`- **Problem:** ${escapeCommentText(finding.description)}`);
  if (finding.impact) lines.push(`- **Impact:** ${escapeCommentText(finding.impact)}`);
  if (finding.recommendation) {
    lines.push(
      `- **${actionFieldLabel(finding.severity)}:** ${escapeCommentText(finding.recommendation)}`,
    );
  }
  if (finding.verificationHint) {
    lines.push(`- **Verification:** ${escapeCommentText(finding.verificationHint)}`);
  }
  if (finding.missingRegressionTest) {
    lines.push(`- **Test coverage:** ${escapeCommentText(finding.missingRegressionTest)}`);
  }
  if (finding.simplification) {
    const item = finding.simplification;
    const net =
      typeof item.estimatedNetLines === "number" ? ` Net: ${item.estimatedNetLines} lines.` : "";
    lines.push(
      `- **Simplification (${escapeCommentText(item.tag || "shrink")}):** Remove ${escapeCommentText(item.cut || finding.title || "the custom path")}; use ${escapeCommentText(item.replacement || "the simpler existing path")}.${net}`,
    );
    if (item.safetyBoundary) {
      lines.push(`- **Keep:** ${escapeCommentText(item.safetyBoundary)}`);
    }
  }
  if (finding.evidence) lines.push(`- **Evidence:** ${escapeCommentText(finding.evidence)}`);
  return lines.join("\n");
}

function findingTitle(finding: Finding): string {
  return finding.title || "Review finding";
}

function severityLabel(severity?: string): string {
  if (severity === "blocker") return "Blocker";
  if (severity === "warning") return "Warning";
  if (severity === "suggestion") return "Optional";
  return "Review";
}

function actionFieldLabel(severity?: string): string {
  if (severity === "blocker") return "Recommended action";
  if (severity === "warning") return "Recommendation";
  if (severity === "suggestion") return "Optional change";
  return "Recommendation";
}

function formatInlineLocation(finding: Finding): string {
  if (!finding.file) return "";
  const line = Number.isInteger(finding.line) && Number(finding.line) > 0 ? `:${finding.line}` : "";
  return `<code>${escapeLocationHtml(`${finding.file}${line}`)}</code>`;
}

function escapeLocationHtml(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("@", "&#64;");
}

function escapeCommentText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_\[\]()!|])/g, "\\$1")
    .replaceAll("@", "&#64;");
}

function countLabel(count: unknown, singular: string, plural = `${singular}s`): string {
  const numeric = typeof count === "number" && Number.isFinite(count) ? count : 0;
  return `${numeric} ${numeric === 1 ? singular : plural}`;
}

function compactCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
