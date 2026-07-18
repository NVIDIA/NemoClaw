// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure decision and rendering logic for the Brev branch-validation lifecycle
 * (#6962).
 *
 * The workflow embeds four programs — pinned CLI install/auth, failure-bundle
 * collection, retrying instance deletion, and a write-capable PR/check reporter.
 * This module owns the parts that decide and render; the effectful runners in
 * `brev-lifecycle.mts` bind them to `brev`, `ssh`, and `gh`. Keeping the logic
 * pure lets the install/auth branches, `brev ls --json` shape handling,
 * deletion outcomes, result mapping, and stale-head rejection be tested
 * directly rather than by re-parsing YAML.
 *
 * Cleanup and publication must never become target-controlled: this file is
 * loaded only from the trusted workflow revision, so its behavior cannot be
 * altered by the branch under test.
 */

/** Pinned Brev CLI release the workflow installs and checksum-verifies. */
export const BREV_CLI_VERSION = "0.6.324";
export const BREV_CLI_SHA256 = "c7056c17d4810134e3fe7194c233619b1b888a640df1929ea7c6f69c0425e58c";

export function brevCliDownloadUrl(version: string = BREV_CLI_VERSION): string {
  return `https://github.com/brevdev/brev-cli/releases/download/v${version}/brev-cli_${version}_linux_amd64.tar.gz`;
}

export interface BrevAuthInputs {
  apiKey?: string;
  orgId?: string;
  apiToken?: string;
}

export type BrevLoginPlan =
  | { kind: "api-key"; apiKey: string; orgId: string }
  | { kind: "legacy-token"; token: string };

/**
 * Choose how to authenticate the Brev CLI, preserving the workflow's order:
 * API-key/organization login when both are present, otherwise the legacy
 * refresh-token fallback. Empty auth fails closed.
 */
export function selectBrevLogin(inputs: BrevAuthInputs): BrevLoginPlan {
  const apiKey = inputs.apiKey?.trim();
  const orgId = inputs.orgId?.trim();
  if (apiKey && orgId) {
    return { kind: "api-key", apiKey, orgId };
  }
  const token = inputs.apiToken?.trim();
  if (token) {
    return { kind: "legacy-token", token };
  }
  throw new Error("Brev auth is empty — set BREV_API_KEY/BREV_ORG_ID or BREV_API_TOKEN.");
}

/** First-run onboarding suppression file contents (blocks on stdin otherwise). */
export const BREV_ONBOARDING_SUPPRESSION = JSON.stringify({
  step: 1,
  hasRunBrevShell: true,
  hasRunBrevOpen: true,
});

/** Legacy refresh-token credential file contents. */
export function brevLegacyCredentials(token: string): string {
  return JSON.stringify({ refresh_token: token });
}

type BrevListEntry = Record<string, unknown>;

/**
 * Normalize `brev ls --json`, which is an array of instance objects on some CLI
 * versions and `{ workspaces: [...] }` on others. Returns the instance list on a
 * recognized shape, or null when the shape cannot be trusted — the caller then
 * treats absence as unverifiable rather than assuming the instance is gone.
 */
export function normalizeBrevList(json: unknown): BrevListEntry[] | null {
  const isObject = (value: unknown): value is BrevListEntry =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (Array.isArray(json)) {
    return json.every(isObject) ? (json as BrevListEntry[]) : null;
  }
  if (isObject(json)) {
    const workspaces = json.workspaces;
    if (Array.isArray(workspaces) && workspaces.every(isObject)) {
      return workspaces as BrevListEntry[];
    }
  }
  return null;
}

/** Instance name across the CLI's differing field names. */
export function brevInstanceName(entry: BrevListEntry): string {
  for (const key of ["name", "workspaceName", "instanceName", "Name"]) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

export type BrevInstancePresence = "present" | "absent" | "unverifiable";

/**
 * Decide whether `name` is present in a `brev ls --json` payload. An
 * unrecognized payload shape is `unverifiable`, never `absent`, so a garbled
 * list can't be mistaken for a successful teardown.
 */
export function brevInstancePresence(listJson: unknown, name: string): BrevInstancePresence {
  const instances = normalizeBrevList(listJson);
  if (instances === null) return "unverifiable";
  return instances.some((entry) => brevInstanceName(entry) === name) ? "present" : "absent";
}

export type ValidationResult = "success" | "cancelled" | "skipped" | (string & {});

export interface ReportedOutcome {
  conclusion: "success" | "cancelled" | "skipped" | "failure";
  status: "PASSED" | "CANCELLED" | "SKIPPED" | "FAILED";
  emoji: string;
}

/** Map a job result to the check conclusion, human status, and emoji. */
export function classifyValidationResult(result: ValidationResult): ReportedOutcome {
  switch (result) {
    case "success":
      return { conclusion: "success", status: "PASSED", emoji: "✅" };
    case "cancelled":
      return { conclusion: "cancelled", status: "CANCELLED", emoji: "⚪" };
    case "skipped":
      return { conclusion: "skipped", status: "SKIPPED", emoji: "⚪" };
    default:
      return { conclusion: "failure", status: "FAILED", emoji: "❌" };
  }
}

export interface PrCommentInputs {
  outcome: ReportedOutcome;
  testSuite: string;
  branch: string;
  /** Deep link to the validation job when known, else the run (#6978). */
  link: ValidationJobLink;
  keepAlive: boolean;
  instanceName: string;
}

/** Render the PR comment body, including the keep-alive SSH guidance block. */
export function renderBrevPrComment(inputs: PrCommentInputs): string {
  const { outcome, testSuite, branch, link, keepAlive, instanceName } = inputs;
  let body =
    `${outcome.emoji} **Brev E2E** (${testSuite}): **${outcome.status}** ` +
    `on branch \`${branch}\` — [See ${link.linkText}](${link.url})\n`;
  if (keepAlive) {
    body +=
      `\n> **Instance \`${instanceName}\` is still running.** To SSH in:\n` +
      "> ```\n" +
      `> brev refresh && ssh ${instanceName}\n` +
      "> ```\n" +
      `> When done, delete it: \`brev delete ${instanceName}\`\n`;
  }
  return body;
}

const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

/** Upper bound the jobs listing is fetched with (`per_page=100`). */
const MAX_LISTED_JOBS = 100;

export interface ValidationJobLink {
  url: string;
  linkText: string;
}

export interface ResolveValidationJobUrlInputs {
  jobsJson: unknown;
  runId: string;
  runAttempt: string;
  runUrl: string;
  testSuite: string;
  validationResult: string;
}

/**
 * Resolve the deep link for the check's `details_url` (#6978): the validation
 * job's own URL when it can be identified unambiguously, otherwise the run URL.
 *
 * The listing is treated as untrusted input, mirroring the jq guard this
 * replaced: the payload must be internally consistent (a bounded `total_count`
 * matching the `jobs` length), each candidate must belong to this exact run and
 * attempt, and exactly one job may match. Anything else falls back to the run
 * URL rather than linking somewhere misleading.
 */
export function resolveValidationJobUrl(inputs: ResolveValidationJobUrlInputs): ValidationJobLink {
  const fallback: ValidationJobLink = { url: inputs.runUrl, linkText: "workflow run" };
  if (!PR_NUMBER_PATTERN.test(inputs.runId) || !PR_NUMBER_PATTERN.test(inputs.runAttempt)) {
    return fallback;
  }
  const payload = inputs.jobsJson;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fallback;

  const { total_count: totalCount, jobs } = payload as { total_count?: unknown; jobs?: unknown };
  if (
    typeof totalCount !== "number" ||
    !Number.isInteger(totalCount) ||
    totalCount < 0 ||
    totalCount > MAX_LISTED_JOBS ||
    !Array.isArray(jobs) ||
    jobs.length !== totalCount
  ) {
    return fallback;
  }

  const runId = Number(inputs.runId);
  const runAttempt = Number(inputs.runAttempt);
  const acceptedNames = new Set([
    "e2e-branch-validation",
    `brev-nightly-e2e (${inputs.testSuite}) / e2e-branch-validation`,
    ...(inputs.testSuite === "dashboard-remote-bind"
      ? ["dashboard-remote-bind-e2e / e2e-branch-validation"]
      : []),
  ]);

  const matches = (jobs as unknown[]).filter((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const job = entry as Record<string, unknown>;
    return (
      typeof job.id === "number" &&
      Number.isInteger(job.id) &&
      job.id > 0 &&
      job.id <= Number.MAX_SAFE_INTEGER &&
      job.run_id === runId &&
      job.run_attempt === runAttempt &&
      typeof job.name === "string" &&
      acceptedNames.has(job.name) &&
      job.status === "completed" &&
      job.conclusion === inputs.validationResult
    );
  });
  if (matches.length !== 1) return fallback;

  const id = (matches[0] as { id: number }).id;
  return { url: `${inputs.runUrl}/job/${id}`, linkText: "validation job" };
}

/** Validate a PR number the same way the workflow's guard did. */
export function assertPrNumber(value: string | undefined): string {
  if (!value || !PR_NUMBER_PATTERN.test(value)) {
    throw new Error("pr_number must be a positive integer");
  }
  return value;
}

/**
 * Refuse to publish stale evidence: the tested SHA must still be the PR head.
 * Both must be full 40-hex commit SHAs.
 */
export function assertTestedShaCurrent(currentSha: string, testedSha: string): void {
  if (!SHA_PATTERN.test(testedSha)) {
    throw new Error("tested SHA is not a valid commit id; refusing to report");
  }
  if (!SHA_PATTERN.test(currentSha)) {
    throw new Error("PR head SHA is not a valid commit id; refusing to report");
  }
  if (currentSha !== testedSha) {
    throw new Error("PR head moved after Brev validation; refusing to report stale evidence");
  }
}

const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const RUN_IDENTIFIER_PATTERN = /^[0-9]+$/u;
const RELATIVE_DIR_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u;

/**
 * Validate an instance name before it becomes ssh/scp/brev argv. A leading
 * "-" would be parsed as an option (ssh -oProxyCommand=... executes commands),
 * so names must start with an alphanumeric and stay within the shape the
 * workflow generates (e2e-<pr>-<suite>-<run id>-<run attempt>).
 */
export function assertInstanceName(value: string | undefined): string {
  if (!value || !INSTANCE_NAME_PATTERN.test(value)) {
    throw new Error(
      "instance name must start alphanumeric and contain only [A-Za-z0-9._-]",
    );
  }
  return value;
}

/** Validate an owner/repo slug before it is spliced into gh api paths. */
export function assertRepository(value: string | undefined): string {
  if (!value || !REPOSITORY_PATTERN.test(value)) {
    throw new Error("repository must be an owner/name slug");
  }
  return value;
}

/** Validate a numeric run identifier; empty stays empty for URL fallback. */
export function assertRunIdentifier(value: string, field: string): string {
  if (value !== "" && !RUN_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${field} must be a decimal run identifier`);
  }
  return value;
}

/** Validate a debug-bundle destination as a plain relative directory path. */
export function assertRelativeDirPath(value: string): string {
  if (!RELATIVE_DIR_PATTERN.test(value) || value.includes("..")) {
    throw new Error(
      "destination directory must be a relative path without traversal and must not start with '-'",
    );
  }
  return value;
}
