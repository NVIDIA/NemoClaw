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

import { isDeepStrictEqual } from "node:util";
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
  enclosingCoordinatorStartedAt?: number;
  enclosingCoordinatorCompletedAt?: number;
  trustedCustomCheckId?: number;
  checkSnapshot?: E2eCoordinationCheckSnapshot;
  coordinatorSnapshot?: E2eCoordinatorInventorySnapshot;
  selectedCheckId?: number;
}

interface E2eCoordinationCheckSnapshot {
  checkRuns: Array<Record<string, unknown>>;
}

interface E2eCoordinatorRunMetadata {
  id: number;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  event: E2eCoordinatorEvent;
  displayTitle: string;
  headSha: string;
  status: string;
  conclusion: string | null;
}

type E2eCoordinatorEvent = "workflow_run" | "workflow_dispatch";

interface E2eCoordinatorRunPartition {
  startedAt: number;
  completedAt: number;
}

interface E2eCoordinatorInventoryRecord {
  value: Record<string, unknown>;
  createdAt: number;
  event: E2eCoordinatorEvent;
  partitionIndex: number;
}

interface E2eCoordinatorCandidateSnapshot {
  listedRun: Record<string, unknown>;
  firstRun: Record<string, unknown>;
  jobPages: unknown[];
  refreshedRun: Record<string, unknown>;
}

interface E2eCoordinatorInventorySnapshot {
  candidates: E2eCoordinatorCandidateSnapshot[];
}

interface E2eCoordinatorEvaluation {
  valid: boolean | null;
  snapshot?: E2eCoordinatorInventorySnapshot;
  coordinateStartedAt?: number;
  coordinateCompletedAt?: number;
}

const E2E_RETRYABLE_FAILURE_MARKER_PREFIX = "<!-- nemoclaw-pr-e2e-retry:v1:";
const E2E_RETRYABLE_FAILURE_MARKER_SUFFIX = " -->";
const E2E_RETRYABLE_FAILURE_REASONS = new Set([
  "prerequisite-ci",
  "child-cancelled",
  "evidence-download",
]);
const E2E_NEVER_RETRY_FAILURE_TITLES = new Set([
  "Authorized E2E run requires reconciliation",
  "PR base changed",
  "Controller stopped early",
  "Run could not start",
]);
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

const E2E_COORDINATOR_WORKFLOW_PATH = ".github/workflows/pr-e2e-gate.yaml";
const E2E_COORDINATOR_PARTITION_MS = 12 * 60 * 60 * 1000;
const E2E_COORDINATOR_INVENTORY_MAX_MS = 14 * 24 * 60 * 60 * 1000;
const E2E_COORDINATOR_MAX_PARTITIONS = Math.ceil(
  E2E_COORDINATOR_INVENTORY_MAX_MS / E2E_COORDINATOR_PARTITION_MS,
);
const GITHUB_WORKFLOW_RUN_RESULT_CAP = 1000;
const E2E_COORDINATOR_RUN_PAGE_PROJECTION =
  "{total_count,workflow_runs:[.workflow_runs[]|{id,run_attempt,event,display_title,path," +
  "head_branch,head_sha,status,conclusion,repository:{full_name:.repository.full_name}," +
  "head_repository:{full_name:.head_repository.full_name},created_at,updated_at}]}";

function formatGitHubTimestamp(value: number): string {
  return new Date(value).toISOString().replace(".000Z", "Z");
}

function ghJsonPages(args: string[]): unknown[] | null {
  const output = run("gh", args);
  if (!output) return null;
  try {
    return output.split("\n").map((page) => JSON.parse(page));
  } catch {
    process.stderr.write(
      `[check-gates] The gate checker could not parse a JSON page from this command: gh ${args.join(" ")}\n`,
    );
    return null;
  }
}

function e2eCoordinatorRunPartitions(
  historyStartedAt: number,
  observationAt: number,
): E2eCoordinatorRunPartition[] | null {
  if (!Number.isFinite(historyStartedAt) || !Number.isFinite(observationAt)) return null;
  const checkStart = new Date(historyStartedAt);
  const inventoryStartedAt = Date.UTC(
    checkStart.getUTCFullYear(),
    checkStart.getUTCMonth(),
    checkStart.getUTCDate() - 1,
  );
  const inventoryCompletedAt = Math.ceil(observationAt / 1000) * 1000;
  const inventorySpan = inventoryCompletedAt - inventoryStartedAt;
  const partitionCount = Math.ceil(inventorySpan / E2E_COORDINATOR_PARTITION_MS);
  if (
    inventorySpan <= 0 ||
    inventorySpan > E2E_COORDINATOR_INVENTORY_MAX_MS ||
    !Number.isSafeInteger(partitionCount) ||
    partitionCount < 1 ||
    partitionCount > E2E_COORDINATOR_MAX_PARTITIONS
  ) {
    return null;
  }
  return Array.from({ length: partitionCount }, (_value, index) => {
    const startedAt = inventoryStartedAt + index * E2E_COORDINATOR_PARTITION_MS;
    return {
      startedAt,
      completedAt: Math.min(startedAt + E2E_COORDINATOR_PARTITION_MS, inventoryCompletedAt),
    };
  });
}

function automaticE2eCoordinatorRunTitle(exactDiff: ExactDiffIdentity): string {
  return (
    "E2E Gate coordinate from CI PR #" +
    exactDiff.number +
    " head " +
    exactDiff.headSha +
    " base " +
    exactDiff.baseSha +
    " gate true"
  );
}

function manualE2eCoordinatorRunTitle(exactDiff: ExactDiffIdentity): string {
  return (
    "E2E Gate approve PR #" +
    exactDiff.number +
    " head " +
    exactDiff.headSha +
    " base " +
    exactDiff.baseSha
  );
}

function hasRepositoryName(value: unknown, repo: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).full_name === repo
  );
}

function parseE2eCoordinatorRun(
  value: unknown,
  repo: string,
  exactDiff: ExactDiffIdentity,
  trustedWorkflowSha: string | null,
): E2eCoordinatorRunMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const createdAt =
    typeof record.created_at === "string" ? parseGitHubTimestamp(record.created_at) : Number.NaN;
  const updatedAt =
    typeof record.updated_at === "string" ? parseGitHubTimestamp(record.updated_at) : Number.NaN;
  const status = typeof record.status === "string" ? record.status.toUpperCase() : null;
  const conclusion =
    typeof record.conclusion === "string" ? record.conclusion.toUpperCase() : record.conclusion;
  const event =
    record.event === "workflow_run" || record.event === "workflow_dispatch" ? record.event : null;
  const expectedTitle =
    event === "workflow_run"
      ? automaticE2eCoordinatorRunTitle(exactDiff)
      : event === "workflow_dispatch"
        ? manualE2eCoordinatorRunTitle(exactDiff)
        : null;
  const headSha = typeof record.head_sha === "string" ? record.head_sha : "";
  if (
    !Number.isSafeInteger(record.id) ||
    (record.id as number) < 1 ||
    record.run_attempt !== 1 ||
    !event ||
    !expectedTitle ||
    record.display_title !== expectedTitle ||
    record.path !== E2E_COORDINATOR_WORKFLOW_PATH ||
    record.head_branch !== "main" ||
    !/^[0-9a-f]{40}$/u.test(headSha) ||
    trustedWorkflowSha === null ||
    headSha !== trustedWorkflowSha ||
    !status ||
    !ACTION_STATUSES.has(status) ||
    (conclusion !== null &&
      (typeof conclusion !== "string" || !ACTION_CONCLUSIONS.has(conclusion))) ||
    (status === "COMPLETED" ? conclusion === null : conclusion !== null) ||
    !hasRepositoryName(record.repository, repo) ||
    !hasRepositoryName(record.head_repository, repo) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt) ||
    createdAt > updatedAt
  ) {
    return null;
  }
  return {
    id: record.id as number,
    attempt: 1,
    createdAt,
    updatedAt,
    event,
    displayTitle: expectedTitle,
    headSha,
    status,
    conclusion,
  };
}

function sameE2eCoordinatorRun(
  left: E2eCoordinatorRunMetadata,
  right: E2eCoordinatorRunMetadata,
): boolean {
  return (
    left.id === right.id &&
    left.attempt === right.attempt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.event === right.event &&
    left.displayTitle === right.displayTitle &&
    left.headSha === right.headSha &&
    left.status === right.status &&
    left.conclusion === right.conclusion
  );
}

type E2eCoordinatorCandidateResult =
  | "authorization-predecessor"
  | "enclosing"
  | "history"
  | false
  | null;

