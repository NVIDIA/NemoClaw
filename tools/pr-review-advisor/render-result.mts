// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const E2E_RENDER_LIMIT = 20;

type RenderTerminologyReview = {
  status: string;
  decisions: ReadonlyArray<{
    disposition: string;
    term: string;
    source: { file: string; line: number };
    recommendation: string;
  }>;
  noChangesReason: string | null;
};

type RenderFinding = {
  severity: "blocker" | "warning" | "suggestion";
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  impact: string;
  recommendation: string;
  verificationHint: string;
  missingRegressionTest: string;
  evidence: string;
};

type RenderE2eResult = {
  coverage: {
    [key: string]: unknown;
    requiredTests: Array<{ id: string }>;
    optionalTests: Array<{ id: string }>;
  };
  targets: {
    [key: string]: unknown;
    required: Array<{ id: string }>;
    optional: Array<{ id: string }>;
  };
};

type ReviewAdvisorRenderResult = {
  [key: string]: unknown;
  summary: { oneLine: string; [key: string]: unknown };
  findings: RenderFinding[];
  terminologyReview: RenderTerminologyReview;
  acceptanceCoverage: Array<{ clause: string; status: string; evidence: string }>;
  securityCategories: Array<{ category: string; verdict: string; justification: string }>;
  sourceOfTruthReview: Array<{
    surface: string;
    status: string;
    invalidState: string;
    sourceBoundary: string;
    whyNotSourceFix: string;
    regressionTest: string;
    removalCondition: string;
    evidence: string;
  }>;
  e2e: RenderE2eResult;
  positives: string[];
};

export function renderSummary(result: ReviewAdvisorRenderResult): string {
  const blockers = result.findings.filter((finding) => finding.severity === "blocker");
  const warnings = result.findings.filter((finding) => finding.severity === "warning");
  const suggestions = result.findings.filter((finding) => finding.severity === "suggestion");
  const lines: string[] = [];
  lines.push("# PR Review Advisor");
  lines.push("");
  lines.push(result.summary.oneLine);
  lines.push("");
  appendFindings(lines, "Blockers", blockers);
  appendFindings(lines, "Warnings", warnings);
  appendFindings(lines, "Suggestions", suggestions);
  appendTerminologySummary(lines, result.terminologyReview);
  lines.push("## What looks good");
  if (result.positives.length === 0) {
    lines.push("- _No positives were identified by the advisor._");
  } else {
    for (const positive of result.positives.slice(0, 10)) lines.push(`- ${positive}`);
  }
  lines.push("");
  appendE2eSummary(lines, result.e2e);

  return `${lines.join("\n")}\n`;
}

function appendTerminologySummary(lines: string[], review: RenderTerminologyReview): void {
  lines.push("## Terminology review");
  if (review.status === "limited") {
    lines.push(
      `- _Limited: ${review.noChangesReason || "The terminology review did not complete."}_`,
    );
  } else if (review.decisions.length === 0) {
    lines.push(
      `- _${review.noChangesReason || "No semantic terminology candidates were selected."}_`,
    );
  } else {
    for (const decision of review.decisions.slice(0, 10)) {
      lines.push(
        `- **${decision.disposition} — ${decision.term}** (${decision.source.file}:${decision.source.line}): ${decision.recommendation}`,
      );
    }
  }
  lines.push("");
}

function appendE2eSummary(lines: string[], e2e: RenderE2eResult): void {
  const required = combinedE2eIds(e2e.targets.required, e2e.coverage.requiredTests);
  const optional = combinedE2eIds(e2e.targets.optional, e2e.coverage.optionalTests);

  lines.push("## Recommended E2E");
  if (required.length === 0) {
    lines.push("- _None._");
  } else {
    for (const id of required.slice(0, E2E_RENDER_LIMIT)) {
      lines.push(`- **${id}**`);
    }
    if (required.length > E2E_RENDER_LIMIT) {
      lines.push(`- _${required.length - E2E_RENDER_LIMIT} more._`);
    }
  }
  lines.push("");
  lines.push("## Optional E2E");
  if (optional.length === 0) {
    lines.push("- _None._");
  } else {
    for (const id of optional.slice(0, E2E_RENDER_LIMIT)) {
      lines.push(`- **${id}**`);
    }
    if (optional.length > E2E_RENDER_LIMIT) {
      lines.push(`- _${optional.length - E2E_RENDER_LIMIT} more._`);
    }
  }
  lines.push("");
}

function combinedE2eIds(targets: Array<{ id: string }>, coverage: Array<{ id: string }>): string[] {
  return [...new Set([...targets.map(({ id }) => id), ...coverage.map(({ id }) => id)])];
}

export function renderDetailedReview(result: ReviewAdvisorRenderResult): string {
  const lines = renderSummary(result).trimEnd().split("\n");
  lines.push("");
  lines.push("## Acceptance coverage");
  if (result.acceptanceCoverage.length === 0) {
    lines.push("- _No linked acceptance clauses were analyzed._");
  } else {
    for (const clause of result.acceptanceCoverage.slice(0, 100)) {
      lines.push(`- **${clause.status}** — ${clause.clause}: ${clause.evidence}`);
    }
  }
  lines.push("");
  lines.push("## Security review");
  for (const category of result.securityCategories.slice(0, 20)) {
    lines.push(`- **${category.verdict}** — ${category.category}: ${category.justification}`);
  }
  lines.push("");
  lines.push("## Source-of-truth review");
  if (result.sourceOfTruthReview.length === 0) {
    lines.push("- _No localized patch or workaround surfaces were analyzed._");
  } else {
    for (const review of result.sourceOfTruthReview.slice(0, 50)) {
      lines.push(`- **${review.status}** — ${review.surface}: ${review.evidence}`);
      lines.push(`  - Invalid state: ${review.invalidState}`);
      lines.push(`  - Source boundary: ${review.sourceBoundary}`);
      lines.push(`  - Why not source fix: ${review.whyNotSourceFix}`);
      lines.push(`  - Regression test: ${review.regressionTest}`);
      lines.push(`  - Removal condition: ${review.removalCondition}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendFindings(lines: string[], heading: string, findings: RenderFinding[]): void {
  lines.push(`## ${heading}`);
  if (findings.length === 0) {
    lines.push("- _None._");
  } else {
    for (const finding of findings.slice(0, 20)) {
      const location = finding.file
        ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
        : "";
      lines.push(`- **${finding.title}**${location}: ${finding.description}`);
      lines.push(`  - Impact: ${finding.impact}`);
      lines.push(`  - Recommendation: ${finding.recommendation}`);
      lines.push(`  - Verification hint: ${finding.verificationHint}`);
      lines.push(`  - Missing regression test: ${finding.missingRegressionTest}`);
      lines.push(`  - Evidence: ${finding.evidence}`);
    }
    if (findings.length > 20) {
      lines.push(`- _${findings.length - 20} more ${heading.toLowerCase()} were omitted._`);
    }
  }
  lines.push("");
}
