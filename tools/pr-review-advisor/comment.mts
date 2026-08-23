#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import {
  credentialFreeTestIdForFile,
  E2E_RENDER_LIMIT,
  type TrustedE2eRecommendationInventory,
  trustedE2eRecommendationInventory,
} from "../advisors/e2e-recommendations.mts";
import { deleteBotOwnedStickyComments, upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";
import { isPrE2eManualControllerJob } from "../advisors/risk-plan.mts";

const MARKER = "<!-- nemoclaw-pr-review-advisor -->";
const COMMENT_TITLE = "PR Review Advisor";
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
  terminologyReview?: {
    status?: string;
    noChangesReason?: string | null;
    decisions?: readonly TerminologyDecision[];
  };
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
      changedCredentialFreeTests?: Array<{
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

type TerminologyDecision = {
  term?: string;
  disposition?: string;
  recommendation?: string;
  semanticImpact?: string;
  source?: { file?: string; line?: number; headSha?: string };
};

export type AdvisorReport = {
  status: "completed" | "failed" | "skipped" | "unavailable";
  partial: boolean;
  counts?: FindingCounts;
  confidence?: "low" | "medium" | "high";
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
  const report = readAdvisorReport(args.analysisResult, result);
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
    report,
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
        report,
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

export function readAdvisorReport(
  analysisResultPath: string,
  finalResult?: ReviewAdvisorResult,
): AdvisorReport {
  const analysisResult = readJsonIfExists<unknown>(analysisResultPath);
  if (!analysisResult) {
    throw new Error(`No advisor analysis result found at ${analysisResultPath}`);
  }
  return normalizeAdvisorReport(analysisResult, finalResult);
}

export function normalizeAdvisorReport(
  analysisResult: unknown,
  finalResult: unknown,
): AdvisorReport {
  if (!isRecord(analysisResult)) return unavailableAdvisorReport();
  const failed = analysisResult.failed === true;
  const skipped = analysisResult.skipped === true;
  if (failed && skipped) return unavailableAdvisorReport();
  if (skipped) return { status: "skipped", partial: false };

  const partial = failed && analysisResult.partial === true;
  if (failed && !partial) return { status: "failed", partial: false };
  const structure = trustedAdvisorStatus(finalResult);
  if (failed) return { status: "failed", partial: true, ...(structure ?? {}) };
  if (analysisResult.version !== 1 || !structure) return unavailableAdvisorReport();
  return { status: "completed", partial: false, ...structure };
}

export function buildComment({
  summary: _summary,
  result,
  runUrl,
  marker,
  title,
  metadata,
  report,
}: {
  summary: string;
  result?: ReviewAdvisorResult;
  runUrl?: string;
  marker?: string;
  title?: string;
  metadata?: CommentMetadata;
  report?: AdvisorReport;
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
  const terminologyDetails = renderTerminologyDetails(result);
  const e2eDetails = renderE2eDetails(result);
  const statusDetails = renderAdvisorStatus(report);
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
**Next action:** ${nextAction(findingRecords)}
**Findings:** ${compactCount(blockerCount, "blocker")} · ${compactCount(warningCount, "warning")} · ${compactCount(suggestionCount, "suggestion")}
${informational}${statusDetails}${reviewHistory}${terminologyDetails}${e2eDetails}${findingsDetails}${details}

This automated review informs maintainers. Warnings and suggestions do not require a response. A maintainer decides whether to merge.

`;
  return boundedComment(prefix, content);
}

function renderAdvisorStatus(report?: AdvisorReport): string {
  if (!report) return "";
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
  if (!report.counts) return `**Synthesis status:** ${status}\n`;
  const confidence = report.confidence ? ` · ${report.confidence} confidence` : "";
  return `**Synthesis status:** ${status}${confidence} · ${compactCount(report.counts.blockers, "blocker")} · ${compactCount(report.counts.warnings, "warning")} · ${compactCount(report.counts.suggestions, "suggestion")}\n`;
}

function renderTerminologyDetails(result?: ReviewAdvisorResult): string {
  if (typeof result?.headSha !== "string") return "";
  const decisions = Array.isArray(result?.terminologyReview?.decisions)
    ? result.terminologyReview.decisions.filter(
        (decision) =>
          typeof decision.term === "string" &&
          typeof decision.disposition === "string" &&
          typeof decision.recommendation === "string" &&
          typeof decision.source?.file === "string" &&
          Number.isInteger(decision.source.line) &&
          decision.source.headSha === result?.headSha,
      )
    : [];
  if (decisions.length === 0) return "";
  const lines = [
    "",
    "<details>",
    `<summary>${compactCount(decisions.length, "semantic terminology decision")}</summary>`,
    "",
    "_Terminology decisions are advisory. They affect the assessment only when a separate finding identifies concrete semantic impact._",
    "",
  ];
  for (const decision of decisions.slice(0, 10)) {
    lines.push(
      `- **${escapeCommentText(decision.disposition || "decision")} — ${escapeCommentText(decision.term || "term")}** at <code>${escapeLocationHtml(`${decision.source?.file}:${decision.source?.line}`)}</code>: ${escapeCommentText(decision.recommendation || "Review the term.")}`,
    );
  }
  if (decisions.length > 10) lines.push(`- _${decisions.length - 10} more._`);
  lines.push("", "</details>", "");
  return `${lines.join("\n")}\n`;
}

function renderE2eDetails(result?: ReviewAdvisorResult): string {
  const coverage = result?.e2e?.coverage;
  const targets = result?.e2e?.targets;
  if (!coverage && !targets) return "";

  const inventory = commentE2eInventory();
  const changedCredentialFreeJobIds = trustedChangedCredentialFreeJobIds(result);
  const requiredCoverage = trustedCoverageIds(coverage?.requiredTests, inventory);
  const optionalCoverage = trustedCoverageIds(coverage?.optionalTests, inventory);
  const requiredTargets = trustedTargetIds(
    targets?.required,
    true,
    inventory,
    changedCredentialFreeJobIds,
  );
  const optionalTargets = trustedTargetIds(
    targets?.optional,
    false,
    inventory,
    changedCredentialFreeJobIds,
  );
  const requiredE2e = uniqueE2eIds([...requiredTargets, ...requiredCoverage]);
  const commitUnderReviewE2e = requiredE2e.filter(isPrE2eManualControllerJob);
  const manualOnlyE2e = requiredE2e.filter((id) => !isPrE2eManualControllerJob(id));
  const optionalE2e = uniqueE2eIds([...optionalTargets, ...optionalCoverage]);
  const lines = [
    "",
    "### E2E guidance",
    "_Advisory only. A maintainer can dispatch the default E2E suite for the commit under review._",
    "",
  ];

  const hiddenRequiredCount = commitUnderReviewE2e.length - E2E_RENDER_LIMIT;
  const hiddenRequiredText = hiddenRequiredCount > 0 ? ` (+${hiddenRequiredCount} more)` : "";
  lines.push(
    `**Recommended E2E:** ${renderE2eIds(commitUnderReviewE2e) || "_None_"}${hiddenRequiredText}`,
  );

  if (manualOnlyE2e.length > 0) {
    const hiddenManualCount = manualOnlyE2e.length - E2E_RENDER_LIMIT;
    const hiddenManualText = hiddenManualCount > 0 ? ` (+${hiddenManualCount} more)` : "";
    lines.push(
      "",
      `**Manual-only E2E:** ${renderE2eIds(manualOnlyE2e) || "_None_"}${hiddenManualText}`,
      "_The manual PR workflow does not run these selectors for the commit under review. Run them from reviewed code on `main`._",
    );
  }

  if (optionalE2e.length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>${compactCount(optionalE2e.length, "optional E2E recommendation")}</summary>`,
      "",
    );
    for (const id of optionalE2e.slice(0, E2E_RENDER_LIMIT)) {
      lines.push(`- <code>${escapeLocationHtml(id)}</code>`);
    }
    if (optionalE2e.length > E2E_RENDER_LIMIT) {
      lines.push(`- _${optionalE2e.length - E2E_RENDER_LIMIT} more._`);
    }
    lines.push("", "</details>");
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function trustedCoverageIds(
  items: unknown,
  inventory: TrustedE2eRecommendationInventory,
): string[] {
  const allowedIds = new Set([
    ...inventory.allowedJobIds,
    ...inventory.manualOnlyJobIds,
    ...inventory.liveSupportedTargetIds,
  ]);
  const seen = new Set<string>();
  const entries = Array.isArray(items) ? items : [];
  return entries.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = item.id;
    if (typeof id !== "string" || !allowedIds.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
}

function trustedTargetIds(
  items: unknown,
  required: boolean,
  inventory: TrustedE2eRecommendationInventory,
  changedCredentialFreeJobIds: ReadonlySet<string>,
): string[] {
  const allowedJobs = new Set([...inventory.allowedJobIds, ...inventory.manualOnlyJobIds]);
  const allowedTargets = new Set(inventory.liveSupportedTargetIds);
  const allowedSelectorTypes = new Set<string>(inventory.selectorTypes);
  const seen = new Set<string>();
  const entries = Array.isArray(items) ? items : [];
  return entries.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = item.id;
    const selectorType = item.selectorType;
    if (
      typeof id !== "string" ||
      typeof selectorType !== "string" ||
      !allowedSelectorTypes.has(selectorType) ||
      item.workflow !== inventory.workflow ||
      item.required !== required
    )
      return [];
    const trustedTuple =
      (selectorType === "all" && id === inventory.fanoutId) ||
      (selectorType === "job" && (allowedJobs.has(id) || changedCredentialFreeJobIds.has(id))) ||
      (selectorType === "target" && allowedTargets.has(id));
    const key = `${selectorType}:${id}`;
    if (!trustedTuple || seen.has(key)) return [];
    seen.add(key);
    return [id];
  });
}

function uniqueE2eIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function trustedChangedCredentialFreeJobIds(result?: ReviewAdvisorResult): Set<string> {
  const ids = new Set<string>();
  const headSha = result?.headSha;
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) return ids;
  const changedFiles = new Set(
    (result.changedFiles ?? []).filter((file): file is string => typeof file === "string"),
  );
  const evidence = result.e2e?.targets?.changedCredentialFreeTests;
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

function renderE2eIds(ids: string[]): string {
  return ids
    .slice(0, E2E_RENDER_LIMIT)
    .map((id) => `<code>${escapeLocationHtml(id)}</code>`)
    .join(", ");
}

function collectFindingRecords(result?: ReviewAdvisorResult): FindingRecord[] {
  return (result?.findings || []).map((finding, index) => ({
    id: `PRA-${index + 1}`,
    finding,
  }));
}

function trustedAdvisorStatus(
  value: unknown,
): { counts: FindingCounts; confidence?: "low" | "medium" | "high" } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.findings)) return undefined;
  const counts: FindingCounts = { blockers: 0, warnings: 0, suggestions: 0 };
  for (const finding of value.findings) {
    if (!isRecord(finding)) continue;
    if (finding.severity === "blocker") counts.blockers += 1;
    else if (finding.severity === "warning") counts.warnings += 1;
    else if (finding.severity === "suggestion") counts.suggestions += 1;
  }
  const summary = isRecord(value.summary) ? value.summary : undefined;
  const confidence = summary?.confidence;
  return {
    counts,
    ...(confidence === "low" || confidence === "medium" || confidence === "high"
      ? { confidence }
      : {}),
  };
}