interface E2eCoordinatorCandidateEvaluation {
  result: E2eCoordinatorCandidateResult;
  snapshot?: E2eCoordinatorCandidateSnapshot;
  event?: E2eCoordinatorEvent;
  runCreatedAt?: number;
  runUpdatedAt?: number;
  coordinateStartedAt?: number;
  coordinateCompletedAt?: number;
}

function evaluateE2eCoordinatorCandidate(
  listedValue: unknown,
  repo: string,
  exactDiff: ExactDiffIdentity,
  trustedWorkflowSha: string | null,
  coordinationStartedAt: number,
  coordinationCompletedAt: number,
): E2eCoordinatorCandidateEvaluation {
  const listedRun = parseE2eCoordinatorRun(listedValue, repo, exactDiff, trustedWorkflowSha);
  if (!listedRun) return { result: false };
  const firstRunResponse = ghJson(["api", "repos/" + repo + "/actions/runs/" + listedRun.id]);
  if (firstRunResponse === null) return { result: null };
  const firstRun = parseE2eCoordinatorRun(firstRunResponse, repo, exactDiff, trustedWorkflowSha);
  if (!firstRun || !sameE2eCoordinatorRun(listedRun, firstRun)) return { result: false };

  const jobPages = ghJson([
    "api",
    "--paginate",
    "--slurp",
    "repos/" +
      repo +
      "/actions/runs/" +
      firstRun.id +
      "/attempts/" +
      firstRun.attempt +
      "/jobs?per_page=100",
  ]);
  if (!Array.isArray(jobPages) || jobPages.length === 0) return { result: null };

  let expectedJobs: number | null = null;
  let observedJobs = 0;
  const jobIds = new Set<number>();
  const coordinateJobs: Array<Record<string, unknown>> = [];
  for (const page of jobPages) {
    if (typeof page !== "object" || page === null || Array.isArray(page)) {
      return { result: null };
    }
    const { total_count: totalCount, jobs } = page as Record<string, unknown>;
    if (
      !Number.isSafeInteger(totalCount) ||
      (totalCount as number) < 0 ||
      (expectedJobs !== null && totalCount !== expectedJobs) ||
      !Array.isArray(jobs)
    ) {
      return { result: null };
    }
    expectedJobs = totalCount as number;
    observedJobs += jobs.length;
    for (const value of jobs) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { result: null };
      }
      const record = value as Record<string, unknown>;
      if (
        !Number.isSafeInteger(record.id) ||
        (record.id as number) < 1 ||
        jobIds.has(record.id as number) ||
        typeof record.name !== "string" ||
        !record.name
      ) {
        return { result: false };
      }
      jobIds.add(record.id as number);
      if (record.name === "coordinate") coordinateJobs.push(record);
    }
  }

  const refreshedRunResponse = ghJson(["api", "repos/" + repo + "/actions/runs/" + firstRun.id]);
  if (refreshedRunResponse === null) return { result: null };
  const refreshedRun = parseE2eCoordinatorRun(
    refreshedRunResponse,
    repo,
    exactDiff,
    trustedWorkflowSha,
  );
  if (!refreshedRun || !sameE2eCoordinatorRun(firstRun, refreshedRun)) {
    return { result: false };
  }

  const snapshot: E2eCoordinatorCandidateSnapshot = {
    listedRun: listedValue as Record<string, unknown>,
    firstRun: firstRunResponse as Record<string, unknown>,
    jobPages,
    refreshedRun: refreshedRunResponse as Record<string, unknown>,
  };
  if (
    expectedJobs === null ||
    observedJobs !== expectedJobs ||
    jobIds.size !== expectedJobs ||
    coordinateJobs.length !== 1
  ) {
    return { result: false, snapshot };
  }

  const coordinate = coordinateJobs[0];
  const coordinateStatus =
    typeof coordinate.status === "string" ? coordinate.status.toUpperCase() : null;
  const coordinateConclusion =
    typeof coordinate.conclusion === "string"
      ? coordinate.conclusion.toUpperCase()
      : coordinate.conclusion;
  const coordinateStartedAt =
    typeof coordinate.started_at === "string"
      ? parseGitHubTimestamp(coordinate.started_at)
      : Number.NaN;
  const coordinateCompletedAt =
    typeof coordinate.completed_at === "string"
      ? parseGitHubTimestamp(coordinate.completed_at)
      : Number.NaN;
  if (
    !coordinateStatus ||
    !ACTION_STATUSES.has(coordinateStatus) ||
    (coordinateConclusion !== null &&
      (typeof coordinateConclusion !== "string" ||
        !ACTION_CONCLUSIONS.has(coordinateConclusion))) ||
    (coordinateStatus === "COMPLETED"
      ? coordinateConclusion === null
      : coordinateConclusion !== null) ||
    !Number.isFinite(coordinateStartedAt) ||
    !Number.isFinite(coordinateCompletedAt) ||
    coordinateStartedAt > coordinateCompletedAt
  ) {
    return { result: false, snapshot };
  }

  const completedSuccessfully =
    firstRun.status === "COMPLETED" &&
    firstRun.conclusion === "SUCCESS" &&
    coordinateStatus === "COMPLETED" &&
    coordinateConclusion === "SUCCESS";
  const coordinateWithinRun =
    firstRun.createdAt <= coordinateStartedAt &&
    coordinateStartedAt <= coordinateCompletedAt &&
    coordinateCompletedAt <= firstRun.updatedAt;
  const candidateEvidence = {
    snapshot,
    event: firstRun.event,
    runCreatedAt: firstRun.createdAt,
    runUpdatedAt: firstRun.updatedAt,
    coordinateStartedAt,
    coordinateCompletedAt,
  };
  if (
    completedSuccessfully &&
    coordinateWithinRun &&
    coordinateStartedAt <= coordinationCompletedAt &&
    coordinationCompletedAt <= coordinateCompletedAt
  ) {
    return { result: "enclosing", ...candidateEvidence };
  }

  const completedHistory =
    completedSuccessfully && coordinateWithinRun && firstRun.updatedAt <= coordinationStartedAt;
  if (completedHistory) return { result: "history", ...candidateEvidence };

  const authorizationPredecessor =
    completedSuccessfully &&
    coordinateWithinRun &&
    firstRun.event === "workflow_run" &&
    coordinationStartedAt <= coordinateStartedAt &&
    coordinateCompletedAt < coordinationCompletedAt;
  return {
    result: authorizationPredecessor ? "authorization-predecessor" : false,
    ...candidateEvidence,
  };
}

