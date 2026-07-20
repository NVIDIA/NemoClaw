// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";

const COORDINATION_CHECK_NAME = "E2E / PR Gate Coordination";
const LEGACY_COORDINATION_CHECK_NAME = "E2E / PR Gate";
const EXTERNAL_ID_PREFIX = "nemoclaw-pr-e2e:v2";
const RETRYABLE_FAILURE_MARKER_PREFIX = "<!-- nemoclaw-pr-e2e-retry:v1:";
const RETRYABLE_FAILURE_MARKER_SUFFIX = " -->";
const RETRYABLE_FAILURE_REASONS = new Set([
  "prerequisite-ci",
  "child-cancelled",
  "evidence-download",
]);
const NEVER_RETRY_FAILURE_TITLES = new Set([
  "Authorized E2E run requires reconciliation",
  "PR base changed",
  "Controller stopped early",
  "Run could not start",
]);
const GITHUB_ACTIONS_APP_ID = 15368;
const USER_AGENT = "nemoclaw-pr-e2e-required";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const AUTHORIZATION_TITLES = new Set(["Maintainer approval required to skip credentialed E2E"]);
const MAX_LOG_URLS = 20;

type CheckConclusion = "success" | "failure" | "cancelled";

export type CoordinationCheckRun = {
  id: number;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  output?: { summary?: string | null; title?: string | null };
  app?: { id?: number } | null;
};

type CheckRunsResponse = {
  total_count: number;
  check_runs: CoordinationCheckRun[];
};

type PullRequest = {
  number: number;
  state: string;
  head: { sha: string };
  base: { sha: string };
};

export type RequiredGateIdentity = {
  repository: string;
  token: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
};

export type RequiredGateResult = {
  conclusion: CheckConclusion;
  title: string;
  detailsUrl?: string;
  logUrls?: string[];
};

type WaitingGateResult = {
  state: "waiting";
  description: string;
  detailsUrl?: string;
  logUrls?: string[];
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const input = requiredArgument(value, name);
  if (!/^[1-9][0-9]*$/u.test(input)) throw new Error(`--${name} must be a positive integer`);
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} exceeds the safe integer range`);
  return parsed;
}

function assertIdentity(identity: RequiredGateIdentity): void {
  if (!REPOSITORY_PATTERN.test(identity.repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository name");
  }
  if (!identity.token) throw new Error("GITHUB_TOKEN is required");
  if (!Number.isSafeInteger(identity.prNumber) || identity.prNumber < 1) {
    throw new Error("PR number is invalid");
  }
  if (!SHA_PATTERN.test(identity.headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(identity.baseSha)) throw new Error("PR base SHA is invalid");
}

export function coordinationExternalId(prNumber: number, headSha: string, baseSha: string): string {
  return `${EXTERNAL_ID_PREFIX}:${prNumber}:${headSha}:${baseSha}`;
}

function validateCheckRunsResponse(value: unknown): CheckRunsResponse {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.check_runs) ||
    value.check_runs.length !== value.total_count
  ) {
    throw new Error("GitHub returned an invalid or incomplete coordination check listing");
  }
  for (const check of value.check_runs) {
    if (
      !isObjectRecord(check) ||
      !Number.isSafeInteger(check.id) ||
      (check.id as number) < 1 ||
      typeof check.name !== "string" ||
      typeof check.head_sha !== "string" ||
      (check.external_id !== null && typeof check.external_id !== "string")
    ) {
      throw new Error("GitHub returned an invalid coordination check");
    }
  }
  return value as CheckRunsResponse;
}

function validatePullRequest(value: unknown, identity: RequiredGateIdentity): PullRequest {
  if (
    !isObjectRecord(value) ||
    value.number !== identity.prNumber ||
    value.state !== "open" ||
    !isObjectRecord(value.head) ||
    value.head.sha !== identity.headSha ||
    !isObjectRecord(value.base) ||
    value.base.sha !== identity.baseSha
  ) {
    throw new Error("PR is not the expected open PR with the observed PR SHA and base SHA");
  }
  return value as PullRequest;
}

async function requireExactPullRequest(identity: RequiredGateIdentity): Promise<void> {
  validatePullRequest(
    await githubApi<unknown>(
      `repos/${identity.repository}/pulls/${identity.prNumber}`,
      identity.token,
      { userAgent: USER_AGENT },
    ),
    identity,
  );
}

function hasRetryableFailureMarker(check: CoordinationCheckRun): boolean {
  if (check.status !== "completed" || check.conclusion !== "failure") return false;
  if (NEVER_RETRY_FAILURE_TITLES.has(check.output?.title ?? "")) return false;
  const summary = check.output?.summary;
  if (typeof summary !== "string") return false;
  const markerBoundary = `\n\n${RETRYABLE_FAILURE_MARKER_PREFIX}`;
  const markerStart = summary.lastIndexOf(markerBoundary);
  if (markerStart < 0) return false;
  const marker = summary.slice(markerStart + 2);
  if (!marker.endsWith(RETRYABLE_FAILURE_MARKER_SUFFIX)) return false;
  const reason = marker.slice(
    RETRYABLE_FAILURE_MARKER_PREFIX.length,
    -RETRYABLE_FAILURE_MARKER_SUFFIX.length,
  );
  return (
    RETRYABLE_FAILURE_REASONS.has(reason) &&
    marker === `${RETRYABLE_FAILURE_MARKER_PREFIX}${reason}${RETRYABLE_FAILURE_MARKER_SUFFIX}`
  );
}

function currentCoordinationCheck(
  checks: CoordinationCheckRun[],
): CoordinationCheckRun | undefined {
  if (checks.length === 0) return undefined;
  const ordered = [...checks].sort((left, right) => left.id - right.id);
  if (new Set(ordered.map((check) => check.id)).size !== ordered.length) {
    throw new Error("Duplicate coordination check IDs exist for one PR/base SHA pair");
  }
  const active = ordered.filter((check) => check.status !== "completed");
  if (active.length > 1)
    throw new Error("Multiple active coordination checks exist for one PR/base SHA pair");
  if (ordered.slice(0, -1).some((check) => !hasRetryableFailureMarker(check))) {
    throw new Error(
      "Coordination history contains a non-retryable older check for one PR/base SHA pair",
    );
  }
  const current = ordered.at(-1)!;
  if (active[0] && active[0].id !== current.id) {
    throw new Error("Coordination history for one PR/base SHA pair contains an older active check");
  }
  return current;
}

async function matchingChecks(
  identity: RequiredGateIdentity,
  name: string,
): Promise<CoordinationCheckRun[]> {
  const response = validateCheckRunsResponse(
    await githubApi<unknown>(
      `repos/${identity.repository}/commits/${identity.headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
      identity.token,
      { userAgent: USER_AGENT },
    ),
  );
  const externalId = coordinationExternalId(identity.prNumber, identity.headSha, identity.baseSha);
  const claimed = response.check_runs.filter(
    (check) =>
      check.name === name &&
      check.head_sha === identity.headSha &&
      check.external_id === externalId,
  );
  if (claimed.some((check) => check.app?.id !== GITHUB_ACTIONS_APP_ID)) {
    throw new Error(
      "The PR/base SHA coordination identity was claimed by an unexpected GitHub App",
    );
  }
  const current = currentCoordinationCheck(
    claimed.filter((check) => check.app?.id === GITHUB_ACTIONS_APP_ID),
  );
  return current ? [current] : [];
}

