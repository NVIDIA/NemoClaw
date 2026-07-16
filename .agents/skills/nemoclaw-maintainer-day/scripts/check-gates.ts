// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic merge-gate checker for a single NemoClaw PR.
 *
 * Checks all required gates and outputs structured JSON.
 * Claude uses the output to decide: approve, route to salvage, or report blockers.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number> [--repo OWNER/REPO]
 */

import {
  ghJson,
  isRiskyFile,
  isTestFile,
  parseStringArg,
  REQUIRED_CHECK_NAMES,
  run,
  type StatusCheck,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GateResult {
  pass: boolean;
  details: string;
}

interface PrIdentity {
  login?: string | null;
}

interface PrReview {
  author?: PrIdentity | null;
  state?: string | null;
  submittedAt?: string | null;
}

interface PrCommit {
  authors: PrIdentity[];
  authorCount: number;
}

interface ContributorApprovalHistory {
  commits: PrCommit[];
  reviews: PrReview[];
}

interface ContributorApprovalAdvisory {
  status: "clear" | "warning";
  details: string;
  actors: string[];
  uncertainActors: string[];
}

interface CodeRabbitThread {
  path: string;
  severity: "critical" | "major" | "minor" | "unknown";
  snippet: string;
  resolved: boolean;
}

interface GateOutput {
  pr: number;
  url: string;
  title: string;
  allPass: boolean;
  gates: {
    ci: GateResult & {
      failingChecks?: string[];
      pendingChecks?: string[];
      missingChecks?: string[];
    };
    conflicts: GateResult & {
      mergeable?: string;
      mergeStateStatus?: string;
      baseSha?: string;
      currentBaseSha?: string;
    };
    coderabbit: GateResult & { unresolvedThreads?: CodeRabbitThread[] };
    riskyCodeTested: GateResult & { riskyFiles?: string[]; hasTests?: boolean };
    contributorCompliance: GateResult & {
      dcoDeclarationPresent?: boolean;
      dcoDeclarationBypassed?: boolean;
      unverifiedCommits?: Array<{ sha: string; reason: string }>;
    };
  };
  advisories: {
    contributorApprovalOverlap: ContributorApprovalAdvisory;
  };
}

const CODERABBIT_LOGINS = new Set(["coderabbitai[bot]", "coderabbitai"]);
const OPINIONATED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

function isAutomatedLogin(login: string): boolean {
  return login.endsWith("[bot]") || CODERABBIT_LOGINS.has(login);
}

function parseCompletePaginatedConnection<T>(raw: string): T[] | null {
  if (!raw) return null;

  const nodes: T[] = [];
  let expectedTotal: number | null = null;
  try {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const page = JSON.parse(trimmed) as unknown;
      if (typeof page !== "object" || page === null || Array.isArray(page)) return null;
      const { nodes: pageNodes, totalCount } = page as Record<string, unknown>;
      if (
        !Array.isArray(pageNodes) ||
        typeof totalCount !== "number" ||
        !Number.isInteger(totalCount) ||
        totalCount < 0 ||
        (expectedTotal !== null && totalCount !== expectedTotal)
      ) {
        return null;
      }
      expectedTotal = totalCount;
      nodes.push(...(pageNodes as T[]));
    }
  } catch {
    return null;
  }
  return expectedTotal !== null && nodes.length === expectedTotal ? nodes : null;
}

function fetchContributorApprovalHistory(
  repo: string,
  number: number,
): ContributorApprovalHistory | null {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) return null;

  const variables = ["-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
  const commitsRaw = run("gh", [
    "api",
    "graphql",
    "--paginate",
    ...variables,
    "-f",
    `query=query ContributorCommits($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          commits(first: 100, after: $endCursor) {
            nodes { commit { authors(first: 100) { totalCount nodes { user { login } } } } }
            totalCount
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`,
    "--jq",
    "{nodes: [.data.repository.pullRequest.commits.nodes[] | {authors: [.commit.authors.nodes[] | {login: (.user.login // null)}], authorCount: .commit.authors.totalCount}], totalCount: .data.repository.pullRequest.commits.totalCount}",
  ]);
  const reviewsRaw = run("gh", [
    "api",
    "graphql",
    "--paginate",
    ...variables,
    "-f",
    `query=query ContributorReviews($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviews(first: 100, after: $endCursor) {
            nodes { author { login } state submittedAt }
            totalCount
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`,
    "--jq",
    "{nodes: .data.repository.pullRequest.reviews.nodes, totalCount: .data.repository.pullRequest.reviews.totalCount}",
  ]);

  const commits = parseCompletePaginatedConnection<PrCommit>(commitsRaw);
  const reviews = parseCompletePaginatedConnection<PrReview>(reviewsRaw);
  const completeCommitAuthors = commits?.every(
    (commit) =>
      Array.isArray(commit.authors) &&
      Number.isInteger(commit.authorCount) &&
      commit.authorCount === commit.authors.length,
  );
  return commits && reviews && completeCommitAuthors ? { commits, reviews } : null;
}

