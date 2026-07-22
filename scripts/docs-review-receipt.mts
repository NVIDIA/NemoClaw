// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate documentation writer review receipts and report their adoption.
 *
 * The check command reads one pull_request event and its changed paths.
 * The report command reads pull requests through the authenticated gh CLI.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

type ReviewResult = "blocked" | "docs-updated" | "no-docs-needed";
type ReceiptStatus = "invalid" | "missing" | "not-required" | "unclassified" | "valid";

interface ChangeClassification {
  codeChanged: boolean | null;
  docsChanged: boolean | null;
}

interface ParsedReceipt {
  agent: string | null;
  agentsBlobSha: string | null;
  completed: boolean;
  duplicateFields: string[];
  duplicateSections: boolean;
  evidence: string | null;
  prNumber: number | null;
  present: boolean;
  result: ReviewResult | null;
  reviewedHeadSha: string | null;
}

interface ReceiptRecord {
  agent: string | null;
  agentsBlobSha: string | null;
  agentsShaMatches: boolean | null;
  codeChanged: boolean | null;
  docsChanged: boolean | null;
  evidence: string | null;
  headShaMatches: boolean | null;
  issues: string[];
  prNumber: number | null;
  prNumberMatches: boolean | null;
  result: ReviewResult | null;
  reviewedHeadSha: string | null;
  status: ReceiptStatus;
}

interface PullRequestEvent {
  pull_request?: {
    body?: string | null;
    head?: { sha?: string };
    html_url?: string;
    number?: number;
  };
}

interface GhPullRequest {
  author: { login: string } | null;
  body: string;
  createdAt: string;
  headRefOid: string;
  isDraft: boolean;
  mergedAt: string | null;
  number: number;
  state: string;
  url: string;
}

interface ReportRecord extends ReceiptRecord {
  author: string | null;
  createdAt: string;
  headPrSha: string;
  isDraft: boolean;
  mergedAt: string | null;
  number: number;
  state: string;
  url: string;
}

const RESULTS = new Set<ReviewResult>(["blocked", "docs-updated", "no-docs-needed"]);
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    runCheck(args);
    return;
  }
  if (command === "report") {
    runReport(args);
    return;
  }
  throw new Error("Usage: docs-review-receipt.mts <check|report> [options]");
}

function runCheck(args: string[]): void {
  const eventPath = requireOption(args, "--event");
  const changedFilesPath = requireOption(args, "--changed-files");
  const expectedAgentsBlob = requireOption(args, "--agents-blob");
  const mode = optionalOption(args, "--mode") ?? "advisory";
  if (mode !== "advisory" && mode !== "required") {
    throw new Error(`Invalid --mode value: ${mode}`);
  }

  const event = readJson<PullRequestEvent>(eventPath);
  const pullRequest = event.pull_request;
  const headPrSha = pullRequest?.head?.sha;
  if (!pullRequest || !headPrSha || !SHA_PATTERN.test(headPrSha)) {
    throw new Error("The event file does not contain a valid pull request head SHA");
  }

  const changedFiles = readLines(changedFilesPath);
  const record = evaluateReceipt(
    pullRequest.body ?? "",
    classifyChangedFiles(changedFiles),
    pullRequest.number ?? null,
    headPrSha,
    expectedAgentsBlob,
  );
  const output = {
    type: "documentation-writer-review-receipt",
    pr: pullRequest.number ?? null,
    url: pullRequest.html_url ?? null,
    headPrSha,
    ...record,
  };
  console.log(JSON.stringify(output));
  writeStepSummary(output);

  if (record.status === "missing" || record.status === "invalid") {
    for (const issue of record.issues) {
      console.error(
        `::warning title=Documentation writer review receipt::${escapeAnnotation(issue)}`,
      );
    }
    if (mode === "required") process.exitCode = 1;
  }
}