function fetchE2eCoordinatorEvidence(
  repo: string,
  exactDiff: ExactDiffIdentity,
  trustedWorkflowSha: string | null,
  historyStartedAt: number,
  coordinationStartedAt: number,
  coordinationCompletedAt: number,
  observationAt: number,
): E2eCoordinatorEvaluation {
  const inventoryById = new Map<number, E2eCoordinatorInventoryRecord>();
  const partitions = e2eCoordinatorRunPartitions(historyStartedAt, observationAt);
  if (!partitions) return { valid: null };
  const events: E2eCoordinatorEvent[] = ["workflow_run", "workflow_dispatch"];
  for (const event of events) {
    for (const [partitionIndex, partition] of partitions.entries()) {
      const createdRange = encodeURIComponent(
        formatGitHubTimestamp(partition.startedAt) +
          ".." +
          formatGitHubTimestamp(partition.completedAt),
      );
      const pages = ghJsonPages([
        "api",
        "--paginate",
        "--jq",
        E2E_COORDINATOR_RUN_PAGE_PROJECTION,
        "repos/" +
          repo +
          "/actions/workflows/pr-e2e-gate.yaml/runs?event=" +
          event +
          "&created=" +
          createdRange +
          "&per_page=100",
      ]);
      if (!Array.isArray(pages) || pages.length === 0) return { valid: null };

      let expectedTotal: number | null = null;
      let observedTotal = 0;
      const partitionIds = new Set<number>();
      const partitionRecords: Array<{ value: Record<string, unknown>; createdAt: number }> = [];
      for (const page of pages) {
        if (typeof page !== "object" || page === null || Array.isArray(page)) {
          return { valid: null };
        }
        const { total_count: totalCount, workflow_runs: workflowRuns } = page as Record<
          string,
          unknown
        >;
        if (
          !Number.isSafeInteger(totalCount) ||
          (totalCount as number) < 0 ||
          (totalCount as number) >= GITHUB_WORKFLOW_RUN_RESULT_CAP ||
          (expectedTotal !== null && totalCount !== expectedTotal) ||
          !Array.isArray(workflowRuns)
        ) {
          return { valid: null };
        }
        expectedTotal = totalCount as number;
        observedTotal += workflowRuns.length;
        for (const value of workflowRuns) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return { valid: null };
          }
          const record = value as Record<string, unknown>;
          const createdAt =
            typeof record.created_at === "string"
              ? parseGitHubTimestamp(record.created_at)
              : Number.NaN;
          if (
            !Number.isSafeInteger(record.id) ||
            (record.id as number) < 1 ||
            partitionIds.has(record.id as number) ||
            record.event !== event ||
            !Number.isFinite(createdAt) ||
            createdAt < partition.startedAt ||
            createdAt > partition.completedAt
          ) {
            return { valid: null };
          }
          partitionIds.add(record.id as number);
          partitionRecords.push({ value: record, createdAt });
        }
      }
      if (
        expectedTotal === null ||
        observedTotal !== expectedTotal ||
        partitionIds.size !== expectedTotal
      ) {
        return { valid: null };
      }

      for (const record of partitionRecords) {
        const id = record.value.id as number;
        const existing = inventoryById.get(id);
        if (!existing) {
          inventoryById.set(id, {
            value: record.value,
            createdAt: record.createdAt,
            event,
            partitionIndex,
          });
          continue;
        }
        const exactBoundaryDuplicate =
          existing.event === event &&
          existing.partitionIndex === partitionIndex - 1 &&
          existing.createdAt === partition.startedAt &&
          record.createdAt === partition.startedAt &&
          isDeepStrictEqual(existing.value, record.value);
        if (!exactBoundaryDuplicate) return { valid: null };
      }
    }
  }

  const expectedTitles = new Set([
    automaticE2eCoordinatorRunTitle(exactDiff),
    manualE2eCoordinatorRunTitle(exactDiff),
  ]);
  const candidates = [...inventoryById.values()]
    .map((record) => record.value)
    .filter((record) => expectedTitles.has(String(record.display_title)));
  if (candidates.length === 0) return { valid: false };

  const enclosingCandidates: E2eCoordinatorCandidateEvaluation[] = [];
  const authorizationPredecessors: E2eCoordinatorCandidateEvaluation[] = [];
  const candidateSnapshots: E2eCoordinatorCandidateSnapshot[] = [];
  for (const candidate of candidates) {
    const evaluation = evaluateE2eCoordinatorCandidate(
      candidate,
      repo,
      exactDiff,
      trustedWorkflowSha,
      coordinationStartedAt,
      coordinationCompletedAt,
    );
    if (evaluation.result === null) return { valid: null };
    if (evaluation.result === false || !evaluation.snapshot) return { valid: false };
    candidateSnapshots.push(evaluation.snapshot);
    if (evaluation.result === "enclosing") enclosingCandidates.push(evaluation);
    if (evaluation.result === "authorization-predecessor") {
      authorizationPredecessors.push(evaluation);
    }
  }
  if (enclosingCandidates.length !== 1) return { valid: false };
  const encloser = enclosingCandidates[0];
  if (
    !encloser ||
    encloser.coordinateStartedAt === undefined ||
    encloser.coordinateCompletedAt === undefined
  ) {
    return { valid: false };
  }
  const automaticLineage =
    encloser.event === "workflow_run" && authorizationPredecessors.length === 0;
  const predecessor = authorizationPredecessors[0];
  const authorizedForkLineage =
    exactDiff.headRepository !== repo &&
    encloser.event === "workflow_dispatch" &&
    authorizationPredecessors.length === 1 &&
    predecessor?.event === "workflow_run" &&
    predecessor.runUpdatedAt !== undefined &&
    encloser.runCreatedAt !== undefined &&
    predecessor.coordinateCompletedAt !== undefined &&
    encloser.coordinateStartedAt !== undefined &&
    predecessor.runUpdatedAt <= encloser.runCreatedAt &&
    predecessor.coordinateCompletedAt <= encloser.coordinateStartedAt;
  if (!automaticLineage && !authorizedForkLineage) {
    return { valid: false };
  }
  candidateSnapshots.sort(
    (left, right) => (left.listedRun.id as number) - (right.listedRun.id as number),
  );
  return {
    valid: true,
    snapshot: { candidates: candidateSnapshots },
    coordinateStartedAt: encloser.coordinateStartedAt,
    coordinateCompletedAt: encloser.coordinateCompletedAt,
  };
}

function hasRetryableE2eFailureMarker(check: Record<string, unknown>): boolean {
  if (check.status !== "completed" || check.conclusion !== "failure") return false;
  const output = check.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const { summary, title } = output as Record<string, unknown>;
  if (
    (title !== undefined && title !== null && typeof title !== "string") ||
    E2E_NEVER_RETRY_FAILURE_TITLES.has(typeof title === "string" ? title : "")
  ) {
    return false;
  }
  if (typeof summary !== "string") return false;
  const markerBoundary = `\n\n${E2E_RETRYABLE_FAILURE_MARKER_PREFIX}`;
  const markerStart = summary.lastIndexOf(markerBoundary);
  if (markerStart < 0) return false;
  const marker = summary.slice(markerStart + 2);
  if (!marker.endsWith(E2E_RETRYABLE_FAILURE_MARKER_SUFFIX)) return false;
  const reason = marker.slice(
    E2E_RETRYABLE_FAILURE_MARKER_PREFIX.length,
    -E2E_RETRYABLE_FAILURE_MARKER_SUFFIX.length,
  );
  return (
    E2E_RETRYABLE_FAILURE_REASONS.has(reason) &&
    marker ===
      `${E2E_RETRYABLE_FAILURE_MARKER_PREFIX}${reason}${E2E_RETRYABLE_FAILURE_MARKER_SUFFIX}`
  );
}

function currentE2eCoordinationCheck(
  checks: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (checks.length === 0) return undefined;
  const ordered = [...checks].sort((left, right) => (left.id as number) - (right.id as number));
  const active = ordered.filter((check) => check.status !== "completed");
  if (active.length > 1) return undefined;
  if (ordered.slice(0, -1).some((check) => !hasRetryableE2eFailureMarker(check))) {
    return undefined;
  }
  const current = ordered.at(-1)!;
  if (active[0] && active[0].id !== current.id) return undefined;
  return current;
}