function checkContributorApprovalOverlap(
  pr: { author?: PrIdentity | null },
  history: ContributorApprovalHistory | null,
): ContributorApprovalAdvisory {
  if (!history) {
    return {
      status: "warning",
      details:
        "Could not retrieve complete paginated commit and review history, so contributor/approver overlap could not be determined. This warning is advisory and does not change allPass.",
      actors: [],
      uncertainActors: [],
    };
  }

  const normalizedLogin = (identity: PrIdentity | null | undefined): string | null => {
    const login = identity?.login?.trim().toLowerCase();
    return login || null;
  };
  const contributors = new Set<string>();
  const addContributor = (identity: PrIdentity | null | undefined): void => {
    const login = normalizedLogin(identity);
    if (login && !isAutomatedLogin(login)) contributors.add(login);
  };

  // Opening the PR is a contribution even when the opener authored no current commit.
  addContributor(pr.author);
  for (const commit of history.commits) {
    for (const author of commit.authors) addContributor(author);
  }

  const invalidTimestampLogins = new Set<string>();
  const reviews = history.reviews
    .map((review) => ({
      login: normalizedLogin(review.author),
      state: review.state?.toUpperCase() ?? "",
      submittedAt: Date.parse(review.submittedAt ?? ""),
    }))
    .filter(
      (review) =>
        review.login &&
        !isAutomatedLogin(review.login) &&
        OPINIONATED_REVIEW_STATES.has(review.state),
    );
  for (const review of reviews) {
    if (!Number.isFinite(review.submittedAt) && review.login) {
      invalidTimestampLogins.add(review.login);
    }
  }
  const orderedReviews = reviews
    .filter((review) => Number.isFinite(review.submittedAt))
    .sort((left, right) => left.submittedAt - right.submittedAt);
  const ambiguousLatestOpinionLogins = new Set<string>();
  const latestOpinionByLogin = new Map<string, { state: string; submittedAt: number }>();
  for (const review of orderedReviews) {
    if (!review.login) continue;
    const latest = latestOpinionByLogin.get(review.login);
    if (!latest || review.submittedAt > latest.submittedAt) {
      latestOpinionByLogin.set(review.login, {
        state: review.state,
        submittedAt: review.submittedAt,
      });
      ambiguousLatestOpinionLogins.delete(review.login);
    } else if (review.submittedAt === latest.submittedAt && review.state !== latest.state) {
      // A conflicting equal-time opinion is ambiguous regardless of API ordering.
      ambiguousLatestOpinionLogins.add(review.login);
    }
  }
  const uncertainOpinionLogins = new Set([
    ...invalidTimestampLogins,
    ...ambiguousLatestOpinionLogins,
  ]);
  const approvingLogins = new Set(
    [...latestOpinionByLogin]
      .filter(
        ([login, opinion]) => opinion.state === "APPROVED" && !uncertainOpinionLogins.has(login),
      )
      .map(([login]) => login),
  );
  const actors = [...approvingLogins].filter((login) => contributors.has(login)).sort();
  const uncertainActors = [...uncertainOpinionLogins]
    .filter((login) => contributors.has(login))
    .sort();

  if (actors.length === 0 && uncertainActors.length === 0) {
    return {
      status: "clear",
      details:
        "No author/approver overlap detected among accounts not recognized as automated in the current PR snapshot; this is not proof of independent approval",
      actors: [],
      uncertainActors: [],
    };
  }

  const mentions = actors.map((actor) => `@${actor}`).join(", ");
  const uncertainMentions = uncertainActors.map((actor) => `@${actor}`).join(", ");
  const confirmedDetails = actors.length
    ? `${mentions} both contributed to and approved this PR.`
    : "";
  const uncertainDetails = uncertainActors.length
    ? `The latest opinion from ${uncertainMentions} could not be determined because review timestamps were missing, invalid, or conflicting.`
    : "";
  return {
    status: "warning",
    details:
      `${confirmedDetails} ${uncertainDetails} This warning is advisory; it does not prove or disprove independent approval, invalidate approval, require another reviewer, or change allPass.`.trim(),
    actors,
    uncertainActors,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: CI green
// ---------------------------------------------------------------------------

interface ExactDiffIdentity {
  number: number;
  headSha: string;
  baseSha: string;
  headRefName: string;
  headRepository: string;
}

interface E2eCoordinationEvidence {
  valid: boolean | null;
  startedAt?: number;
  completedAt?: number;
  trustedLegacyCheckId?: number;
}

function parseGitHubTimestamp(value: string | undefined): number {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/u);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
    ? Date.parse(match[0])
    : Number.NaN;
}

function fetchE2eCoordinationEvidence(
  repo: string,
  exactDiff: ExactDiffIdentity,
): E2eCoordinationEvidence {
  const checkNames = ["E2E / PR Gate Coordination", "E2E / PR Gate"];
  const checkRuns: Array<Record<string, unknown>> = [];
  const ids = new Set<number>();
  for (const checkName of checkNames) {
    const pages = ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/commits/${exactDiff.headSha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`,
    ]);
    if (!Array.isArray(pages) || pages.length === 0) return { valid: null };

    let expectedTotal: number | null = null;
    let observedTotal = 0;
    for (const page of pages) {
      if (typeof page !== "object" || page === null || Array.isArray(page)) {
        return { valid: null };
      }
      const { total_count: totalCount, check_runs: pageRuns } = page as Record<string, unknown>;
      if (
        !Number.isSafeInteger(totalCount) ||
        (totalCount as number) < 0 ||
        (expectedTotal !== null && totalCount !== expectedTotal) ||
        !Array.isArray(pageRuns)
      ) {
        return { valid: null };
      }
      expectedTotal = totalCount as number;
      observedTotal += pageRuns.length;
      for (const value of pageRuns) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return { valid: null };
        }
        const record = value as Record<string, unknown>;
        if (
          !Number.isSafeInteger(record.id) ||
          (record.id as number) < 1 ||
          ids.has(record.id as number) ||
          (typeof record.external_id !== "string" && record.external_id !== null)
        ) {
          return { valid: null };
        }
        ids.add(record.id as number);
        checkRuns.push(record);
      }
    }
    if (expectedTotal === null || observedTotal !== expectedTotal) {
      return { valid: null };
    }
  }

  const externalId = `nemoclaw-pr-e2e:v2:${exactDiff.number}:${exactDiff.headSha}:${exactDiff.baseSha}`;
  const exactChecks = checkRuns.filter((check) => check.external_id === externalId);
  if (exactChecks.length !== 1) return { valid: false };
  const exact = exactChecks[0];
  const app = exact.app;
  const startedAt =
    typeof exact.started_at === "string" ? parseGitHubTimestamp(exact.started_at) : Number.NaN;
  const completedAt =
    typeof exact.completed_at === "string" ? parseGitHubTimestamp(exact.completed_at) : Number.NaN;
  const valid =
    typeof exact.name === "string" &&
    checkNames.includes(exact.name) &&
    exact.head_sha === exactDiff.headSha &&
    typeof app === "object" &&
    app !== null &&
    !Array.isArray(app) &&
    (app as Record<string, unknown>).id === 15368 &&
    exact.status === "completed" &&
    exact.conclusion === "success" &&
    Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    startedAt <= completedAt;
  return {
    valid,
    ...(valid ? { startedAt, completedAt } : {}),
    ...(valid && exact.name === "E2E / PR Gate"
      ? { trustedLegacyCheckId: exact.id as number }
      : {}),
  };
}

const ACTION_STATUSES = new Set([
  "COMPLETED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);
const ACTION_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
]);
const PASSING_ACTION_RUN_CONCLUSIONS = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);
const HEAD_BOUND_ACTION_EVENTS = new Set(["dynamic", "push", "workflow_call", "workflow_dispatch"]);
const PR_CI_RUN_TITLE =
  /^CI PR #([1-9][0-9]*) head ([a-f0-9]{40}) base ([a-f0-9]{40}) gate (true|false)$/u;
const INSTALLER_HASH_RUN_TITLE =
  /^Installer Hash PR #([1-9][0-9]*) head ([a-f0-9]{40}) base ([a-f0-9]{40}) gate (true|false)$/u;
const E2E_GATE_RUN_TITLE =
  /^E2E Gate PR #([1-9][0-9]*) head ([a-f0-9]{40}) base ([a-f0-9]{40}) gate (true|false)$/u;
const REQUIRED_CHECK_WORKFLOW_PATHS = new Map([
  ["checks", ".github/workflows/pr.yaml"],
  ["changes", ".github/workflows/pr.yaml"],
  ["check-hash", ".github/workflows/installer-hash-check.yaml"],
  ["commit-lint", ".github/workflows/commit-lint.yaml"],
  ["dco-check", ".github/workflows/dco-check.yaml"],
  ["E2E / PR Gate", ".github/workflows/pr-e2e-gate.yaml"],
]);
const PR_METADATA_EDIT_JOB_NAMES = new Set([
  "build-typecheck",
  "changes",
  "checks",
  "cli-test-shards",
  "cli-tests",
  "docs-only-checks",
  "installer-integration",
  "plugin-tests",
  "reviewed-npm-audit",
  "static-checks",
  "wechat-runtime-audit",
]);

interface ActionRunMetadata {
  attempt: number;
  createdAt: number;
  updatedAt: number;
  exactDiff: boolean | null;
  hasPullRequests: boolean | null;
  headShaMatches: boolean | null;
  headRefNameMatches: boolean | null;
  headRepositoryMatches: boolean | null;
  immutablePrDiff: boolean | null;
  prCiGate: boolean | null;
  installerHashGate: boolean | null;
  e2eGateDiff: boolean | null;
  e2eGateRun: boolean | null;
  event: string | null;
  path: string | null;
  status: string | null;
  conclusion: string | null;
}

interface ActionJobMetadata {
  name: string;
  status: string;
  conclusion: string | null;
}

interface CurrentCheckRollup {
  checks: StatusCheck[];
  incompleteAttemptEvidence: string[];
}

function currentCheckRollup(
  statusCheckRollup: StatusCheck[],
  repo: string,
  exactDiff: ExactDiffIdentity,
  e2eCoordinationEvidence: E2eCoordinationEvidence,
): CurrentCheckRollup {
  const actionRunMetadataById = new Map<string, ActionRunMetadata | null>();
  const latestAttemptJobsByRun = new Map<string, Map<string, ActionJobMetadata> | null>();
  const incompleteAttemptEvidence = new Set<string>();

  const fetchActionRunMetadata = (runId: string): ActionRunMetadata | null => {
    const runData = ghJson(["api", `repos/${repo}/actions/runs/${runId}`]);
    if (typeof runData !== "object" || runData === null || Array.isArray(runData)) {
      return null;
    }
    const record = runData as Record<string, unknown>;
    if (!Number.isSafeInteger(record.run_attempt) || (record.run_attempt as number) < 1) {
      return null;
    }
    const status = typeof record.status === "string" ? record.status.toUpperCase() : null;
    const conclusion =
      typeof record.conclusion === "string" ? record.conclusion.toUpperCase() : record.conclusion;
    if (
      !status ||
      !ACTION_STATUSES.has(status) ||
      (conclusion !== null &&
        (typeof conclusion !== "string" || !ACTION_CONCLUSIONS.has(conclusion)))
    ) {
      return null;
    }

    let exactDiffMatch: boolean | null = null;
    let hasPullRequests: boolean | null = null;
    if (Array.isArray(record.pull_requests)) {
      hasPullRequests = record.pull_requests.length > 0;
      exactDiffMatch = hasPullRequests ? false : null;
      for (const value of record.pull_requests) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          exactDiffMatch = null;
          hasPullRequests = null;
          break;
        }
        const pull = value as Record<string, unknown>;
        const head = pull.head;
        const base = pull.base;
        if (
          !Number.isSafeInteger(pull.number) ||
          typeof head !== "object" ||
          head === null ||
          Array.isArray(head) ||
          typeof base !== "object" ||
          base === null ||
          Array.isArray(base) ||
          typeof (head as Record<string, unknown>).sha !== "string" ||
          typeof (base as Record<string, unknown>).sha !== "string"
        ) {
          exactDiffMatch = null;
          hasPullRequests = null;
          break;
        }
        if (
          pull.number === exactDiff.number &&
          (head as Record<string, unknown>).sha === exactDiff.headSha &&
          (base as Record<string, unknown>).sha === exactDiff.baseSha
        ) {
          exactDiffMatch = true;
        }
      }
    }

    const event = typeof record.event === "string" ? record.event : null;
    const path = typeof record.path === "string" ? record.path : null;
    const createdAt =
      typeof record.created_at === "string" ? parseGitHubTimestamp(record.created_at) : Number.NaN;
    const updatedAt =
      typeof record.updated_at === "string" ? parseGitHubTimestamp(record.updated_at) : Number.NaN;
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || createdAt > updatedAt) {
      return null;
    }
    let immutablePrDiff: boolean | null = null;
    let prCiGate: boolean | null = null;
    let installerHashGate: boolean | null = null;
    let e2eGateDiff: boolean | null = null;
    let e2eGateRun: boolean | null = null;
    if (event === "pull_request") {
      const title = typeof record.display_title === "string" ? record.display_title : "";
      const titlePattern =
        path === ".github/workflows/pr.yaml"
          ? PR_CI_RUN_TITLE
          : path === ".github/workflows/installer-hash-check.yaml"
            ? INSTALLER_HASH_RUN_TITLE
            : null;
      const match = titlePattern ? title.match(titlePattern) : null;
      if (match) {
        const titlePrNumber = Number(match[1]);
        if (Number.isSafeInteger(titlePrNumber) && titlePrNumber > 0) {
          immutablePrDiff =
            titlePrNumber === exactDiff.number &&
            match[2] === exactDiff.headSha &&
            match[3] === exactDiff.baseSha;
          if (path === ".github/workflows/pr.yaml") {
            prCiGate = match[4] === "true";
          } else if (path === ".github/workflows/installer-hash-check.yaml") {
            installerHashGate = match[4] === "true";
          }
        }
      }
    }
    if (event === "pull_request_target" && path === ".github/workflows/pr-e2e-gate.yaml") {
      const title = typeof record.display_title === "string" ? record.display_title : "";
      const match = title.match(E2E_GATE_RUN_TITLE);
      if (match) {
        const titlePrNumber = Number(match[1]);
        if (Number.isSafeInteger(titlePrNumber) && titlePrNumber > 0) {
          e2eGateDiff =
            titlePrNumber === exactDiff.number &&
            match[2] === exactDiff.headSha &&
            match[3] === exactDiff.baseSha;
          e2eGateRun = match[4] === "true";
        }
      }
    }

    const headRepository = record.head_repository;

    return {
      attempt: record.run_attempt as number,
      createdAt,
      updatedAt,
      exactDiff: exactDiffMatch,
      hasPullRequests,
      headShaMatches:
        typeof record.head_sha === "string" ? record.head_sha === exactDiff.headSha : null,
      headRefNameMatches:
        typeof record.head_branch === "string"
          ? record.head_branch === exactDiff.headRefName
          : null,
      headRepositoryMatches:
        typeof headRepository === "object" &&
        headRepository !== null &&
        !Array.isArray(headRepository) &&
        typeof (headRepository as Record<string, unknown>).full_name === "string"
          ? (headRepository as Record<string, unknown>).full_name === exactDiff.headRepository
          : null,
      immutablePrDiff,
      prCiGate,
      installerHashGate,
      e2eGateDiff,
      e2eGateRun,
      event,
      path,
      status,
      conclusion,
    };
  };

  const actionRunMetadata = (runId: string): ActionRunMetadata | null => {
    if (actionRunMetadataById.has(runId)) return actionRunMetadataById.get(runId) ?? null;
    const metadata = fetchActionRunMetadata(runId);
    actionRunMetadataById.set(runId, metadata);
    return metadata;
  };

  const latestAttemptJobs = (runId: string): Map<string, ActionJobMetadata> | null => {
    if (latestAttemptJobsByRun.has(runId)) return latestAttemptJobsByRun.get(runId) ?? null;

    const metadata = actionRunMetadata(runId);
    if (!metadata) {
      latestAttemptJobsByRun.set(runId, null);
      return null;
    }
    const pages = ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/actions/runs/${runId}/attempts/${metadata.attempt}/jobs?per_page=100`,
    ]);
    if (!Array.isArray(pages) || pages.length === 0) {
      latestAttemptJobsByRun.set(runId, null);
      return null;
    }

    let expectedTotal: number | null = null;
    const jobsById = new Map<string, ActionJobMetadata>();
    let observedJobs = 0;
    for (const page of pages) {
      if (typeof page !== "object" || page === null || Array.isArray(page)) {
        latestAttemptJobsByRun.set(runId, null);
        return null;
      }
      const { jobs, total_count: totalCount } = page as Record<string, unknown>;
      if (
        !Number.isSafeInteger(totalCount) ||
        (totalCount as number) < 0 ||
        (expectedTotal !== null && totalCount !== expectedTotal) ||
        !Array.isArray(jobs)
      ) {
        latestAttemptJobsByRun.set(runId, null);
        return null;
      }
      expectedTotal = totalCount as number;
      observedJobs += jobs.length;
      for (const value of jobs) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          latestAttemptJobsByRun.set(runId, null);
          return null;
        }
        const { id, name, status, conclusion } = value as Record<string, unknown>;
        const normalizedStatus = typeof status === "string" ? status.toUpperCase() : null;
        const normalizedConclusion =
          typeof conclusion === "string" ? conclusion.toUpperCase() : conclusion;
        if (
          !Number.isSafeInteger(id) ||
          (id as number) < 1 ||
          typeof name !== "string" ||
          !name ||
          !normalizedStatus ||
          !ACTION_STATUSES.has(normalizedStatus) ||
          (normalizedConclusion !== null &&
            (typeof normalizedConclusion !== "string" ||
              !ACTION_CONCLUSIONS.has(normalizedConclusion)))
        ) {
          latestAttemptJobsByRun.set(runId, null);
          return null;
        }
        jobsById.set(String(id), {
          name,
          status: normalizedStatus,
          conclusion: normalizedConclusion,
        });
      }
    }
    if (
      expectedTotal === null ||
      observedJobs !== expectedTotal ||
      jobsById.size !== expectedTotal
    ) {
      latestAttemptJobsByRun.set(runId, null);
      return null;
    }
    const refreshed = fetchActionRunMetadata(runId);
    if (
      !refreshed ||
      refreshed.attempt !== metadata.attempt ||
      refreshed.createdAt !== metadata.createdAt ||
      refreshed.updatedAt !== metadata.updatedAt ||
      refreshed.exactDiff !== metadata.exactDiff ||
      refreshed.hasPullRequests !== metadata.hasPullRequests ||
      refreshed.headShaMatches !== metadata.headShaMatches ||
      refreshed.headRefNameMatches !== metadata.headRefNameMatches ||
      refreshed.headRepositoryMatches !== metadata.headRepositoryMatches ||
      refreshed.immutablePrDiff !== metadata.immutablePrDiff ||
      refreshed.prCiGate !== metadata.prCiGate ||
      refreshed.installerHashGate !== metadata.installerHashGate ||
      refreshed.e2eGateDiff !== metadata.e2eGateDiff ||
      refreshed.e2eGateRun !== metadata.e2eGateRun ||
      refreshed.event !== metadata.event ||
      refreshed.path !== metadata.path ||
      refreshed.status !== metadata.status ||
      refreshed.conclusion !== metadata.conclusion
    ) {
      latestAttemptJobsByRun.set(runId, null);
      return null;
    }
    actionRunMetadataById.set(runId, refreshed);
    latestAttemptJobsByRun.set(runId, jobsById);
    return jobsById;
  };

  const classifyPrMetadataEditRun = (
    runId: string,
  ): "recognized" | "invalid" | "not_metadata_edit" => {
    const run = actionRunMetadata(runId);
    const jobs = latestAttemptJobs(runId);
    if (!run || !jobs || jobs.size === 0) return "not_metadata_edit";

    if (
      runIdentityEvidence(runId, true) !== "current" ||
      run.event !== "pull_request" ||
      run.path !== ".github/workflows/pr.yaml" ||
      run.status !== "COMPLETED" ||
      run.conclusion !== "SUCCESS"
    ) {
      return "not_metadata_edit";
    }
    if (run.prCiGate !== false) return "not_metadata_edit";

    const jobNames = new Set([...jobs.values()].map((job) => job.name));
    const hasExactMetadataEditShape =
      jobs.size === PR_METADATA_EDIT_JOB_NAMES.size &&
      jobNames.size === PR_METADATA_EDIT_JOB_NAMES.size &&
      [...PR_METADATA_EDIT_JOB_NAMES].every((name) => jobNames.has(name)) &&
      [...jobs.values()].every(
        (job) =>
          job.status === "COMPLETED" &&
          (job.name === "checks" ? job.conclusion === "SUCCESS" : job.conclusion === "SKIPPED"),
      );
    return hasExactMetadataEditShape ? "recognized" : "invalid";
  };

  const e2eControllerHeadBinding = (run: ActionRunMetadata): "current" | "other" | "unknown" => {
    if (run.event !== "pull_request_target" || run.path !== ".github/workflows/pr-e2e-gate.yaml") {
      return "unknown";
    }
    if (
      run.exactDiff === false ||
      run.e2eGateDiff === false ||
      run.headShaMatches === false ||
      run.headRefNameMatches === false ||
      run.headRepositoryMatches === false
    ) {
      return "other";
    }
    return e2eCoordinationEvidence.valid === true &&
      run.e2eGateDiff === true &&
      run.hasPullRequests === false &&
      run.headShaMatches === true &&
      run.headRefNameMatches === true &&
      run.headRepositoryMatches === true
      ? "current"
      : "unknown";
  };

  const e2eCoordinationIsEnclosed = (run: ActionRunMetadata): boolean =>
    e2eControllerHeadBinding(run) === "current" &&
    run.e2eGateRun === true &&
    e2eCoordinationEvidence.startedAt !== undefined &&
    e2eCoordinationEvidence.completedAt !== undefined &&
    run.createdAt <= e2eCoordinationEvidence.startedAt &&
    e2eCoordinationEvidence.completedAt <= run.updatedAt;

  const isNonAttemptRun = (runId: string): boolean => {
    const run = actionRunMetadata(runId);
    const jobs = latestAttemptJobs(runId);
    if (!run || !jobs || jobs.size === 0) return false;

    const allSkippedTargetRun = Boolean(
      (runIdentityEvidence(runId, true) === "current" ||
        e2eControllerHeadBinding(run) === "current") &&
        run.event === "pull_request_target" &&
        run.path === ".github/workflows/pr-e2e-gate.yaml" &&
        run.e2eGateDiff === true &&
        run.e2eGateRun === false &&
        run.status === "COMPLETED" &&
        run.conclusion === "SKIPPED" &&
        [...jobs.values()].every(
          (job) => job.status === "COMPLETED" && job.conclusion === "SKIPPED",
        ),
    );
    if (allSkippedTargetRun) return true;
    return classifyPrMetadataEditRun(runId) === "recognized";
  };

  const isMeaningfulExactDiffRun = (runId: string, event: string, path: string): boolean => {
    const run = actionRunMetadata(runId);
    const jobs = latestAttemptJobs(runId);
    return Boolean(
      run &&
        jobs &&
        classifyPrMetadataEditRun(runId) === "not_metadata_edit" &&
        runIdentityEvidence(runId, true) === "current" &&
        run.event === event &&
        run.path === path &&
        (run.path !== ".github/workflows/pr.yaml" || run.prCiGate === true) &&
        (run.path !== ".github/workflows/installer-hash-check.yaml" ||
          run.installerHashGate === true) &&
        (run.path !== ".github/workflows/pr-e2e-gate.yaml" ||
          run.event !== "pull_request_target" ||
          (run.e2eGateDiff === true && run.e2eGateRun === true)) &&
        run.status === "COMPLETED" &&
        run.conclusion !== null &&
        run.conclusion !== "SKIPPED" &&
        jobs.size > 0 &&
        [...jobs.values()].every((job) => job.status === "COMPLETED" && job.conclusion !== null) &&
        [...jobs.values()].some((job) => job.conclusion !== "SKIPPED"),
    );
  };

  const checksFromLatestAttempt = (runId: string, checks: StatusCheck[]): StatusCheck[] | null => {
    const checkName = checks[0]?.name;
    const jobsById = latestAttemptJobs(runId);
    if (!checkName || !jobsById) return null;

    const expectedIds = new Set(
      [...jobsById].filter(([, job]) => job.name === checkName).map(([id]) => id),
    );
    if (expectedIds.size === 0) return null;

    const selected: StatusCheck[] = [];
    const selectedIds = new Set<string>();
    for (const check of checks) {
      const match = check.detailsUrl?.match(
        new RegExp(`/actions/runs/${runId}/job/(\\d+)(?:[/?#]|$)`, "u"),
      );
      if (!match) return null;
      if (expectedIds.has(match[1])) {
        if (selectedIds.has(match[1])) return null;
        selectedIds.add(match[1]);
        selected.push(check);
      }
    }
    return selectedIds.size === expectedIds.size ? selected : null;
  };

  const latestAttemptChecks = (runId: string, checks: StatusCheck[]): StatusCheck[] => {
    const selected = checksFromLatestAttempt(runId, checks);
    const checkName = checks[0]?.name ?? "";
    const requiresExactDiff = REQUIRED_CHECK_NAMES.includes(checkName);
    const expectedWorkflowPath = REQUIRED_CHECK_WORKFLOW_PATHS.get(checkName);
    const runMetadata = actionRunMetadata(runId);
    const hasCurrentIdentity = runIdentityEvidence(runId, requiresExactDiff) === "current";
    if (
      !selected ||
      !hasCurrentIdentity ||
      !runMetadata ||
      !runMetadata.event ||
      !runMetadata.path ||
      (expectedWorkflowPath !== undefined && runMetadata.path !== expectedWorkflowPath) ||
      (expectedWorkflowPath === ".github/workflows/pr.yaml" && runMetadata.prCiGate !== true) ||
      (expectedWorkflowPath === ".github/workflows/installer-hash-check.yaml" &&
        runMetadata.installerHashGate !== true) ||
      (expectedWorkflowPath === ".github/workflows/pr-e2e-gate.yaml" &&
        runMetadata.event === "pull_request_target" &&
        (runMetadata.e2eGateDiff !== true || runMetadata.e2eGateRun !== true)) ||
      runMetadata.status !== "COMPLETED" ||
      runMetadata.conclusion === null ||
      (requiresExactDiff
        ? runMetadata.conclusion !== "SUCCESS"
        : !PASSING_ACTION_RUN_CONCLUSIONS.has(runMetadata.conclusion))
    ) {
      incompleteAttemptEvidence.add(checks[0]?.name ?? "(unknown)");
    }
    return selected ?? checks;
  };

  const actionRunId = (check: StatusCheck): string | undefined =>
    check.detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1];

  const isTrustedLegacyE2eCheck = (check: StatusCheck): boolean =>
    e2eCoordinationEvidence.trustedLegacyCheckId !== undefined &&
    check.name === "E2E / PR Gate" &&
    check.detailsUrl?.match(/\/runs\/(\d+)(?:[/?#]|$)/u)?.[1] ===
      String(e2eCoordinationEvidence.trustedLegacyCheckId);

  function runIdentityEvidence(
    runId: string,
    requiresExactDiff: boolean,
  ): "current" | "other" | "unknown" {
    const metadata = actionRunMetadata(runId);
    if (!metadata?.event || !metadata.path) return "unknown";
    if (
      metadata.event === "pull_request" &&
      metadata.path === ".github/workflows/installer-hash-check.yaml"
    ) {
      if (
        metadata.immutablePrDiff === false ||
        metadata.exactDiff === false ||
        metadata.headShaMatches === false
      ) {
        return "other";
      }
      if (
        metadata.immutablePrDiff === true &&
        metadata.headShaMatches === true &&
        (metadata.exactDiff === true || metadata.hasPullRequests === false)
      ) {
        return "current";
      }
      return "unknown";
    }
    if (metadata.exactDiff === true) {
      if (metadata.headShaMatches === true) {
        if (metadata.event === "pull_request" && metadata.path === ".github/workflows/pr.yaml") {
          if (metadata.immutablePrDiff === true) return "current";
          if (metadata.immutablePrDiff === false) return "other";
          return "unknown";
        }
        return "current";
      }
      if (metadata.headShaMatches === false) return "other";
      return "unknown";
    }
    if (metadata.exactDiff === false) return "other";
    const e2eHeadBinding = e2eControllerHeadBinding(metadata);
    if (e2eHeadBinding === "other") return "other";
    if (e2eHeadBinding === "current") {
      return e2eCoordinationIsEnclosed(metadata) ? "current" : "unknown";
    }
    if (
      !requiresExactDiff &&
      metadata.hasPullRequests === false &&
      HEAD_BOUND_ACTION_EVENTS.has(metadata.event) &&
      metadata.headShaMatches !== null
    ) {
      return metadata.headShaMatches ? "current" : "other";
    }
    return "unknown";
  }

  const allActionRunIds = new Set(
    statusCheckRollup.map(actionRunId).filter((runId): runId is string => Boolean(runId)),
  );
  const hasMeaningfulAlternateRun = (runId: string): boolean => {
    const { event, path } = actionRunMetadata(runId) ?? {};
    return Boolean(
      event &&
        path &&
        [...allActionRunIds].some(
          (otherRunId) => otherRunId !== runId && isMeaningfulExactDiffRun(otherRunId, event, path),
        ),
    );
  };

  const groups = new Map<string, StatusCheck[]>();
  for (const check of statusCheckRollup) {
    const identity = JSON.stringify([
      check.__typename ?? (check.context ? "StatusContext" : "CheckRun"),
      check.name ?? check.context ?? "(unknown)",
      check.workflowName ?? "",
    ]);
    const group = groups.get(identity) ?? [];
    group.push(check);
    groups.set(identity, group);
  }

  const current: StatusCheck[] = [];
  for (const group of groups.values()) {
    const groupName = group[0].name ?? group[0].context ?? "(unknown)";
    const requiredCheck = REQUIRED_CHECK_NAMES.includes(groupName);
    const expectsActionEvidence = group.some(
      (check) =>
        check.__typename !== "StatusContext" &&
        (check.detailsUrl?.includes("/actions/") ||
          (Boolean(check.workflowName) && !/\/runs\/\d+(?:[/?#]|$)/u.test(check.detailsUrl ?? ""))),
    );
    if (
      (requiredCheck || expectsActionEvidence) &&
      group.some((check) => !actionRunId(check) && !isTrustedLegacyE2eCheck(check))
    ) {
      incompleteAttemptEvidence.add(groupName);
    }
    if (group.length === 1) {
      const runId = group[0].__typename !== "StatusContext" ? actionRunId(group[0]) : undefined;
      if (runId && classifyPrMetadataEditRun(runId) === "invalid") {
        incompleteAttemptEvidence.add(groupName);
      }
      if (runId && isNonAttemptRun(runId)) {
        if (hasMeaningfulAlternateRun(runId)) continue;
        incompleteAttemptEvidence.add(groupName);
      }
      current.push(...(runId ? latestAttemptChecks(runId, group) : group));
      continue;
    }

    if (group[0].__typename !== "StatusContext") {
      const hasCheckTimestampEvidence = group.every((check) =>
        Number.isFinite(parseGitHubTimestamp(check.startedAt ?? check.completedAt)),
      );
      if (!hasCheckTimestampEvidence) {
        incompleteAttemptEvidence.add(group[0]?.name ?? "(unknown)");
      }
      const byRun = new Map<string, StatusCheck[]>();
      for (const check of group) {
        const runId = actionRunId(check);
        if (!runId) {
          byRun.clear();
          break;
        }
        const runChecks = byRun.get(runId) ?? [];
        runChecks.push(check);
        byRun.set(runId, runChecks);
      }
      if (byRun.size > 1) {
        const runs = [...byRun].map(([runId, checks]) => {
          return {
            runId,
            checks,
            timestamp: actionRunMetadata(runId)?.createdAt ?? Number.NaN,
          };
        });
        const hasOrderingEvidence =
          hasCheckTimestampEvidence && runs.every(({ timestamp }) => Number.isFinite(timestamp));
        if (!hasOrderingEvidence) {
          incompleteAttemptEvidence.add(group[0]?.name ?? "(unknown)");
        }
        if (hasOrderingEvidence) {
          const currentIdentityRuns = runs.filter(
            ({ runId }) => runIdentityEvidence(runId, requiredCheck) === "current",
          );
          const unknownIdentityRun = runs.some(
            ({ runId }) =>
              runIdentityEvidence(runId, requiredCheck) === "unknown" && !isNonAttemptRun(runId),
          );
          const currentWorkflowIdentities = new Set(
            currentIdentityRuns.map(({ runId }) => {
              const metadata = actionRunMetadata(runId);
              return metadata?.event && metadata.path
                ? JSON.stringify([metadata.event, metadata.path])
                : null;
            }),
          );
          if (
            currentIdentityRuns.length === 0 ||
            unknownIdentityRun ||
            currentWorkflowIdentities.size !== 1 ||
            currentWorkflowIdentities.has(null)
          ) {
            incompleteAttemptEvidence.add(group[0]?.name ?? "(unknown)");
          }
          const identityCandidates = currentIdentityRuns.length > 0 ? currentIdentityRuns : runs;
          const candidates = identityCandidates.filter(({ runId }) => {
            if (classifyPrMetadataEditRun(runId) === "invalid") {
              incompleteAttemptEvidence.add(group[0]?.name ?? "(unknown)");
              return true;
            }
            if (!isNonAttemptRun(runId)) return true;
            const hasMeaningfulRun = hasMeaningfulAlternateRun(runId);
            if (!hasMeaningfulRun) {
              incompleteAttemptEvidence.add(group[0]?.name ?? "(unknown)");
            }
            return !hasMeaningfulRun;
          });
          if (candidates.length === 0) continue;
          const latestTimestamp = Math.max(...candidates.map(({ timestamp }) => timestamp));
          const latestRuns = candidates.filter(({ timestamp }) => timestamp === latestTimestamp);
          for (const latest of latestRuns) {
            current.push(...latestAttemptChecks(latest.runId, latest.checks));
          }
          continue;
        }
      }

      if (byRun.size === 1) {
        const [runId, checks] = [...byRun][0];
        current.push(...latestAttemptChecks(runId, checks));
        continue;
      }

      const customCheckRuns = group.every(
        (check) =>
          !check.detailsUrl?.includes("/actions/runs/") &&
          /\/runs\/\d+(?:[/?#]|$)/u.test(check.detailsUrl ?? ""),
      );
      if (customCheckRuns) {
        const timestamped = group.map((check) => ({
          check,
          timestamp: parseGitHubTimestamp(check.startedAt ?? check.completedAt),
        }));
        if (timestamped.every(({ timestamp }) => Number.isFinite(timestamp))) {
          const latestTimestamp = Math.max(...timestamped.map(({ timestamp }) => timestamp));
          current.push(
            ...timestamped
              .filter(({ timestamp }) => timestamp === latestTimestamp)
              .map(({ check }) => check),
          );
          continue;
        }
      }

      // Keep duplicate jobs from one workflow run together. This prevents a
      // later-starting matrix job from hiding another job's failure.
      current.push(...group);
      continue;
    }

    const timestamped = group.map((check) => ({
      check,
      timestamp: parseGitHubTimestamp(check.startedAt ?? check.completedAt),
    }));
    if (timestamped.some(({ timestamp }) => !Number.isFinite(timestamp))) {
      current.push(...group);
      continue;
    }
    const latestTimestamp = Math.max(...timestamped.map(({ timestamp }) => timestamp));
    current.push(
      ...timestamped
        .filter(({ timestamp }) => timestamp === latestTimestamp)
        .map(({ check }) => check),
    );
  }
  const prCiRunIds = new Set<string>();
  const prCiNames = new Set<string>();
  for (const check of current) {
    const name = check.name ?? check.context;
    if (name !== "checks" && name !== "changes") continue;
    prCiNames.add(name);
    const runId = actionRunId(check);
    if (runId) prCiRunIds.add(runId);
  }
  if (prCiNames.size === 2 && prCiRunIds.size !== 1) {
    incompleteAttemptEvidence.add("checks");
    incompleteAttemptEvidence.add("changes");
  }
  return { checks: current, incompleteAttemptEvidence: [...incompleteAttemptEvidence].sort() };
}

function checkCi(
  statusCheckRollup: StatusCheck[] | null,
  repo: string,
  exactDiff: ExactDiffIdentity,
): GateResult & { failingChecks?: string[]; pendingChecks?: string[]; missingChecks?: string[] } {
  if (!statusCheckRollup || statusCheckRollup.length === 0) {
    return { pass: false, details: "No status checks found" };
  }

  const e2eCoordinationEvidence = fetchE2eCoordinationEvidence(repo, exactDiff);
  const rollup = currentCheckRollup(statusCheckRollup, repo, exactDiff, e2eCoordinationEvidence);
  const currentChecks = rollup.checks;
  const incompleteAttemptEvidence = new Set(rollup.incompleteAttemptEvidence);
  if (e2eCoordinationEvidence.valid !== true) {
    incompleteAttemptEvidence.add("E2E / PR Gate");
  }

  // Check that all required checks are present.
  // Fork PRs from first-time contributors need "Approve and run" before
  // pull_request workflows execute. Until then only pull_request_target
  // checks (like check-pr-limit) and external bots (CodeRabbit) appear.
  const presentNames = new Set(currentChecks.map((c) => c.name ?? c.context ?? "").filter(Boolean));
  const missingChecks = REQUIRED_CHECK_NAMES.filter((name) => !presentNames.has(name));
  if (missingChecks.length > 0) {
    return {
      pass: false,
      details: `${missingChecks.length} required check(s) not found — workflows may need approval`,
      missingChecks,
    };
  }

  const passing = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const failing: string[] = [];
  const pending: string[] = [];

  for (const check of currentChecks) {
    const checkName = check.name ?? check.context ?? "(unknown)";

    // StatusContext (e.g. CodeRabbit) uses `state` instead of `status`/`conclusion`.
    if (check.__typename === "StatusContext") {
      const state = (check.state ?? "").toUpperCase();
      if (!state || state === "PENDING") {
        pending.push(checkName);
      } else if (state !== "SUCCESS") {
        failing.push(`${checkName}: ${state}`);
      }
      continue;
    }

    // CheckRun uses `status` and `conclusion`.
    const conclusion = (check.conclusion ?? "").toUpperCase();
    const status = (check.status ?? "").toUpperCase();
    const requiredCheck = REQUIRED_CHECK_NAMES.includes(checkName);
    if (status !== "COMPLETED") {
      pending.push(checkName);
    } else if (!passing.has(conclusion) || (requiredCheck && conclusion !== "SUCCESS")) {
      failing.push(`${checkName}: ${conclusion}`);
    }
  }

  if (failing.length > 0) {
    return {
      pass: false,
      details: `${failing.length} failing check(s)`,
      failingChecks: failing,
      pendingChecks: pending,
    };
  }
  if (pending.length > 0) {
    return { pass: false, details: `${pending.length} pending check(s)`, pendingChecks: pending };
  }
  if (incompleteAttemptEvidence.size > 0) {
    const incompleteNames = [...incompleteAttemptEvidence].sort();
    return {
      pass: false,
      details: `${incompleteNames.length} check context(s) have incomplete latest-attempt evidence`,
      failingChecks: incompleteNames.map((name) => `${name}: latest attempt evidence incomplete`),
    };
  }
  return { pass: true, details: `All ${currentChecks.length} current checks green` };
}

// ---------------------------------------------------------------------------
// Gate 2: No conflicts
// ---------------------------------------------------------------------------

function checkConflicts(
  mergeable: string,
  mergeStateStatus: string,
  baseSha: string,
  currentBaseSha: string | null,
): GateResult & {
  mergeable?: string;
  mergeStateStatus?: string;
  baseSha?: string;
  currentBaseSha?: string;
} {
  const conflictStatus = (mergeable ?? "UNKNOWN").toUpperCase();
  const status = (mergeStateStatus ?? "UNKNOWN").toUpperCase();
  const currentBaseStates = new Set(["BLOCKED", "CLEAN", "HAS_HOOKS", "UNSTABLE"]);

  if (!currentBaseSha) {
    return {
      pass: false,
      details: "Unable to verify the current base branch revision",
      mergeable: conflictStatus,
      mergeStateStatus: status,
      baseSha,
    };
  }
  if (baseSha !== currentBaseSha) {
    return {
      pass: false,
      details: "PR branch is behind its base branch; refresh it before approval",
      mergeable: conflictStatus,
      mergeStateStatus: status,
      baseSha,
      currentBaseSha,
    };
  }
  if (conflictStatus === "MERGEABLE" && currentBaseStates.has(status)) {
    return {
      pass: true,
      details: "No merge conflicts",
      mergeable: conflictStatus,
      mergeStateStatus: status,
      baseSha,
      currentBaseSha,
    };
  }
  return {
    pass: false,
    details:
      status === "BEHIND"
        ? "PR branch is behind its base branch; refresh it before approval"
        : `Mergeability: ${conflictStatus}; merge state: ${status}`,
    mergeable: conflictStatus,
    mergeStateStatus: status,
    baseSha,
    currentBaseSha,
  };
}

function fetchCurrentBaseSha(repo: string, number: number): string | null {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) return null;

  const response = ghJson([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=query CurrentBaseRef($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { baseRef { target { oid } } }
      }
    }`,
  ]) as {
    data?: { repository?: { pullRequest?: { baseRef?: { target?: { oid?: unknown } } } } };
  } | null;
  const oid = response?.data?.repository?.pullRequest?.baseRef?.target?.oid;
  return typeof oid === "string" && /^[0-9a-f]{40}$/i.test(oid) ? oid : null;
}

// ---------------------------------------------------------------------------
// Gate 3: CodeRabbit
// ---------------------------------------------------------------------------

const SEVERITY_MARKERS = {
  critical: ["🔴 Critical", "_🔴 Critical_", "Critical:"],
  major: ["🟠 Major", "_🟠 Major_"],
  minor: ["🟡 Minor", "_🟡 Minor_"],
} as const;

const ADDRESSED_MARKERS = ["✅ Addressed in commit", "<review_comment_addressed>"];

function detectSeverity(body: string): "critical" | "major" | "minor" | "unknown" {
  for (const marker of SEVERITY_MARKERS.critical) {
    if (body.includes(marker)) return "critical";
  }
  for (const marker of SEVERITY_MARKERS.major) {
    if (body.includes(marker)) return "major";
  }
  for (const marker of SEVERITY_MARKERS.minor) {
    if (body.includes(marker)) return "minor";
  }
  return "unknown";
}

function isAddressed(body: string): boolean {
  return ADDRESSED_MARKERS.some((m) => body.includes(m));
}

function checkCodeRabbit(
  repo: string,
  number: number,
): GateResult & { unresolvedThreads?: CodeRabbitThread[] } {
  const query = `query($owner:String!, $repo:String!, $number:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        reviewThreads(first:100) {
          nodes {
            isResolved
            comments(first:20) {
              nodes { author { login } body path }
            }
          }
        }
      }
    }
  }`;

  const [owner, repoName] = repo.split("/");
  const out = run("gh", [
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repoName}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=${query}`,
  ]);

  // Fail-closed: if we cannot reach the API, do not assume clean
  if (!out) {
    return { pass: false, details: "Could not fetch review threads (API error — fail-closed)" };
  }

  let data: {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              isResolved: boolean;
              comments: { nodes: Array<{ author: { login: string }; body: string; path: string }> };
            }>;
          };
        };
      };
    };
  };
  try {
    data = JSON.parse(out);
  } catch {
    return { pass: false, details: "Could not parse review threads (invalid JSON — fail-closed)" };
  }

  const threads = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const unresolved: CodeRabbitThread[] = [];

  for (const thread of threads) {
    if (thread.isResolved) continue;

    const comments = thread.comments.nodes;
    const coderabbitComments = comments.filter((c) =>
      CODERABBIT_LOGINS.has(c.author?.login?.toLowerCase()),
    );

    for (const comment of coderabbitComments) {
      if (isAddressed(comment.body)) continue;
      const severity = detectSeverity(comment.body);
      if (severity === "critical" || severity === "major") {
        unresolved.push({
          path: comment.path || "(unknown)",
          severity,
          snippet: comment.body.slice(0, 200),
          resolved: false,
        });
      }
    }
  }

  if (unresolved.length === 0) {
    return { pass: true, details: "No unresolved major/critical CodeRabbit findings" };
  }
  return {
    pass: false,
    details: `${unresolved.length} unresolved major/critical CodeRabbit finding(s)`,
    unresolvedThreads: unresolved,
  };
}