function runReport(args: string[]): void {
  const repository = optionalOption(args, "--repo") ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid --repo value: ${repository}`);
  }
  const since = requireOption(args, "--since");
  const sinceDate = parseDate(since, "--since");
  const through = optionalOption(args, "--until") ?? new Date().toISOString().slice(0, 10);
  const throughDate = parseDate(through, "--until");
  if (sinceDate > throughDate) throw new Error("--since must not be later than --until");
  const format = optionalOption(args, "--format") ?? "json";
  if (format !== "csv" && format !== "json" && format !== "summary") {
    throw new Error(`Invalid --format value: ${format}`);
  }

  const pullRequests = listPullRequests(repository, sinceDate, throughDate);
  const records = pullRequests.map(toReportRecord);
  const report = buildReport(repository, since, through, records);

  if (format === "csv") {
    process.stdout.write(renderCsv(records));
  } else if (format === "summary") {
    const { records: _records, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

function evaluateReceipt(
  body: string,
  changes: ChangeClassification,
  expectedPrNumber: number | null,
  headPrSha: string,
  expectedAgentsBlob?: string,
): ReceiptRecord {
  const parsed = parseReceipt(body);
  const { codeChanged, docsChanged } = changes;
  const issues: string[] = [];

  if (codeChanged === null) {
    issues.push("The PR description does not select one code or documentation-only change type.");
    return {
      agent: parsed.agent,
      agentsBlobSha: parsed.agentsBlobSha,
      agentsShaMatches: null,
      codeChanged,
      docsChanged,
      evidence: parsed.evidence,
      headShaMatches: null,
      issues,
      prNumber: parsed.prNumber,
      prNumberMatches: null,
      result: parsed.result,
      reviewedHeadSha: parsed.reviewedHeadSha,
      status: "unclassified",
    };
  }

  if (!codeChanged) {
    return {
      agent: parsed.agent,
      agentsBlobSha: parsed.agentsBlobSha,
      agentsShaMatches: null,
      codeChanged,
      docsChanged,
      evidence: parsed.evidence,
      headShaMatches: null,
      issues,
      prNumber: parsed.prNumber,
      prNumberMatches: null,
      result: parsed.result,
      reviewedHeadSha: parsed.reviewedHeadSha,
      status: "not-required",
    };
  }

  if (!parsed.present) {
    issues.push("Code-changing PRs must include the Documentation Writer Review section.");
  } else {
    if (parsed.duplicateSections) {
      issues.push("The PR description contains more than one Documentation Writer Review section.");
    }
    if (parsed.duplicateFields.length > 0) {
      issues.push(
        `The Documentation Writer Review section repeats singleton fields: ${parsed.duplicateFields.join(", ")}.`,
      );
    }
    if (!parsed.completed) {
      issues.push("Mark the documentation writer subagent review as completed.");
    }
    if (!parsed.result) {
      issues.push("Keep exactly one result: docs-updated, no-docs-needed, or blocked.");
    }
    if (!parsed.evidence || looksLikePlaceholder(parsed.evidence)) {
      issues.push("Add documentation review evidence or a no-docs-needed rationale.");
    }
    if (!parsed.agent || looksLikePlaceholder(parsed.agent)) {
      issues.push("Record the agent surface that ran the documentation writer review.");
    }
    if (parsed.prNumber === null) {
      issues.push("Record this pull request number in the documentation review receipt.");
    }
    if (!parsed.reviewedHeadSha) {
      issues.push("Refresh the hidden head SHA after the documentation writer review.");
    }
    if (!parsed.agentsBlobSha) {
      issues.push("Record a valid AGENTS.md blob SHA with 7 to 40 hexadecimal characters.");
    }
    if (parsed.result === "docs-updated" && docsChanged !== true) {
      issues.push("The docs-updated result requires a changed Markdown or docs/ file.");
    }
  }

  const prNumberMatches =
    parsed.prNumber !== null && expectedPrNumber !== null
      ? parsed.prNumber === expectedPrNumber
      : null;
  if (prNumberMatches === false) {
    issues.push("The receipt PR number does not match this pull request.");
  }

  const headShaMatches = parsed.reviewedHeadSha
    ? headPrSha.toLowerCase().startsWith(parsed.reviewedHeadSha)
    : null;
  if (headShaMatches === false) {
    issues.push("The documentation writer review is stale after a new implementation commit.");
  }

  const normalizedAgentsBlob = expectedAgentsBlob?.trim().toLowerCase();
  const agentsShaMatches =
    parsed.agentsBlobSha && normalizedAgentsBlob
      ? normalizedAgentsBlob.startsWith(parsed.agentsBlobSha)
      : null;
  if (agentsShaMatches === false) {
    issues.push("The reviewed AGENTS.md blob SHA does not match the pull request version.");
  }

  return {
    agent: parsed.agent,
    agentsBlobSha: parsed.agentsBlobSha,
    agentsShaMatches,
    codeChanged,
    docsChanged,
    evidence: parsed.evidence,
    headShaMatches,
    issues,
    prNumber: parsed.prNumber,
    prNumberMatches,
    result: parsed.result,
    reviewedHeadSha: parsed.reviewedHeadSha,
    status: parsed.present ? (issues.length === 0 ? "valid" : "invalid") : "missing",
  };
}

function parseReceipt(body: string): ParsedReceipt {
  const headingPattern = /^## Documentation Writer Review\s*$/gmu;
  const matches = [...body.matchAll(headingPattern)];
  if (matches.length === 0) {
    return {
      agent: null,
      agentsBlobSha: null,
      completed: false,
      duplicateFields: [],
      duplicateSections: false,
      evidence: null,
      prNumber: null,
      present: false,
      result: null,
      reviewedHeadSha: null,
    };
  }

  const first = matches[0];
  const start = (first.index ?? 0) + first[0].length;
  const remaining = body.slice(start);
  const nextHeading = /^##\s+/mu.exec(remaining);
  const section = remaining.slice(0, nextHeading?.index ?? remaining.length);
  const lines = section.split(/\r?\n/u).map((line) => line.trim());
  const reviewCheckboxPattern =
    /^- \[[ xX]\] Documentation writer subagent reviewed the completed implementation$/u;
  const completionPattern =
    /^- \[[xX]\] Documentation writer subagent reviewed the completed implementation$/u;
  const duplicateFields = ["Result", "Evidence", "Agent", "PR"].filter(
    (name) => fieldValues(lines, name).length > 1,
  );
  for (const name of ["docs-review-head-sha", "docs-review-agents-blob-sha"]) {
    if (hiddenFieldValues(lines, name).length > 1) duplicateFields.push(name);
  }
  if (lines.filter((line) => reviewCheckboxPattern.test(line)).length > 1) {
    duplicateFields.push("review completion checkbox");
  }
  const resultValue = fieldValue(lines, "Result");
  const resultMatch = resultValue?.match(/^`(blocked|docs-updated|no-docs-needed)`$/u);
  const result =
    resultMatch && RESULTS.has(resultMatch[1] as ReviewResult)
      ? (resultMatch[1] as ReviewResult)
      : null;
  const prNumber = parsePrNumber(fieldValue(lines, "PR"));
  const reviewedHeadSha = parseSha(hiddenFieldValue(lines, "docs-review-head-sha"));
  const agentsBlobSha = parseSha(hiddenFieldValue(lines, "docs-review-agents-blob-sha"));

  return {
    agent: nonEmpty(fieldValue(lines, "Agent")),
    agentsBlobSha,
    completed: lines.some((line) => completionPattern.test(line)),
    duplicateFields,
    duplicateSections: matches.length > 1,
    evidence: nonEmpty(fieldValue(lines, "Evidence")),
    prNumber,
    present: true,
    result,
    reviewedHeadSha,
  };
}

function fieldValue(lines: string[], name: string): string | null {
  return fieldValues(lines, name)[0] ?? null;
}

function fieldValues(lines: string[], name: string): string[] {
  const prefix = `- ${name}:`;
  return lines
    .filter((candidate) => candidate.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

function hiddenFieldValue(lines: string[], name: string): string | null {
  return hiddenFieldValues(lines, name)[0] ?? null;
}

function hiddenFieldValues(lines: string[], name: string): string[] {
  const prefix = `<!-- ${name}:`;
  const suffix = "-->";
  return lines
    .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix))
    .map((line) => line.slice(prefix.length, -suffix.length).trim());
}

function parsePrNumber(value: string | null): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^#[1-9]\d*$/u.test(normalized)) return null;
  return Number(normalized.slice(1));
}

function parseSha(value: string | null): string | null {
  const normalized = value?.replace(/^`|`$/gu, "").trim().toLowerCase();
  return normalized && SHA_PATTERN.test(normalized) ? normalized : null;
}

function nonEmpty(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function looksLikePlaceholder(value: string): boolean {
  return /[<>|]/u.test(value);
}

function toReportRecord(pullRequest: GhPullRequest): ReportRecord {
  return {
    author: pullRequest.author?.login ?? null,
    createdAt: pullRequest.createdAt,
    headPrSha: pullRequest.headRefOid,
    isDraft: pullRequest.isDraft,
    mergedAt: pullRequest.mergedAt,
    number: pullRequest.number,
    state: pullRequest.state,
    url: pullRequest.url,
    ...evaluateReceipt(
      pullRequest.body ?? "",
      classifyPrType(pullRequest.body ?? ""),
      pullRequest.number,
      pullRequest.headRefOid,
    ),
  };
}

function classifyChangedFiles(changedFiles: string[]): ChangeClassification {
  return {
    codeChanged: changedFiles.some(isCodeFile),
    docsChanged: changedFiles.some(isDocumentationFile),
  };
}

function classifyPrType(body: string): ChangeClassification {
  const checked = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^- \[[xX]\] /u.test(line));
  const codeOnly = checked.some(
    (line) => line.startsWith("- [x] Code change (") || line.startsWith("- [X] Code change ("),
  );
  const codeWithDocs = checked.some((line) =>
    /^- \[[xX]\] Code change with doc updates$/u.test(line),
  );
  const docsOnly = checked.some((line) => /^- \[[xX]\] Doc only \(/u.test(line));

  if ((codeOnly || codeWithDocs) && !docsOnly) {
    return { codeChanged: true, docsChanged: codeWithDocs };
  }
  if (docsOnly && !codeOnly && !codeWithDocs) {
    return { codeChanged: false, docsChanged: true };
  }
  return { codeChanged: null, docsChanged: null };
}

function isCodeFile(file: string): boolean {
  return !isDocumentationFile(file);
}

function isDocumentationFile(file: string): boolean {
  const lower = file.toLowerCase();
  return file.startsWith("docs/") || lower.endsWith(".md") || lower.endsWith(".mdx");
}

function listPullRequests(repository: string, since: Date, through: Date): GhPullRequest[] {
  const pullRequests = queryPullRequestRange(repository, since, through);
  if (pullRequests.length < 1000) return pullRequests;
  if (formatDate(since) === formatDate(through)) {
    throw new Error(`The ${formatDate(since)} report reached GitHub's 1000-PR search limit.`);
  }

  const rangeDays = Math.floor((through.getTime() - since.getTime()) / 86_400_000);
  const midpoint = new Date(since.getTime() + Math.floor(rangeDays / 2) * 86_400_000);
  const nextDay = new Date(midpoint.getTime() + 86_400_000);
  return [
    ...listPullRequests(repository, since, midpoint),
    ...listPullRequests(repository, nextDay, through),
  ];
}