function fetchE2eCoordinationCheckSnapshot(
  repo: string,
  exactDiff: ExactDiffIdentity,
): E2eCoordinationCheckSnapshot | null {
  const checkNames = ["E2E / PR Gate", "E2E / PR Gate Coordination"];
  const checkRuns: Array<Record<string, unknown>> = [];
  const ids = new Set<number>();
  for (const checkName of checkNames) {
    const pages = ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/commits/${exactDiff.headSha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`,
    ]);
    if (!Array.isArray(pages) || pages.length === 0) return null;

    let expectedTotal: number | null = null;
    let observedTotal = 0;
    for (const page of pages) {
      if (typeof page !== "object" || page === null || Array.isArray(page)) return null;
      const { total_count: totalCount, check_runs: pageRuns } = page as Record<string, unknown>;
      if (
        !Number.isSafeInteger(totalCount) ||
        (totalCount as number) < 0 ||
        (expectedTotal !== null && totalCount !== expectedTotal) ||
        !Array.isArray(pageRuns)
      ) {
        return null;
      }
      expectedTotal = totalCount as number;
      observedTotal += pageRuns.length;
      for (const value of pageRuns) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        if (
          !Number.isSafeInteger(record.id) ||
          (record.id as number) < 1 ||
          ids.has(record.id as number) ||
          (typeof record.external_id !== "string" && record.external_id !== null)
        ) {
          return null;
        }
        ids.add(record.id as number);
        checkRuns.push(record);
      }
    }
    if (
      expectedTotal === null ||
      observedTotal !== expectedTotal ||
      ids.size !== checkRuns.length
    ) {
      return null;
    }
  }

  checkRuns.sort((left, right) => (left.id as number) - (right.id as number));
  return { checkRuns };
}

function selectE2eCoordinationCheck(
  snapshot: E2eCoordinationCheckSnapshot,
  exactDiff: ExactDiffIdentity,
): Record<string, unknown> | undefined {
  const checkNames = ["E2E / PR Gate", "E2E / PR Gate Coordination"];
  const externalId = `nemoclaw-pr-e2e:v2:${exactDiff.number}:${exactDiff.headSha}:${exactDiff.baseSha}`;
  const claimedChecks = snapshot.checkRuns.filter((check) => check.external_id === externalId);
  if (
    claimedChecks.some(
      (check) =>
        check.head_sha !== exactDiff.headSha ||
        typeof check.name !== "string" ||
        !checkNames.includes(check.name) ||
        typeof check.app !== "object" ||
        check.app === null ||
        Array.isArray(check.app) ||
        (check.app as Record<string, unknown>).id !== 15368,
    )
  ) {
    return undefined;
  }
  const currentNameChecks = claimedChecks.filter((check) => check.name === "E2E / PR Gate");
  const exactChecks =
    currentNameChecks.length > 0
      ? currentNameChecks
      : claimedChecks.filter((check) => check.name === "E2E / PR Gate Coordination");
  return currentE2eCoordinationCheck(exactChecks);
}

interface E2eLineageCheckTiming {
  startedAt: number;
  completedAt: number;
}

function selectedE2eLineageTiming(
  snapshot: E2eCoordinationCheckSnapshot,
  exactDiff: ExactDiffIdentity,
  selectedCheckId: number,
): E2eLineageCheckTiming[] | null {
  const externalId = `nemoclaw-pr-e2e:v2:${exactDiff.number}:${exactDiff.headSha}:${exactDiff.baseSha}`;
  const claimedChecks = snapshot.checkRuns.filter((check) => check.external_id === externalId);
  const currentNameChecks = claimedChecks.filter((check) => check.name === "E2E / PR Gate");
  const exactChecks =
    currentNameChecks.length > 0
      ? currentNameChecks
      : claimedChecks.filter((check) => check.name === "E2E / PR Gate Coordination");
  if (currentE2eCoordinationCheck(exactChecks)?.id !== selectedCheckId) return null;

  const ordered = [...exactChecks].sort(
    (left, right) => (left.id as number) - (right.id as number),
  );
  const timing: E2eLineageCheckTiming[] = [];
  for (const check of ordered) {
    const startedAt =
      typeof check.started_at === "string" ? parseGitHubTimestamp(check.started_at) : Number.NaN;
    const completedAt =
      typeof check.completed_at === "string"
        ? parseGitHubTimestamp(check.completed_at)
        : Number.NaN;
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      startedAt > completedAt ||
      (timing.at(-1)?.completedAt ?? Number.NEGATIVE_INFINITY) > startedAt
    ) {
      return null;
    }
    timing.push({ startedAt, completedAt });
  }
  return timing.length > 0 ? timing : null;
}

function e2eCoordinationHistoryStartedAt(
  snapshot: E2eCoordinationCheckSnapshot,
  exactDiff: ExactDiffIdentity,
): number {
  const externalId = `nemoclaw-pr-e2e:v2:${exactDiff.number}:${exactDiff.headSha}:${exactDiff.baseSha}`;
  const claimedChecks = snapshot.checkRuns.filter((check) => check.external_id === externalId);
  if (claimedChecks.length === 0) return Number.NaN;

  let earliest = Number.POSITIVE_INFINITY;
  for (const check of claimedChecks) {
    const startedAt =
      typeof check.started_at === "string" ? parseGitHubTimestamp(check.started_at) : Number.NaN;
    const completedAt =
      typeof check.completed_at === "string"
        ? parseGitHubTimestamp(check.completed_at)
        : Number.NaN;
    if (
      !Number.isFinite(startedAt) ||
      (check.status === "completed" && (!Number.isFinite(completedAt) || startedAt > completedAt))
    ) {
      return Number.NaN;
    }
    earliest = Math.min(earliest, startedAt);
  }
  return earliest;
}

function fetchE2eCoordinationEvidence(
  repo: string,
  exactDiff: ExactDiffIdentity,
  trustedWorkflowSha: string | null,
): E2eCoordinationEvidence {
  const checkSnapshot = fetchE2eCoordinationCheckSnapshot(repo, exactDiff);
  if (!checkSnapshot) return { valid: null };
  const exact = selectE2eCoordinationCheck(checkSnapshot, exactDiff);
  if (!exact) return { valid: false };
  const checkNames = ["E2E / PR Gate", "E2E / PR Gate Coordination"];
  const app = exact.app;
  const startedAt =
    typeof exact.started_at === "string" ? parseGitHubTimestamp(exact.started_at) : Number.NaN;
  const completedAt =
    typeof exact.completed_at === "string" ? parseGitHubTimestamp(exact.completed_at) : Number.NaN;
  const historyStartedAt = e2eCoordinationHistoryStartedAt(checkSnapshot, exactDiff);
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
    Number.isFinite(historyStartedAt) &&
    startedAt <= completedAt;
  const coordinator = valid
    ? fetchE2eCoordinatorEvidence(
        repo,
        exactDiff,
        trustedWorkflowSha,
        historyStartedAt,
        startedAt,
        completedAt,
        Date.now(),
      )
    : { valid: false };
  const completeEvidence =
    valid &&
    coordinator.valid === true &&
    Boolean(coordinator.snapshot) &&
    typeof coordinator.coordinateStartedAt === "number" &&
    typeof coordinator.coordinateCompletedAt === "number";
  return {
    valid: coordinator.valid === null ? null : completeEvidence,
    ...(completeEvidence ? { startedAt, completedAt } : {}),
    ...(completeEvidence
      ? {
          checkSnapshot,
          coordinatorSnapshot: coordinator.snapshot,
          selectedCheckId: exact.id as number,
          enclosingCoordinatorStartedAt: coordinator.coordinateStartedAt,
          enclosingCoordinatorCompletedAt: coordinator.coordinateCompletedAt,
        }
      : {}),
    ...(completeEvidence && exact.name === "E2E / PR Gate"
      ? { trustedCustomCheckId: exact.id as number }
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
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
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
const PR_REVIEW_ADVISOR_WORKFLOW_NAME = "Automation / PR Review Advisor";
const PR_REVIEW_ADVISOR_WORKFLOW_PATH = ".github/workflows/pr-review-advisor.yaml";
const ADVISORY_PR_REVIEW_ADVISOR_JOB_NAMES = new Set([
  "Discover review specialists and collect GitHub context",
  "Publish advisor link",
]);
const ADVISORY_PR_REVIEW_ADVISOR_SPECIALIST_JOB = /^Specialist \/ [^/]+$/u;

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
  startedAt: number | null;
  completedAt: number | null;
}

interface CiActionEvidenceCache {
  actionRunMetadataById: Map<string, ActionRunMetadata | null>;
  latestAttemptJobsByRun: Map<string, Map<string, ActionJobMetadata> | null>;
}

function createCiActionEvidenceCache(): CiActionEvidenceCache {
  return {
    actionRunMetadataById: new Map(),
    latestAttemptJobsByRun: new Map(),
  };
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
  actionEvidence = createCiActionEvidenceCache(),
  allowActionEvidenceReads = true,
): CurrentCheckRollup {
  const { actionRunMetadataById, latestAttemptJobsByRun } = actionEvidence;
  const incompleteAttemptEvidence = new Set<string>();
  const observedE2eLineage =
    e2eCoordinationEvidence.valid === true &&
    e2eCoordinationEvidence.checkSnapshot &&
    e2eCoordinationEvidence.selectedCheckId !== undefined
      ? selectedE2eLineageTiming(
          e2eCoordinationEvidence.checkSnapshot,
          exactDiff,
          e2eCoordinationEvidence.selectedCheckId,
        )
      : null;
  const selectedE2eCheck = observedE2eLineage?.at(-1);
  const authenticatedE2eLineage =
    observedE2eLineage &&
    selectedE2eCheck &&
    selectedE2eCheck.startedAt === e2eCoordinationEvidence.startedAt &&
    selectedE2eCheck.completedAt === e2eCoordinationEvidence.completedAt &&
    (observedE2eLineage.length === 1 ||
      (typeof e2eCoordinationEvidence.enclosingCoordinatorStartedAt === "number" &&
        typeof e2eCoordinationEvidence.enclosingCoordinatorCompletedAt === "number" &&
        e2eCoordinationEvidence.enclosingCoordinatorStartedAt <= selectedE2eCheck.startedAt &&
        selectedE2eCheck.startedAt <= e2eCoordinationEvidence.enclosingCoordinatorCompletedAt))
      ? observedE2eLineage
      : null;

  const fetchActionRunMetadata = (runId: string): ActionRunMetadata | null => {
    if (!allowActionEvidenceReads) return null;
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
    if (!allowActionEvidenceReads) return null;
    const metadata = fetchActionRunMetadata(runId);
    actionRunMetadataById.set(runId, metadata);
    return metadata;
  };

  const latestAttemptJobs = (runId: string): Map<string, ActionJobMetadata> | null => {
    if (latestAttemptJobsByRun.has(runId)) return latestAttemptJobsByRun.get(runId) ?? null;
    if (!allowActionEvidenceReads) return null;

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
        const {
          id,
          name,
          status,
          conclusion,
          started_at: startedAt,
          completed_at: completedAt,
        } = value as Record<string, unknown>;
        const normalizedStatus = typeof status === "string" ? status.toUpperCase() : null;
        const normalizedConclusion =
          typeof conclusion === "string" ? conclusion.toUpperCase() : conclusion;
        const parsedStartedAt =
          typeof startedAt === "string" ? parseGitHubTimestamp(startedAt) : Number.NaN;
        const parsedCompletedAt =
          typeof completedAt === "string" ? parseGitHubTimestamp(completedAt) : Number.NaN;
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
          startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : null,
          completedAt: Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null,
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
      (run.conclusion !== "SUCCESS" && run.conclusion !== "CANCELLED")
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

  type E2eSeedRunKind = "initial" | "reuse" | "unknown";

  const classifyE2eSeedRun = (runId: string, run: ActionRunMetadata): E2eSeedRunKind => {
    if (
      e2eControllerHeadBinding(run) !== "current" ||
      run.e2eGateRun !== true ||
      !authenticatedE2eLineage
    ) {
      return "unknown";
    }
    const initializeJobs = [...(latestAttemptJobs(runId)?.values() ?? [])].filter(
      (job) => job.name === "initialize",
    );
    if (initializeJobs.length !== 1) return "unknown";
    const [initialize] = initializeJobs;
    const initializeStartedAt = initialize.startedAt;
    const initializeCompletedAt = initialize.completedAt;
    if (
      initialize.status !== "COMPLETED" ||
      initialize.conclusion !== "SUCCESS" ||
      initializeStartedAt === null ||
      initializeCompletedAt === null ||
      run.createdAt > initializeStartedAt ||
      initializeStartedAt > initializeCompletedAt ||
      initializeCompletedAt > run.updatedAt
    ) {
      return "unknown";
    }
    const checksStartedDuringInitialize = authenticatedE2eLineage.filter(
      (check) => initializeStartedAt <= check.startedAt && check.startedAt <= initializeCompletedAt,
    );
    if (
      checksStartedDuringInitialize.length === 1 &&
      checksStartedDuringInitialize[0] === authenticatedE2eLineage[0]
    ) {
      return "initial";
    }
    return checksStartedDuringInitialize.length === 0 &&
      authenticatedE2eLineage.some((check) => check.startedAt < initializeStartedAt)
      ? "reuse"
      : "unknown";
  };

  const isCurrentE2eSeedRun = (runId: string, run: ActionRunMetadata): boolean =>
    classifyE2eSeedRun(runId, run) === "initial";

  const isNonAttemptRun = (runId: string): boolean => {
    const run = actionRunMetadata(runId);
    const jobs = latestAttemptJobs(runId);
    if (!run || !jobs || jobs.size === 0) return false;

    const successfulE2eSeedReuse = Boolean(
      classifyE2eSeedRun(runId, run) === "reuse" &&
        run.status === "COMPLETED" &&
        run.conclusion === "SUCCESS" &&
        [...jobs.values()].every(
          (job) =>
            job.status === "COMPLETED" &&
            job.conclusion !== null &&
            PASSING_ACTION_RUN_CONCLUSIONS.has(job.conclusion),
        ),
    );
    if (successfulE2eSeedReuse) return true;

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

  const actionRunJobIdentity = (check: StatusCheck): { runId: string; jobId: string } | null => {
    if (!check.detailsUrl) return null;
    let url: URL;
    try {
      url = new URL(check.detailsUrl);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      segments.length !== 7 ||
      `${segments[0]}/${segments[1]}` !== repo ||
      segments[2] !== "actions" ||
      segments[3] !== "runs" ||
      segments[5] !== "job" ||
      !/^[1-9][0-9]*$/u.test(segments[4]) ||
      !/^[1-9][0-9]*$/u.test(segments[6])
    ) {
      return null;
    }
    return { runId: segments[4], jobId: segments[6] };
  };

  const associationLessHeadBinding = (
    metadata: ActionRunMetadata,
  ): "current" | "other" | "unknown" => {
    if (
      metadata.hasPullRequests !== false ||
      (metadata.event !== "pull_request" && metadata.event !== "pull_request_target")
    ) {
      return "unknown";
    }
    if (
      metadata.headShaMatches === false ||
      metadata.headRefNameMatches === false ||
      metadata.headRepositoryMatches === false
    ) {
      return "other";
    }
    return metadata.headShaMatches === true &&
      metadata.headRefNameMatches === true &&
      metadata.headRepositoryMatches === true
      ? "current"
      : "unknown";
  };

  const isAuthenticatedAdvisoryPrReviewCheck = (check: StatusCheck): boolean => {
    const checkName = check.name ?? "";
    if (
      check.__typename !== "CheckRun" ||
      check.workflowName !== PR_REVIEW_ADVISOR_WORKFLOW_NAME ||
      !ADVISORY_PR_REVIEW_ADVISOR_JOB_NAMES.has(checkName) &&
      !ADVISORY_PR_REVIEW_ADVISOR_SPECIALIST_JOB.test(checkName)
    ) {
      return false;
    }
    const identity = actionRunJobIdentity(check);
    if (!identity) return false;
    const run = actionRunMetadata(identity.runId);
    const job = latestAttemptJobs(identity.runId)?.get(identity.jobId);
    const checkStatus = check.status?.toUpperCase() ?? null;
    const checkConclusion = check.conclusion?.toUpperCase() ?? null;
    const currentPrBinding =
      run?.hasPullRequests === true && run.exactDiff === true
        ? true
        : exactDiff.headRepository !== repo &&
          run !== null &&
          run.status === "COMPLETED" &&
          run.conclusion !== null &&
          associationLessHeadBinding(run) === "current";
    return Boolean(
      run &&
        job &&
        run.event === "pull_request_target" &&
        run.path === PR_REVIEW_ADVISOR_WORKFLOW_PATH &&
        currentPrBinding &&
        job.name === checkName &&
        job.status === checkStatus &&
        job.conclusion === checkConclusion,
    );
  };

  const isTrustedCustomE2eCheck = (check: StatusCheck): boolean =>
    e2eCoordinationEvidence.trustedCustomCheckId !== undefined &&
    check.name === "E2E / PR Gate" &&
    check.detailsUrl?.match(/\/runs\/(\d+)(?:[/?#]|$)/u)?.[1] ===
      String(e2eCoordinationEvidence.trustedCustomCheckId);

  function runIdentityEvidence(
    runId: string,
    requiresExactDiff: boolean,
  ): "current" | "other" | "unknown" {
    const metadata = actionRunMetadata(runId);
    if (!metadata?.event || !metadata.path) return "unknown";
    const headBinding = associationLessHeadBinding(metadata);
    if (
      metadata.event === "pull_request" &&
      (metadata.path === ".github/workflows/installer-hash-check.yaml" ||
        metadata.path === ".github/workflows/pr.yaml")
    ) {
      if (
        metadata.immutablePrDiff === false ||
        metadata.exactDiff === false ||
        metadata.headShaMatches === false ||
        headBinding === "other"
      ) {
        return "other";
      }
      if (
        metadata.immutablePrDiff === true &&
        metadata.headShaMatches === true &&
        (metadata.exactDiff === true || headBinding === "current")
      ) {
        return "current";
      }
      return "unknown";
    }
    if (metadata.exactDiff === true) {
      if (metadata.headShaMatches === true) {
        return "current";
      }
      if (metadata.headShaMatches === false) return "other";
      return "unknown";
    }
    if (metadata.exactDiff === false) return "other";
    const e2eHeadBinding = e2eControllerHeadBinding(metadata);
    if (e2eHeadBinding === "other") return "other";
    if (e2eHeadBinding === "current") {
      return isCurrentE2eSeedRun(runId, metadata) ? "current" : "unknown";
    }
    if (
      exactDiff.headRepository !== repo &&
      metadata.path !== ".github/workflows/pr-e2e-gate.yaml" &&
      headBinding !== "unknown"
    ) {
      return headBinding;
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

  const mergeRelevantStatusChecks = statusCheckRollup.filter(
    (check) => !isAuthenticatedAdvisoryPrReviewCheck(check),
  );
  const allActionRunIds = new Set(
    mergeRelevantStatusChecks.map(actionRunId).filter((runId): runId is string => Boolean(runId)),
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
  for (const check of mergeRelevantStatusChecks) {
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
      group.some((check) => !actionRunId(check) && !isTrustedCustomE2eCheck(check))
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

interface CiGateResult extends GateResult {
  failingChecks?: string[];
  pendingChecks?: string[];
  missingChecks?: string[];
  trustedCustomCheckId?: number;
}

interface RequiredCheckSnapshotRecord {
  type: string | null;
  name: string | null;
  context: string | null;
  workflowName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  status: string | null;
  conclusion: string | null;
  state: string | null;
}

interface CiEvaluation {
  gate: CiGateResult;
  e2eCoordinationEvidence: E2eCoordinationEvidence;
  requiredCheckSnapshot: RequiredCheckSnapshotRecord[] | null;
}

function captureRequiredCheckSnapshot(
  statusCheckRollup: StatusCheck[] | null,
): RequiredCheckSnapshotRecord[] | null {
  if (!statusCheckRollup) return null;
  const snapshot = statusCheckRollup
    .filter((check) => REQUIRED_CHECK_NAMES.includes(check.name ?? check.context ?? ""))
    .map((check) => ({
      type: check.__typename ?? null,
      name: check.name ?? null,
      context: check.context ?? null,
      workflowName: check.workflowName ?? null,
      startedAt: check.startedAt ?? null,
      completedAt: check.completedAt ?? null,
      detailsUrl: check.detailsUrl ?? null,
      status: check.status ?? null,
      conclusion: check.conclusion ?? null,
      state: check.state ?? null,
    }));
  snapshot.sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return snapshot;
}

const ADVISORY_E2E_CHECK_NAMES = new Set([
  "E2E / PR Gate",
  "E2E / PR Gate / Rollup",
  "E2E / PR Gate Coordination",
]);
const ADVISORY_E2E_WORKFLOW_NAMES = new Set(["E2E / PR Gate Controller"]);

function isAdvisoryE2eCheck(check: StatusCheck): boolean {
  return (
    ADVISORY_E2E_CHECK_NAMES.has(check.name ?? check.context ?? "") ||
    ADVISORY_E2E_WORKFLOW_NAMES.has(check.workflowName ?? "")
  );
}

function evaluateCiRollup(
  statusCheckRollup: StatusCheck[] | null,
  repo: string,
  exactDiff: ExactDiffIdentity,
  e2eCoordinationEvidence: E2eCoordinationEvidence,
  actionEvidence = createCiActionEvidenceCache(),
  allowActionEvidenceReads = true,
): CiGateResult {
  if (!statusCheckRollup || statusCheckRollup.length === 0) {
    return { pass: false, details: "No status checks found" };
  }

  const mergeRelevantChecks = statusCheckRollup.filter((check) => !isAdvisoryE2eCheck(check));
  const rollup = currentCheckRollup(
    mergeRelevantChecks,
    repo,
    exactDiff,
    e2eCoordinationEvidence,
    actionEvidence,
    allowActionEvidenceReads,
  );
  const currentChecks = rollup.checks;
  const incompleteAttemptEvidence = new Set(rollup.incompleteAttemptEvidence);

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
  return {
    pass: true,
    details: `All ${currentChecks.length} current checks green`,
    ...(e2eCoordinationEvidence.trustedCustomCheckId !== undefined
      ? { trustedCustomCheckId: e2eCoordinationEvidence.trustedCustomCheckId }
      : {}),
  };
}

function checkCi(
  statusCheckRollup: StatusCheck[] | null,
  repo: string,
  exactDiff: ExactDiffIdentity,
  _trustedWorkflowSha: string | null,
): CiEvaluation {
  const e2eCoordinationEvidence: E2eCoordinationEvidence = { valid: true };
  return {
    gate: evaluateCiRollup(statusCheckRollup, repo, exactDiff, e2eCoordinationEvidence),
    e2eCoordinationEvidence,
    requiredCheckSnapshot: captureRequiredCheckSnapshot(statusCheckRollup),
  };
}

function checkFinalCi(
  initial: CiEvaluation,
  finalStatusCheckRollup: StatusCheck[] | null,
  repo: string,
  exactDiff: ExactDiffIdentity,
  actionEvidence: CiActionEvidenceCache,
): CiGateResult {
  if (!initial.gate.pass) return initial.gate;
  const finalGate = evaluateCiRollup(
    finalStatusCheckRollup,
    repo,
    exactDiff,
    initial.e2eCoordinationEvidence,
    actionEvidence,
  );
  if (!finalGate.pass) return finalGate;
  const finalRequiredCheckSnapshot = captureRequiredCheckSnapshot(finalStatusCheckRollup);
  if (
    !initial.requiredCheckSnapshot ||
    !finalRequiredCheckSnapshot ||
    !isDeepStrictEqual(finalRequiredCheckSnapshot, initial.requiredCheckSnapshot)
  ) {
    return {
      pass: false,
      details: "Required check rollup changed during gate evaluation",
      failingChecks: ["Required check rollup changed during gate evaluation"],
    };
  }
  return finalGate;
}

function checkFinalE2eEvidence(
  ci: CiGateResult,
  initial: CiEvaluation,
  finalE2eEvidence: E2eCoordinationEvidence,
  exactDiff: ExactDiffIdentity,
): CiGateResult {
  if (!ci.pass) return ci;
  const initialE2eCheckSnapshot = initial.e2eCoordinationEvidence.checkSnapshot;
  const initialCoordinatorSnapshot = initial.e2eCoordinationEvidence.coordinatorSnapshot;
  const initialSelectedCheckId = initial.e2eCoordinationEvidence.selectedCheckId;
  const finalE2eCheckSnapshot = finalE2eEvidence.checkSnapshot;
  const finalSelectedCheck = finalE2eCheckSnapshot
    ? selectE2eCoordinationCheck(finalE2eCheckSnapshot, exactDiff)
    : undefined;
  if (
    !initialE2eCheckSnapshot ||
    !initialCoordinatorSnapshot ||
    initialSelectedCheckId === undefined ||
    finalE2eEvidence.valid !== true ||
    !finalE2eCheckSnapshot ||
    !finalE2eEvidence.coordinatorSnapshot ||
    !finalSelectedCheck ||
    finalSelectedCheck.id !== initialSelectedCheckId ||
    !isDeepStrictEqual(finalE2eCheckSnapshot, initialE2eCheckSnapshot) ||
    !isDeepStrictEqual(finalE2eEvidence.coordinatorSnapshot, initialCoordinatorSnapshot)
  ) {
    return {
      pass: false,
      details: "E2E custom-check history changed during gate evaluation",
      failingChecks: ["E2E / PR Gate: final evidence changed"],
    };
  }
  return ci;
}

function checkLastCi(
  ci: CiGateResult,
  initial: CiEvaluation,
  lastStatusCheckRollup: StatusCheck[] | null,
  repo: string,
  exactDiff: ExactDiffIdentity,
  finalE2eEvidence: E2eCoordinationEvidence,
  actionEvidence: CiActionEvidenceCache,
): CiGateResult {
  if (!ci.pass) return ci;
  const lastGate = evaluateCiRollup(
    lastStatusCheckRollup,
    repo,
    exactDiff,
    finalE2eEvidence,
    actionEvidence,
    false,
  );
  if (!lastGate.pass) return lastGate;
  const lastRequiredCheckSnapshot = captureRequiredCheckSnapshot(lastStatusCheckRollup);
  if (
    !initial.requiredCheckSnapshot ||
    !lastRequiredCheckSnapshot ||
    !isDeepStrictEqual(lastRequiredCheckSnapshot, initial.requiredCheckSnapshot)
  ) {
    return {
      pass: false,
      details: "Required check rollup changed during final gate evaluation",
      failingChecks: ["Required check rollup changed during final gate evaluation"],
    };
  }
  return lastGate;
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
      details: "The gate checker could not verify the base SHA",
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

interface PrRevisionIdentity {
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

interface PrRevisionSnapshot extends PrRevisionIdentity {
  statusCheckRollup: StatusCheck[];
}

function parseHeadRepository(headRepository: unknown, headRepositoryOwner: unknown): string | null {
  if (
    typeof headRepository !== "object" ||
    headRepository === null ||
    Array.isArray(headRepository)
  ) {
    return null;
  }
  const repository = headRepository as Record<string, unknown>;
  const direct =
    typeof repository.nameWithOwner === "string" &&
    REPOSITORY_NAME_PATTERN.test(repository.nameWithOwner)
      ? repository.nameWithOwner
      : null;
  let derived: string | null = null;
  if (
    typeof repository.name === "string" &&
    /^[A-Za-z0-9_.-]+$/u.test(repository.name) &&
    typeof headRepositoryOwner === "object" &&
    headRepositoryOwner !== null &&
    !Array.isArray(headRepositoryOwner)
  ) {
    const login = (headRepositoryOwner as Record<string, unknown>).login;
    if (typeof login === "string" && /^[A-Za-z0-9_.-]+$/u.test(login)) {
      derived = `${login}/${repository.name}`;
    }
  }
  if (direct && derived && direct !== derived) return null;
  return direct ?? derived;
}

function fetchPrRevisionSnapshot(repo: string, number: number): PrRevisionSnapshot | null {
  const value = ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "title,body,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,statusCheckRollup",
  ]);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const headRepository = parseHeadRepository(record.headRepository, record.headRepositoryOwner);
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
    !Array.isArray(record.statusCheckRollup) ||
    record.statusCheckRollup.some(
      (check) => typeof check !== "object" || check === null || Array.isArray(check),
    ) ||
    !headRepository
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
    headRepository,
    statusCheckRollup: record.statusCheckRollup as StatusCheck[],
  };
}

function fetchFinalPrSnapshot(
  repo: string,
  number: number,
): { revision: PrRevisionSnapshot; currentBaseSha: string } | null {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) return null;

  const args = [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=query FinalPrSnapshot($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          title
          body
          state
          isDraft
          mergeable
          mergeStateStatus
          headRefOid
          baseRefOid
          headRefName
          baseRefName
          headRepository { name nameWithOwner }
          headRepositoryOwner { login }
          baseRef { target { oid } }
          commits(last: 1) {
            totalCount
            nodes {
              commit {
                oid
                statusCheckRollup {
                  contexts(first: 100, after: $endCursor) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                        startedAt
                        completedAt
                        detailsUrl
                        checkSuite { workflowRun { workflow { name } } }
                      }
                      ... on StatusContext {
                        context
                        state
                        startedAt: createdAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
  ];
  const firstPages = ghJson(args);
  const finalPages = ghJson(args);
  if (!isDeepStrictEqual(firstPages, finalPages)) return null;
  return parseFinalPrSnapshotPages(finalPages);
}

function parseFinalPrSnapshotPages(
  pagesValue: unknown,
): { revision: PrRevisionSnapshot; currentBaseSha: string } | null {
  if (!Array.isArray(pagesValue) || pagesValue.length === 0) return null;

  let canonicalIdentity: Record<string, unknown> | null = null;
  let canonicalRecord: Record<string, unknown> | null = null;
  let contextTotalCount: number | null = null;
  const contextNodes: unknown[] = [];
  const seenEndCursors = new Set<string>();

  for (const [pageIndex, pageValue] of pagesValue.entries()) {
    if (typeof pageValue !== "object" || pageValue === null || Array.isArray(pageValue)) {
      return null;
    }
    const dataValue = (pageValue as Record<string, unknown>).data;
    if (typeof dataValue !== "object" || dataValue === null || Array.isArray(dataValue))
      return null;
    const repositoryValue = (dataValue as Record<string, unknown>).repository;
    if (
      typeof repositoryValue !== "object" ||
      repositoryValue === null ||
      Array.isArray(repositoryValue)
    ) {
      return null;
    }
    const recordValue = (repositoryValue as Record<string, unknown>).pullRequest;
    if (typeof recordValue !== "object" || recordValue === null || Array.isArray(recordValue)) {
      return null;
    }
    const record = recordValue as Record<string, unknown>;

    const headRepository = parseHeadRepository(record.headRepository, record.headRepositoryOwner);
    const baseRef =
      typeof record.baseRef === "object" &&
      record.baseRef !== null &&
      !Array.isArray(record.baseRef)
        ? (record.baseRef as Record<string, unknown>)
        : null;
    const target =
      typeof baseRef?.target === "object" &&
      baseRef.target !== null &&
      !Array.isArray(baseRef.target)
        ? (baseRef.target as Record<string, unknown>)
        : null;
    const currentBaseSha = target?.oid;
    if (
      typeof record.title !== "string" ||
      typeof record.body !== "string" ||
      typeof record.state !== "string" ||
      typeof record.isDraft !== "boolean" ||
      typeof record.mergeable !== "string" ||
      typeof record.mergeStateStatus !== "string" ||
      typeof record.headRefOid !== "string" ||
      !/^[0-9a-f]{40}$/iu.test(record.headRefOid) ||
      typeof record.baseRefOid !== "string" ||
      !/^[0-9a-f]{40}$/iu.test(record.baseRefOid) ||
      typeof record.headRefName !== "string" ||
      typeof record.baseRefName !== "string" ||
      typeof currentBaseSha !== "string" ||
      !/^[0-9a-f]{40}$/iu.test(currentBaseSha) ||
      !headRepository
    ) {
      return null;
    }

    const commitsValue = record.commits;
    if (typeof commitsValue !== "object" || commitsValue === null || Array.isArray(commitsValue)) {
      return null;
    }
    const commits = commitsValue as Record<string, unknown>;
    if (
      typeof commits.totalCount !== "number" ||
      !Number.isInteger(commits.totalCount) ||
      commits.totalCount < 1 ||
      !Array.isArray(commits.nodes) ||
      commits.nodes.length !== 1
    ) {
      return null;
    }
    const commitNode = commits.nodes[0];
    if (typeof commitNode !== "object" || commitNode === null || Array.isArray(commitNode)) {
      return null;
    }
    const commitValue = (commitNode as Record<string, unknown>).commit;
    if (typeof commitValue !== "object" || commitValue === null || Array.isArray(commitValue)) {
      return null;
    }
    const commit = commitValue as Record<string, unknown>;
    if (commit.oid !== record.headRefOid) return null;
    const rollupValue = commit.statusCheckRollup;
    if (typeof rollupValue !== "object" || rollupValue === null || Array.isArray(rollupValue)) {
      return null;
    }
    const contextsValue = (rollupValue as Record<string, unknown>).contexts;
    if (
      typeof contextsValue !== "object" ||
      contextsValue === null ||
      Array.isArray(contextsValue)
    ) {
      return null;
    }
    const contexts = contextsValue as Record<string, unknown>;
    const pageInfoValue = contexts.pageInfo;
    if (
      typeof contexts.totalCount !== "number" ||
      !Number.isInteger(contexts.totalCount) ||
      contexts.totalCount < 0 ||
      !Array.isArray(contexts.nodes) ||
      typeof pageInfoValue !== "object" ||
      pageInfoValue === null ||
      Array.isArray(pageInfoValue)
    ) {
      return null;
    }
    const pageInfo = pageInfoValue as Record<string, unknown>;
    const isLastPage = pageIndex === pagesValue.length - 1;
    if (pageInfo.hasNextPage !== !isLastPage) return null;
    if (!isLastPage) {
      if (
        typeof pageInfo.endCursor !== "string" ||
        pageInfo.endCursor.length === 0 ||
        seenEndCursors.has(pageInfo.endCursor)
      ) {
        return null;
      }
      seenEndCursors.add(pageInfo.endCursor);
    }

    const identity = {
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
      headRepository,
      currentBaseSha,
      commitTotalCount: commits.totalCount,
      contextTotalCount: contexts.totalCount,
    };
    if (canonicalIdentity && !isDeepStrictEqual(canonicalIdentity, identity)) return null;
    canonicalIdentity = identity;
    canonicalRecord ??= record;
    contextTotalCount ??= contexts.totalCount;
    contextNodes.push(...contexts.nodes);
  }

  if (!canonicalIdentity || !canonicalRecord || contextTotalCount !== contextNodes.length) {
    return null;
  }
  const aggregateCommits = {
    totalCount: canonicalIdentity.commitTotalCount,
    nodes: [
      {
        commit: {
          oid: canonicalIdentity.headRefOid,
          statusCheckRollup: {
            contexts: {
              totalCount: contextTotalCount,
              pageInfo: { hasNextPage: false },
              nodes: contextNodes,
            },
          },
        },
      },
    ],
  };
  const statusCheckRollup = parseFinalStatusCheckRollup(
    aggregateCommits,
    canonicalIdentity.headRefOid as string,
  );
  if (!statusCheckRollup) return null;
  return {
    revision: {
      title: canonicalRecord.title as string,
      body: canonicalRecord.body as string,
      state: canonicalRecord.state as string,
      isDraft: canonicalRecord.isDraft as boolean,
      mergeable: canonicalRecord.mergeable as string,
      mergeStateStatus: canonicalRecord.mergeStateStatus as string,
      headRefOid: canonicalRecord.headRefOid as string,
      baseRefOid: canonicalRecord.baseRefOid as string,
      headRefName: canonicalRecord.headRefName as string,
      baseRefName: canonicalRecord.baseRefName as string,
      headRepository: canonicalIdentity.headRepository as string,
      statusCheckRollup,
    },
    currentBaseSha: canonicalIdentity.currentBaseSha as string,
  };
}

function parseFinalStatusCheckRollup(
  commitsValue: unknown,
  expectedHeadSha: string,
): StatusCheck[] | null {
  if (typeof commitsValue !== "object" || commitsValue === null || Array.isArray(commitsValue)) {
    return null;
  }
  const commits = commitsValue as Record<string, unknown>;
  if (
    typeof commits.totalCount !== "number" ||
    !Number.isInteger(commits.totalCount) ||
    commits.totalCount < 1 ||
    !Array.isArray(commits.nodes) ||
    commits.nodes.length !== 1
  ) {
    return null;
  }
  const commitNode = commits.nodes[0];
  if (typeof commitNode !== "object" || commitNode === null || Array.isArray(commitNode)) {
    return null;
  }
  const commitValue = (commitNode as Record<string, unknown>).commit;
  if (typeof commitValue !== "object" || commitValue === null || Array.isArray(commitValue)) {
    return null;
  }
  const commit = commitValue as Record<string, unknown>;
  if (commit.oid !== expectedHeadSha) return null;
  const rollupValue = commit.statusCheckRollup;
  if (typeof rollupValue !== "object" || rollupValue === null || Array.isArray(rollupValue)) {
    return null;
  }
  const contextsValue = (rollupValue as Record<string, unknown>).contexts;
  if (typeof contextsValue !== "object" || contextsValue === null || Array.isArray(contextsValue)) {
    return null;
  }
  const contexts = contextsValue as Record<string, unknown>;
  const pageInfo = contexts.pageInfo;
  if (
    typeof contexts.totalCount !== "number" ||
    !Number.isInteger(contexts.totalCount) ||
    contexts.totalCount < 0 ||
    !Array.isArray(contexts.nodes) ||
    contexts.nodes.length !== contexts.totalCount ||
    typeof pageInfo !== "object" ||
    pageInfo === null ||
    Array.isArray(pageInfo) ||
    (pageInfo as Record<string, unknown>).hasNextPage !== false
  ) {
    return null;
  }

  const statusCheckRollup: StatusCheck[] = [];
  for (const nodeValue of contexts.nodes) {
    if (typeof nodeValue !== "object" || nodeValue === null || Array.isArray(nodeValue)) {
      return null;
    }
    const node = nodeValue as Record<string, unknown>;
    if (node.__typename === "CheckRun") {
      const checkSuite =
        typeof node.checkSuite === "object" &&
        node.checkSuite !== null &&
        !Array.isArray(node.checkSuite)
          ? (node.checkSuite as Record<string, unknown>)
          : null;
      const workflowRun =
        typeof checkSuite?.workflowRun === "object" &&
        checkSuite.workflowRun !== null &&
        !Array.isArray(checkSuite.workflowRun)
          ? (checkSuite.workflowRun as Record<string, unknown>)
          : null;
      const workflow =
        typeof workflowRun?.workflow === "object" &&
        workflowRun.workflow !== null &&
        !Array.isArray(workflowRun.workflow)
          ? (workflowRun.workflow as Record<string, unknown>)
          : null;
      const workflowName = workflow?.name;
      const scalarFields = [
        node.name,
        node.status,
        node.conclusion,
        node.startedAt,
        node.completedAt,
        node.detailsUrl,
        workflowName,
      ];
      if (
        typeof node.name !== "string" ||
        typeof node.status !== "string" ||
        scalarFields.some(
          (value) => value !== undefined && value !== null && typeof value !== "string",
        )
      ) {
        return null;
      }
      statusCheckRollup.push({
        __typename: "CheckRun",
        name: node.name,
        status: node.status,
        ...(typeof node.conclusion === "string" ? { conclusion: node.conclusion } : {}),
        ...(typeof node.startedAt === "string" ? { startedAt: node.startedAt } : {}),
        ...(typeof node.completedAt === "string" ? { completedAt: node.completedAt } : {}),
        ...(typeof node.detailsUrl === "string" ? { detailsUrl: node.detailsUrl } : {}),
        ...(typeof workflowName === "string" ? { workflowName } : {}),
      });
      continue;
    }
    if (
      node.__typename !== "StatusContext" ||
      typeof node.context !== "string" ||
      typeof node.state !== "string" ||
      typeof node.startedAt !== "string"
    ) {
      return null;
    }
    statusCheckRollup.push({
      __typename: "StatusContext",
      context: node.context,
      state: node.state,
      startedAt: node.startedAt,
    });
  }
  return statusCheckRollup;
}

function checkFinalRevision(
  captured: PrRevisionIdentity,
  current: PrRevisionIdentity | null,
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
    "number,title,url,body,files,statusCheckRollup,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,author",
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
    headRepository: { name: string; nameWithOwner: string };
    headRepositoryOwner: { login: string } | null;
    author: PrIdentity | null;
  } | null;

  if (!prData) {
    console.error(`Failed to fetch PR #${prNumber} from ${repo}`);
    process.exit(1);
  }
  const headRepository = parseHeadRepository(prData.headRepository, prData.headRepositoryOwner);
  if (!headRepository) {
    console.error(`Failed to resolve PR #${prNumber} head repository from ${repo}`);
    process.exit(1);
  }

  const exactDiff = {
    number: prNumber,
    headSha: prData.headRefOid,
    baseSha: prData.baseRefOid,
    headRefName: prData.headRefName,
    headRepository,
  };
  const currentBaseSha = fetchCurrentBaseSha(repo, prNumber);
  const initialCi = checkCi(prData.statusCheckRollup, repo, exactDiff, currentBaseSha);
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
  const capturedRevision: PrRevisionSnapshot = {
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
    headRepository,
    statusCheckRollup: prData.statusCheckRollup,
  };
  const revisionBeforeFinalCi = fetchPrRevisionSnapshot(repo, prNumber);
  const finalCiActionEvidence = createCiActionEvidenceCache();
  const evaluatedRollupCi = checkFinalCi(
    initialCi,
    revisionBeforeFinalCi?.statusCheckRollup ?? null,
    repo,
    exactDiff,
    finalCiActionEvidence,
  );
  const finalE2eEvidence: E2eCoordinationEvidence = { valid: true };
  const evaluatedCi = evaluatedRollupCi;
  const currentRevision = fetchPrRevisionSnapshot(repo, prNumber);
  const ciBeforeFinalSnapshot = checkLastCi(
    evaluatedCi,
    initialCi,
    currentRevision?.statusCheckRollup ?? null,
    repo,
    exactDiff,
    finalE2eEvidence,
    finalCiActionEvidence,
  );
  const finalSnapshot = fetchFinalPrSnapshot(repo, prNumber);
  const finalRevision = finalSnapshot?.revision ?? null;
  const finalCurrentBaseSha = finalSnapshot?.currentBaseSha ?? null;
  const stableCurrentBaseSha =
    currentBaseSha && finalCurrentBaseSha && currentBaseSha === finalCurrentBaseSha
      ? finalCurrentBaseSha
      : null;
  const ci = !ciBeforeFinalSnapshot.pass
    ? ciBeforeFinalSnapshot
    : !finalRevision
      ? { pass: false, details: "Unable to verify the final PR checks" }
      : checkLastCi(
          ciBeforeFinalSnapshot,
          initialCi,
          finalRevision.statusCheckRollup,
          repo,
          exactDiff,
          finalE2eEvidence,
          finalCiActionEvidence,
        );
  const baseRevisionGate: ReturnType<typeof checkConflicts> =
    stableCurrentBaseSha !== null
      ? {
          pass: true,
          details: "The base SHA did not change during gate evaluation",
          mergeable: capturedRevision.mergeable,
          mergeStateStatus: capturedRevision.mergeStateStatus,
          baseSha: capturedRevision.baseRefOid,
          currentBaseSha: stableCurrentBaseSha,
        }
      : {
          pass: false,
          details:
            currentBaseSha && finalCurrentBaseSha
              ? "The base SHA changed during gate evaluation. Rerun the gate checker."
              : "The gate checker could not verify the base SHA",
          mergeable: capturedRevision.mergeable,
          mergeStateStatus: capturedRevision.mergeStateStatus,
          baseSha: capturedRevision.baseRefOid,
          ...(finalCurrentBaseSha ? { currentBaseSha: finalCurrentBaseSha } : {}),
        };
  const revisionBeforeFinalCiGate = checkFinalRevision(
    capturedRevision,
    revisionBeforeFinalCi,
    stableCurrentBaseSha,
  );
  const revisionAfterFinalEvidenceGate = revisionBeforeFinalCiGate.pass
    ? checkFinalRevision(revisionBeforeFinalCi!, currentRevision, stableCurrentBaseSha)
    : revisionBeforeFinalCiGate;
  const conflicts = !baseRevisionGate.pass
    ? baseRevisionGate
    : revisionAfterFinalEvidenceGate.pass
      ? checkFinalRevision(currentRevision!, finalRevision, stableCurrentBaseSha)
      : revisionAfterFinalEvidenceGate;

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