// ---------------------------------------------------------------------------
// Gate 4: Risky code has tests
// ---------------------------------------------------------------------------

function checkRiskyCodeTested(
  files: Array<{ path: string; status: string }>,
): GateResult & { riskyFiles?: string[]; hasTests?: boolean } {
  const riskyFiles = files.map((f) => f.path).filter(isRiskyFile);
  if (riskyFiles.length === 0) {
    return { pass: true, details: "No risky files changed" };
  }

  const hasTests = files.some((f) => isTestFile(f.path));
  if (hasTests) {
    return {
      pass: true,
      details: `${riskyFiles.length} risky file(s) changed; test files present in PR`,
      riskyFiles,
      hasTests: true,
    };
  }

  return {
    pass: false,
    details: `${riskyFiles.length} risky file(s) changed but no test files in PR`,
    riskyFiles,
    hasTests: false,
  };
}

// ---------------------------------------------------------------------------
// Gate 6: Contributor compliance
// ---------------------------------------------------------------------------

const DCO_DECLARATION = /^Signed-off-by:\s+.+\s+<[^<>\s]+@[^<>\s]+>\s*$/mu;
const DCO_BODY_BYPASS_AUTHORS = new Set(["app/dependabot", "dependabot[bot]"]);

interface CommitVerificationRecord {
  sha: string;
  verified: boolean;
  reason: string;
}