function queryPullRequestRange(repository: string, since: Date, through: Date): GhPullRequest[] {
  return ghJsonArray<GhPullRequest>([
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "all",
    "--limit",
    "1000",
    "--search",
    `created:${formatDate(since)}..${formatDate(through)}`,
    "--json",
    "number,url,state,isDraft,author,createdAt,mergedAt,headRefOid,body",
  ]);
}

function parseDate(value: string, option: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`Invalid ${option} value: ${value}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDate(parsed) !== value) {
    throw new Error(`Invalid ${option} value: ${value}`);
  }
  return parsed;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function buildReport(repository: string, since: string, through: string, records: ReportRecord[]) {
  const eligible = records.filter((record) => record.codeChanged);
  const unclassified = records.filter((record) => record.codeChanged === null);
  const recorded = eligible.filter((record) => record.status !== "missing");
  const valid = eligible.filter((record) => record.status === "valid");
  const fresh = recorded.filter(
    (record) => record.prNumberMatches === true && record.headShaMatches === true,
  );
  const resultCounts: Record<ReviewResult, number> = {
    blocked: 0,
    "docs-updated": 0,
    "no-docs-needed": 0,
  };
  const agentCounts: Record<string, number> = {};
  for (const record of valid) {
    if (record.result) resultCounts[record.result] += 1;
    if (record.agent) {
      const agent = record.agent.toLowerCase();
      agentCounts[agent] = (agentCounts[agent] ?? 0) + 1;
    }
  }

  return {
    repository,
    since,
    through,
    metrics: {
      totalPrs: records.length,
      eligibleCodePrs: eligible.length,
      unclassifiedPrs: unclassified.length,
      recordedReceipts: recorded.length,
      receiptCoverage: ratio(recorded.length, eligible.length),
      validReceipts: valid.length,
      validReceiptRate: ratio(valid.length, eligible.length),
      freshReceipts: fresh.length,
      freshReceiptRate: ratio(fresh.length, recorded.length),
      results: resultCounts,
      agents: agentCounts,
    },
    records,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function renderCsv(records: ReportRecord[]): string {
  const headers = [
    "number",
    "url",
    "state",
    "is_draft",
    "author",
    "created_at",
    "merged_at",
    "code_changed",
    "docs_changed",
    "receipt_status",
    "result",
    "agent",
    "receipt_pr_number",
    "pr_number_matches",
    "reviewed_head_sha",
    "head_pr_sha",
    "head_sha_matches",
    "agents_blob_sha",
    "evidence",
    "issues",
  ];
  const rows = records.map((record) => [
    record.number,
    record.url,
    record.state,
    record.isDraft,
    record.author,
    record.createdAt,
    record.mergedAt,
    record.codeChanged,
    record.docsChanged,
    record.status,
    record.result,
    record.agent,
    record.prNumber,
    record.prNumberMatches,
    record.reviewedHeadSha,
    record.headPrSha,
    record.headShaMatches,
    record.agentsBlobSha,
    record.evidence,
    record.issues.join("; "),
  ]);
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: boolean | number | string | null): string {
  const text = value === null ? "" : String(value);
  const formulaSafe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return /[",\n\r]/u.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

function writeStepSummary(output: {
  headPrSha: string;
  pr: number | null;
  status: ReceiptStatus;
  result: ReviewResult | null;
  agent: string | null;
  issues: string[];
}): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "## Documentation writer review receipt",
    "",
    `- PR: ${output.pr === null ? "unknown" : `#${output.pr}`}`,
    `- Head PR SHA: \`${output.headPrSha.slice(0, 12)}\``,
    `- Status: \`${output.status}\``,
    `- Result: ${output.result ? `\`${output.result}\`` : "not recorded"}`,
    `- Agent: ${output.agent ?? "not recorded"}`,
  ];
  if (output.issues.length > 0) {
    lines.push("", "### Advisory findings", "");
    for (const issue of output.issues) lines.push(`- ${issue}`);
  }
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function readLines(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function optionalOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function ghJsonArray<T>(args: string[]): T[] {
  let output: string;
  try {
    output = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const details = readErrorText(error);
    throw new Error([`gh ${args.join(" ")} failed`, details].filter(Boolean).join("\n"));
  }
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("GitHub CLI did not return a JSON array");
  return parsed as T[];
}

function readErrorText(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const stderr = Reflect.get(error, "stderr");
  return typeof stderr === "string" ? stderr.trim() : null;
}

function escapeAnnotation(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
