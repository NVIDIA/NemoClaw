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
    conflicts: GateResult & { mergeStateStatus?: string };
    coderabbit: GateResult & { unresolvedThreads?: CodeRabbitThread[] };
    riskyCodeTested: GateResult & { riskyFiles?: string[]; hasTests?: boolean };
    contributorCompliance: GateResult & {
      dcoDeclarationPresent?: boolean;
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
}

interface ActionRunMetadata {
  attempt: number;
  exactDiff: boolean | null;
}

interface CurrentCheckRollup {
  checks: StatusCheck[];
  incompleteAttemptEvidence: string[];
}

function currentCheckRollup(
  statusCheckRollup: StatusCheck[],
  repo: string,
  exactDiff: ExactDiffIdentity,
): CurrentCheckRollup {
  const actionRunMetadataById = new Map<string, ActionRunMetadata | null>();
  const latestAttemptJobsByRun = new Map<string, Map<string, string> | null>();
  const incompleteAttemptEvidence = new Set<string>();

  const actionRunMetadata = (runId: string): ActionRunMetadata | null => {
    if (actionRunMetadataById.has(runId)) return actionRunMetadataById.get(runId) ?? null;

    const runData = ghJson(["api", `repos/${repo}/actions/runs/${runId}`]);
    if (typeof runData !== "object" || runData === null || Array.isArray(runData)) {
      actionRunMetadataById.set(runId, null);
      return null;
    }
    const record = runData as Record<string, unknown>;
    if (!Number.isSafeInteger(record.run_attempt) || (record.run_attempt as number) < 1) {
      actionRunMetadataById.set(runId, null);
      return null;
    }

    let exactDiffMatch: boolean | null = null;
    if (Array.isArray(record.pull_requests)) {
      exactDiffMatch = false;
      for (const value of record.pull_requests) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          exactDiffMatch = null;
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

    const metadata = { attempt: record.run_attempt as number, exactDiff: exactDiffMatch };
    actionRunMetadataById.set(runId, metadata);
    return metadata;
  };

  const latestAttemptJobs = (runId: string): Map<string, string> | null => {
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
    const jobsById = new Map<string, string>();
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
        const { id, name } = value as Record<string, unknown>;
        if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof name !== "string" || !name) {
          latestAttemptJobsByRun.set(runId, null);
          return null;
        }
        jobsById.set(String(id), name);
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
    latestAttemptJobsByRun.set(runId, jobsById);
    return jobsById;
  };

  const checksFromLatestAttempt = (runId: string, checks: StatusCheck[]): StatusCheck[] | null => {
    const checkName = checks[0]?.name;
    const jobsById = latestAttemptJobs(runId);
    if (!checkName || !jobsById) return null;

    const expectedIds = new Set(
      [...jobsById].filter(([, name]) => name === checkName).map(([id]) => id),
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
    if (group.length === 1) {
      current.push(group[0]);
      continue;
    }

    if (group[0].__typename !== "StatusContext") {
      const byRun = new Map<string, StatusCheck[]>();
      for (const check of group) {
        const runId = check.detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1];
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
          const timestamps = checks.map((check) =>
            Date.parse(check.startedAt ?? check.completedAt ?? ""),
          );
          return {
            runId,
            checks,
            timestamp: timestamps.every(Number.isFinite) ? Math.min(...timestamps) : Number.NaN,
            allSkipped: checks.every(
              (check) =>
                check.status?.toUpperCase() === "COMPLETED" &&
                check.conclusion?.toUpperCase() === "SKIPPED",
            ),
          };
        });
        if (runs.every(({ timestamp }) => Number.isFinite(timestamp))) {
          const meaningfulExactDiffRun = runs.some(
            ({ runId, allSkipped }) => !allSkipped && actionRunMetadata(runId)?.exactDiff === true,
          );
          const candidates = meaningfulExactDiffRun
            ? runs.filter(
                ({ runId, allSkipped }) =>
                  !(allSkipped && actionRunMetadata(runId)?.exactDiff === true),
              )
            : runs;
          const latestTimestamp = Math.max(...candidates.map(({ timestamp }) => timestamp));
          const latestRuns = candidates.filter(({ timestamp }) => timestamp === latestTimestamp);
          if (latestRuns.length === 1) {
            const latest = latestRuns[0];
            const selected =
              latest.checks.length > 1
                ? checksFromLatestAttempt(latest.runId, latest.checks)
                : latest.checks;
            if (!selected) {
              incompleteAttemptEvidence.add(latest.checks[0]?.name ?? "(unknown)");
            }
            current.push(...(selected ?? latest.checks));
          } else {
            current.push(...latestRuns.flatMap(({ checks }) => checks));
          }
          continue;
        }
      }

      if (byRun.size === 1) {
        const [runId, checks] = [...byRun][0];
        const selected = checks.length > 1 ? checksFromLatestAttempt(runId, checks) : checks;
        if (!selected) incompleteAttemptEvidence.add(checks[0]?.name ?? "(unknown)");
        current.push(...(selected ?? checks));
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
          timestamp: Date.parse(check.startedAt ?? check.completedAt ?? ""),
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
      timestamp: Date.parse(check.startedAt ?? check.completedAt ?? ""),
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

  const { checks: currentChecks, incompleteAttemptEvidence } = currentCheckRollup(
    statusCheckRollup,
    repo,
    exactDiff,
  );

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
    if (status !== "COMPLETED") {
      pending.push(checkName);
    } else if (
      !passing.has(conclusion) ||
      (checkName === "E2E / PR Gate" && conclusion !== "SUCCESS")
    ) {
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
  if (incompleteAttemptEvidence.length > 0) {
    return {
      pass: false,
      details: `${incompleteAttemptEvidence.length} check context(s) have incomplete latest-attempt evidence`,
      failingChecks: incompleteAttemptEvidence.map(
        (name) => `${name}: latest attempt evidence incomplete`,
      ),
    };
  }
  return { pass: true, details: `All ${currentChecks.length} current checks green` };
}

// ---------------------------------------------------------------------------
// Gate 2: No conflicts
// ---------------------------------------------------------------------------

function checkConflicts(mergeStateStatus: string): GateResult & { mergeStateStatus?: string } {
  const clean = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];
  const status = (mergeStateStatus ?? "UNKNOWN").toUpperCase();

  if (clean.includes(status)) {
    return { pass: true, details: "No merge conflicts", mergeStateStatus: status };
  }
  return { pass: false, details: `Merge state: ${status}`, mergeStateStatus: status };
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
): GateResult & {
  dcoDeclarationPresent?: boolean;
  unverifiedCommits?: Array<{ sha: string; reason: string }>;
} {
  const dcoDeclarationPresent = DCO_DECLARATION.test(body ?? "");
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
    };
  }

  if (commits.length === 0) {
    return {
      pass: false,
      details: "No PR commits returned while checking contributor compliance — fail-closed",
      dcoDeclarationPresent,
    };
  }

  const unverifiedCommits = commits
    .filter((commit) => commit.verified !== true)
    .map(({ sha, reason }) => ({ sha, reason }));
  if (!dcoDeclarationPresent || unverifiedCommits.length > 0) {
    const failures = [
      ...(dcoDeclarationPresent ? [] : ["PR body lacks a valid Signed-off-by declaration"]),
      ...(unverifiedCommits.length > 0
        ? [`${unverifiedCommits.length} commit(s) are not GitHub Verified`]
        : []),
    ];
    return {
      pass: false,
      details: failures.join("; "),
      dcoDeclarationPresent,
      unverifiedCommits,
    };
  }

  return {
    pass: true,
    details: `DCO declaration present; all ${commits.length} commit(s) are GitHub Verified`,
    dcoDeclarationPresent,
    unverifiedCommits: [],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
    "number,title,url,body,files,statusCheckRollup,mergeStateStatus,headRefOid,baseRefOid,author",
  ]) as {
    number: number;
    title: string;
    url: string;
    body: string;
    files: Array<{ path: string; status: string }>;
    statusCheckRollup: StatusCheck[];
    mergeStateStatus: string;
    headRefOid: string;
    baseRefOid: string;
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
  });
  const conflicts = checkConflicts(prData.mergeStateStatus);
  const coderabbit = checkCodeRabbit(repo, prNumber);
  const riskyCodeTested = checkRiskyCodeTested(prData.files ?? []);
  const contributorCompliance = checkContributorCompliance(repo, prNumber, prData.body ?? "");
  const contributorApprovalHistory = fetchContributorApprovalHistory(repo, prNumber);
  const contributorApprovalOverlap = checkContributorApprovalOverlap(
    prData,
    contributorApprovalHistory,
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