function normalizeCommitVerification(value: unknown): CommitVerificationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { sha: "(unknown)", verified: false, reason: "malformed_commit_verification_data" };
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.sha !== "string" ||
    typeof record.verified !== "boolean" ||
    typeof record.reason !== "string"
  ) {
    return {
      sha: typeof record.sha === "string" ? record.sha : "(unknown)",
      verified: false,
      reason: "malformed_commit_verification_data",
    };
  }

  return { sha: record.sha, verified: record.verified, reason: record.reason };
}

function checkContributorCompliance(
  repo: string,
  number: number,
  body: string,
  authorLogin: string | null,
): GateResult & {
  dcoDeclarationPresent?: boolean;
  dcoDeclarationBypassed?: boolean;
  unverifiedCommits?: Array<{ sha: string; reason: string }>;
} {
  const dcoDeclarationPresent = DCO_DECLARATION.test(body ?? "");
  const dcoDeclarationBypassed =
    typeof authorLogin === "string" && DCO_BODY_BYPASS_AUTHORS.has(authorLogin.toLowerCase());
  const raw = run("gh", [
    "api",
    `repos/${repo}/pulls/${number}/commits`,
    "--paginate",
    "--jq",
    '.[] | {sha, verified: (.commit.verification.verified // false), reason: (.commit.verification.reason // "unknown")}',
  ]);

  if (!raw) {
    return {
      pass: false,
      details: "Could not verify PR commit signatures (API error — fail-closed)",
      dcoDeclarationPresent,
      dcoDeclarationBypassed,
    };
  }

  const commits: CommitVerificationRecord[] = [];
  try {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) commits.push(normalizeCommitVerification(JSON.parse(trimmed) as unknown));
    }
  } catch {
    return {
      pass: false,
      details: "Could not parse PR commit signature data — fail-closed",
      dcoDeclarationPresent,
      dcoDeclarationBypassed,
    };
  }

  if (commits.length === 0) {
    return {
      pass: false,
      details: "No PR commits returned while checking contributor compliance — fail-closed",
      dcoDeclarationPresent,
      dcoDeclarationBypassed,
    };
  }

  const unverifiedCommits = commits
    .filter((commit) => commit.verified !== true)
    .map(({ sha, reason }) => ({ sha, reason }));
  if ((!dcoDeclarationPresent && !dcoDeclarationBypassed) || unverifiedCommits.length > 0) {
    const failures = [
      ...(dcoDeclarationPresent || dcoDeclarationBypassed
        ? []
        : ["PR body lacks a valid Signed-off-by declaration"]),
      ...(unverifiedCommits.length > 0
        ? [`${unverifiedCommits.length} commit(s) are not GitHub Verified`]
        : []),
    ];
    return {
      pass: false,
      details: failures.join("; "),
      dcoDeclarationPresent,
      dcoDeclarationBypassed,
      unverifiedCommits,
    };
  }

  return {
    pass: true,
    details: `${dcoDeclarationBypassed ? `PR-body DCO declaration bypassed for ${authorLogin}` : "DCO declaration present"}; all ${commits.length} commit(s) are GitHub Verified`,
    dcoDeclarationPresent,
    dcoDeclarationBypassed,
    unverifiedCommits: [],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface PrRevisionSnapshot {
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  baseRefName: string;
  headRepository: string;
}

function fetchPrRevisionSnapshot(repo: string, number: number): PrRevisionSnapshot | null {
  const value = ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "title,body,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,headRefName,baseRefName,headRepository",
  ]);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const headRepository = record.headRepository;
  if (
    typeof record.title !== "string" ||
    typeof record.body !== "string" ||
    typeof record.state !== "string" ||
    typeof record.isDraft !== "boolean" ||
    typeof record.mergeable !== "string" ||
    typeof record.mergeStateStatus !== "string" ||
    typeof record.headRefOid !== "string" ||
    typeof record.baseRefOid !== "string" ||
    typeof record.headRefName !== "string" ||
    typeof record.baseRefName !== "string" ||
    typeof headRepository !== "object" ||
    headRepository === null ||
    Array.isArray(headRepository) ||
    typeof (headRepository as Record<string, unknown>).nameWithOwner !== "string"
  ) {
    return null;
  }
  return {
    title: record.title,
    body: record.body,
    state: record.state,
    isDraft: record.isDraft,
    mergeable: record.mergeable,
    mergeStateStatus: record.mergeStateStatus,
    headRefOid: record.headRefOid,
    baseRefOid: record.baseRefOid,
    headRefName: record.headRefName,
    baseRefName: record.baseRefName,
    headRepository: (headRepository as Record<string, unknown>).nameWithOwner as string,
  };
}