export async function findCoordinationCheck(
  identity: RequiredGateIdentity,
): Promise<CoordinationCheckRun | undefined> {
  assertIdentity(identity);
  const current = await matchingChecks(identity, COORDINATION_CHECK_NAME);
  if (current.length > 1)
    throw new Error("Multiple coordination checks exist for one PR/base SHA pair");
  if (current[0]) return current[0];

  // Migration bridge for PRs whose base-branch controller still publishes the
  // old name. Remove after this workflow is on main and open PRs resynchronize.
  const legacy = await matchingChecks(identity, LEGACY_COORDINATION_CHECK_NAME);
  if (legacy.length > 1)
    throw new Error("Multiple legacy coordination checks exist for one PR/base SHA pair");
  return legacy[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function trustedCheckDetailsUrl(value: unknown, repository: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const repo = escapeRegExp(repository);
  const pattern = new RegExp(
    `^https://github\\.com/${repo}/(?:actions/runs/[1-9][0-9]*(?:/attempts/[1-9][0-9]*)?(?:/job/[1-9][0-9]*)?|runs/[1-9][0-9]*)$`,
    "u",
  );
  return pattern.test(value) ? value : undefined;
}

function trustedSummaryLogUrls(summary: unknown, repository: string): string[] {
  if (typeof summary !== "string") return [];
  const repo = escapeRegExp(repository);
  const firstLine = summary.split(/\r?\n/u, 1)[0] ?? "";
  const runTarget = firstLine.match(
    new RegExp(
      `\\]\\((https://github\\.com/${repo}/actions/runs/([1-9][0-9]*)(?:/attempts/[1-9][0-9]*)?)\\)`,
      "u",
    ),
  );
  if (!runTarget?.[1] || !runTarget[2]) return [];
  const runUrl = `https://github.com/${repository}/actions/runs/${runTarget[2]}`;
  const jobTargetPattern = new RegExp(
    `^-[ \\t]+\\[.*\\]\\((${escapeRegExp(runUrl)}/job/[1-9][0-9]*)\\)[ \\t]+—[ \\t]+.*$`,
    "gmu",
  );
  const jobUrls = [...summary.matchAll(jobTargetPattern)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
  return jobUrls.length > 0 ? [...new Set(jobUrls)].slice(0, MAX_LOG_URLS) : [runTarget[1]];
}

function coordinationLogUrls(
  check: CoordinationCheckRun,
  repository: string,
): { detailsUrl?: string; logUrls?: string[] } {
  const detailsUrl = trustedCheckDetailsUrl(check.details_url, repository);
  const summaryUrls = trustedSummaryLogUrls(check.output?.summary, repository);
  const logUrls = summaryUrls.length > 0 ? summaryUrls : detailsUrl ? [detailsUrl] : [];
  return {
    ...(detailsUrl ? { detailsUrl } : {}),
    ...(logUrls.length > 0 ? { logUrls } : {}),
  };
}

function logUrlSuffix(logUrls: readonly string[] | undefined): string {
  return logUrls && logUrls.length > 0 ? ` logs=${logUrls.join(" ")}` : "";
}

export function formatRequiredGateOutcome(result: RequiredGateResult): string {
  return `conclusion=${result.conclusion} title=${result.title}${logUrlSuffix(result.logUrls)}`;
}

export function classifyCoordinationCheck(
  check: CoordinationCheckRun | undefined,
  repository: string,
): WaitingGateResult | { state: "complete"; result: RequiredGateResult } {
  if (!check) return { state: "waiting", description: "waiting for trusted coordination" };
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("repository must be an owner/repository name");
  }
  const title = check.output?.title?.trim() || "Trusted E2E coordination result";
  const links = coordinationLogUrls(check, repository);
  if (check.status !== "completed") {
    return { state: "waiting", description: title, ...links };
  }
  if (
    check.conclusion === "failure" &&
    (AUTHORIZATION_TITLES.has(title) || hasRetryableFailureMarker(check))
  ) {
    return { state: "waiting", description: title, ...links };
  }
  if (
    !(["success", "failure", "cancelled"] as const).includes(check.conclusion as CheckConclusion)
  ) {
    throw new Error(
      `Coordination check completed with unsupported conclusion ${check.conclusion}${logUrlSuffix(links.logUrls)}`,
    );
  }
  return {
    state: "complete",
    result: {
      conclusion: check.conclusion as CheckConclusion,
      title,
      ...links,
    },
  };
}

export async function waitForRequiredGate(
  identity: RequiredGateIdentity,
  options: {
    timeoutMs: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<RequiredGateResult> {
  assertIdentity(identity);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("gate timeout is invalid");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("gate poll interval is invalid");
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + options.timeoutMs;
  let lastDescription = "";
  let lastLogUrls: string[] | undefined;

  await requireExactPullRequest(identity);
  while (now() < deadline) {
    const classified = classifyCoordinationCheck(
      await findCoordinationCheck(identity),
      identity.repository,
    );
    if (classified.state === "complete") {
      await requireExactPullRequest(identity);
      return classified.result;
    }
    const message = `${classified.description}${logUrlSuffix(classified.logUrls)}`;
    if (message !== lastDescription) {
      console.log(`E2E / PR Gate: ${message}`);
      lastDescription = message;
    }
    if (classified.logUrls) lastLogUrls = classified.logUrls;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
  throw new Error(`Timed out waiting for the trusted E2E verdict${logUrlSuffix(lastLogUrls)}`);
}

function appendJobSummary(): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const descriptor = fs.openSync(
    summaryPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("GITHUB_STEP_SUMMARY must be a regular file");
    }
    fs.writeFileSync(
      descriptor,
      "## E2E / PR Gate\n\nSee the job log for the trusted terminal verdict and links.\n",
      "utf8",
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const identity: RequiredGateIdentity = {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    prNumber: parsePositiveInteger(args.pr, "pr"),
    headSha: requiredArgument(args.head, "head"),
    baseSha: requiredArgument(args.base, "base"),
  };
  const timeoutSeconds = parsePositiveInteger(args.timeoutSeconds, "timeout-seconds");
  if (timeoutSeconds > 10_200) throw new Error("--timeout-seconds must not exceed 10200");
  const result = await waitForRequiredGate(identity, { timeoutMs: timeoutSeconds * 1000 });
  appendJobSummary();
  console.log(`E2E / PR Gate completed: ${formatRequiredGateOutcome(result)}`);
  if (result.conclusion !== "success") {
    throw new Error(`Trusted E2E verdict: ${formatRequiredGateOutcome(result)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const escaped = message.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
    console.error(`::error title=E2E / PR Gate failed::${escaped}`);
    process.exit(1);
  });
}