function unavailableAdvisorReport(): AdvisorReport {
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
  if (blockerCount > 0) return "Blockers require maintainer review";
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

function nextAction(records: FindingRecord[]): string {
  if (records.some((record) => record.finding.severity === "blocker")) {
    return "Review the blockers below.";
  }
  if (records.some((record) => record.finding.severity === "warning")) {
    return "Review the warnings below.";
  }
  if (records.some((record) => record.finding.severity === "suggestion")) {
    return "Consider the suggestions below.";
  }
  return "No advisor follow-up needed.";
}

function buildSecondarySummary(result?: ReviewAdvisorResult): string {
  return "";
}

function renderFindingsDetails(records: FindingRecord[]): string {
  if (records.length === 0) return "";
  const blockerFindings = records.filter((record) => record.finding.severity === "blocker");
  const warningFindings = records.filter((record) => record.finding.severity === "warning");
  const suggestionFindings = records.filter((record) => record.finding.severity === "suggestion");
  const lines: string[] = [];
  if (blockerFindings.length > 0) {
    const displayedBlockerFindings = blockerFindings.slice(0, 20);
    lines.push("", "### Blockers", "");
    for (const record of displayedBlockerFindings) {
      lines.push(formatFinding(record, false), "");
    }
    appendRecommendedRefactoring(lines, displayedBlockerFindings);
  }
  if (warningFindings.length === 0 && suggestionFindings.length === 0)
    return `${lines.join("\n")}\n`;
  lines.push(
    "",
    "<details>",
    `<summary>${countLabel(warningFindings.length, "warning")} · ${countLabel(suggestionFindings.length, "suggestion")}</summary>`,
    "",
  );
  if (warningFindings.length > 0) {
    lines.push("### Warnings", "_Warnings do not block._", "");
    for (const record of warningFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  if (suggestionFindings.length > 0) {
    lines.push("### Suggestions", "_No response is required._", "");
    for (const record of suggestionFindings.slice(0, 20)) lines.push(formatFinding(record), "");
  }
  lines.push("</details>", "");
  return `${lines.join("\n")}\n`;
}

function appendRecommendedRefactoring(lines: string[], records: FindingRecord[]): void {
  const recommendations = records.filter((record) => record.finding.simplification);
  if (recommendations.length === 0) return;
  lines.push(
    "### Recommended refactoring",
    "_Implementation guidance; a fix with equal or lower complexity is acceptable._",
    "",
  );
  for (const record of recommendations) {
    const item = record.finding.simplification;
    if (!item) continue;
    const net =
      typeof item.estimatedNetLines === "number" ? ` Net: ${item.estimatedNetLines} lines.` : "";
    const keep = item.safetyBoundary ? ` Keep: ${escapeCommentText(item.safetyBoundary)}` : "";
    lines.push(
      `- **\`${record.id}\`:** Remove ${escapeCommentText(item.cut || record.finding.title || "the custom path")}; use ${escapeCommentText(item.replacement || "the simpler existing path")}.${net}${keep}`,
    );
  }
  lines.push("");
}

function formatFinding(record: FindingRecord, includeSimplification = true): string {
  const finding = record.finding;
  const title = escapeCommentText(findingTitle(finding));
  const lines = [`#### \`${record.id}\` ${severityLabel(finding.severity)} — ${title}`];
  lines.push(`- **Location:** ${formatInlineLocation(finding) || "not file-specific"}`);
  lines.push(`- **Category:** ${escapeCommentText(finding.category || "uncategorized")}`);
  if (finding.description) lines.push(`- **Problem:** ${escapeCommentText(finding.description)}`);
  if (finding.impact) lines.push(`- **Impact:** ${escapeCommentText(finding.impact)}`);
  if (finding.recommendation) {
    lines.push(
      `- **${findingActionLabel(finding.severity)}:** ${escapeCommentText(finding.recommendation)}`,
    );
  }
  if (finding.verificationHint) {
    lines.push(`- **Verification:** ${escapeCommentText(finding.verificationHint)}`);
  }
  if (finding.missingRegressionTest) {
    lines.push(`- **Test coverage:** ${escapeCommentText(finding.missingRegressionTest)}`);
  }
  if (includeSimplification && finding.simplification) {
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
  if (severity === "suggestion") return "Suggestion";
  return "Review";
}

function findingActionLabel(severity?: string): string {
  if (severity === "blocker") return "Fix";
  if (severity === "suggestion") return "Suggestion";
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