function checkFinalRevision(
  captured: PrRevisionSnapshot,
  current: PrRevisionSnapshot | null,
  currentBaseSha: string | null,
): ReturnType<typeof checkConflicts> {
  if (!current) {
    return {
      pass: false,
      details: "Unable to re-read the PR revision after gate evaluation",
      mergeable: captured.mergeable,
      mergeStateStatus: captured.mergeStateStatus,
      baseSha: captured.baseRefOid,
    };
  }
  if (current.state.toUpperCase() !== "OPEN" || current.isDraft) {
    return {
      pass: false,
      details: current.isDraft
        ? "PR became a draft during gate evaluation"
        : "PR is no longer open",
      mergeable: current.mergeable,
      mergeStateStatus: current.mergeStateStatus,
      baseSha: current.baseRefOid,
      ...(currentBaseSha ? { currentBaseSha } : {}),
    };
  }
  const changed =
    current.title !== captured.title ||
    current.body !== captured.body ||
    current.state !== captured.state ||
    current.isDraft !== captured.isDraft ||
    current.mergeable !== captured.mergeable ||
    current.mergeStateStatus !== captured.mergeStateStatus ||
    current.headRefOid !== captured.headRefOid ||
    current.baseRefOid !== captured.baseRefOid ||
    current.headRefName !== captured.headRefName ||
    current.baseRefName !== captured.baseRefName ||
    current.headRepository !== captured.headRepository;
  if (changed) {
    return {
      pass: false,
      details: "PR revision or merge state changed during gate evaluation; rerun the gate checker",
      mergeable: current.mergeable,
      mergeStateStatus: current.mergeStateStatus,
      baseSha: current.baseRefOid,
      ...(currentBaseSha ? { currentBaseSha } : {}),
    };
  }
  return checkConflicts(
    current.mergeable,
    current.mergeStateStatus,
    current.baseRefOid,
    currentBaseSha,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: check-gates.ts <pr-number> [--repo OWNER/REPO]");
    process.exit(1);
  }

  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  const prData = ghJson([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "number,title,url,body,files,statusCheckRollup,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,headRefName,baseRefName,headRepository,author",
  ]) as {
    number: number;
    title: string;
    url: string;
    body: string;
    files: Array<{ path: string; status: string }>;
    statusCheckRollup: StatusCheck[];
    state: string;
    isDraft: boolean;
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
    baseRefOid: string;
    headRefName: string;
    baseRefName: string;
    headRepository: { nameWithOwner: string };
    author: PrIdentity | null;
  } | null;

  if (!prData) {
    console.error(`Failed to fetch PR #${prNumber} from ${repo}`);
    process.exit(1);
  }

  const ci = checkCi(prData.statusCheckRollup, repo, {
    number: prNumber,
    headSha: prData.headRefOid,
    baseSha: prData.baseRefOid,
    headRefName: prData.headRefName,
    headRepository: prData.headRepository.nameWithOwner,
  });
  const coderabbit = checkCodeRabbit(repo, prNumber);
  const riskyCodeTested = checkRiskyCodeTested(prData.files ?? []);
  const contributorCompliance = checkContributorCompliance(
    repo,
    prNumber,
    prData.body ?? "",
    prData.author?.login ?? null,
  );
  const contributorApprovalHistory = fetchContributorApprovalHistory(repo, prNumber);
  const contributorApprovalOverlap = checkContributorApprovalOverlap(
    prData,
    contributorApprovalHistory,
  );
  const currentBaseSha = fetchCurrentBaseSha(repo, prNumber);
  const currentRevision = fetchPrRevisionSnapshot(repo, prNumber);
  const conflicts = checkFinalRevision(
    {
      title: prData.title,
      body: prData.body,
      state: prData.state,
      isDraft: prData.isDraft,
      mergeable: prData.mergeable,
      mergeStateStatus: prData.mergeStateStatus,
      headRefOid: prData.headRefOid,
      baseRefOid: prData.baseRefOid,
      headRefName: prData.headRefName,
      baseRefName: prData.baseRefName,
      headRepository: prData.headRepository.nameWithOwner,
    },
    currentRevision,
    currentBaseSha,
  );

  const output: GateOutput = {
    pr: prNumber,
    url: prData.url,
    title: prData.title,
    allPass:
      ci.pass &&
      conflicts.pass &&
      coderabbit.pass &&
      riskyCodeTested.pass &&
      contributorCompliance.pass,
    gates: { ci, conflicts, coderabbit, riskyCodeTested, contributorCompliance },
    advisories: { contributorApprovalOverlap },
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
