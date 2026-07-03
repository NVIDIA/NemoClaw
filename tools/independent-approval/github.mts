// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ApprovalReview,
  type ContributorIdentity,
  type ContributorObservation,
  INDEPENDENT_APPROVAL_CHECK,
  LEDGER_MARKER,
  evaluateIndependentApproval,
  mergeContributors,
  parseObservationComment,
  renderObservationComment,
} from "./policy.mts";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.resolve(SCRIPT_DIR, "../../ci/independent-approval-policy.json");
const GITHUB_ACTIONS_BOT = "github-actions[bot]";
const GITHUB_ACTIONS_BOT_ID = 41_898_282;

const CONTRIBUTOR_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      author { __typename login ... on User { databaseId } }
      headRefOid
      commits(first:100,after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          commit {
            authors(first:100) {
              pageInfo { hasNextPage }
              nodes { user { __typename login ... on User { databaseId } } }
            }
            committer { user { __typename login ... on User { databaseId } } }
          }
        }
      }
    }
  }
}`;

interface PolicyConfig {
  version: 1;
  eligiblePermissions: string[];
  serviceAccountLogins: string[];
}

interface GraphqlActor {
  __typename?: string;
  login?: string;
  databaseId?: number | null;
}

interface ContributorQueryResponse {
  data?: {
    repository?: {
      pullRequest?: {
        author?: GraphqlActor | null;
        headRefOid?: string;
        commits?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            commit?: {
              authors?: {
                pageInfo?: { hasNextPage?: boolean };
                nodes?: Array<{ user?: GraphqlActor | null }>;
              };
              committer?: { user?: GraphqlActor | null } | null;
            };
          }>;
        };
      } | null;
    };
  };
}

interface IssueComment {
  body?: string;
  created_at?: string;
  updated_at?: string;
  user?: { id?: number; login?: string; type?: string };
}

interface ReviewApiRecord {
  id?: number;
  state?: string;
  commit_id?: string | null;
  submitted_at?: string;
  user?: { id?: number; login?: string; type?: string } | null;
}

type ValidReviewApiRecord = ReviewApiRecord & {
  id: number;
  state: string;
  submitted_at: string;
  user: { id: number; login: string; type: string };
};

interface CheckRunApiRecord {
  id?: number;
  name?: string;
  app?: { slug?: string } | null;
}

interface CheckRunsApiResponse {
  check_runs?: CheckRunApiRecord[];
}

interface PublishedCheck {
  id: number;
  headSha: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function runGh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    input,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  }).trim();
}

function ghJson<T>(args: string[], input?: string): T {
  const output = runGh(args, input);
  return JSON.parse(output) as T;
}

function parseNdjson<T>(output: string): T[] {
  if (!output.trim()) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function actorIdentity(actor: GraphqlActor | null | undefined): ContributorIdentity | null {
  if (!actor?.login) return null;
  return {
    id: Number.isInteger(actor.databaseId) ? (actor.databaseId ?? null) : null,
    login: actor.login,
    type: actor.__typename ?? "Unknown",
    reasons: [],
  };
}

function withReason(
  actor: GraphqlActor | null | undefined,
  reason: ContributorIdentity["reasons"][number],
): ContributorIdentity | null {
  const identity = actorIdentity(actor);
  return identity ? { ...identity, reasons: [reason] } : null;
}

function requireRepo(value: string): [string, string] {
  if (!REPO_PATTERN.test(value)) throw new Error(`Invalid repository: ${value}`);
  return value.split("/") as [string, string];
}

function requirePrNumber(value: string): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== value) {
    throw new Error(`Invalid pull request number: ${value}`);
  }
  return number;
}

function readPolicy(): PolicyConfig {
  const value = JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8")) as Partial<PolicyConfig>;
  if (
    value.version !== 1 ||
    !Array.isArray(value.eligiblePermissions) ||
    !value.eligiblePermissions.every((permission) => typeof permission === "string") ||
    !Array.isArray(value.serviceAccountLogins) ||
    !value.serviceAccountLogins.every((login) => typeof login === "string")
  ) {
    throw new Error("Invalid independent approval policy configuration");
  }
  return value as PolicyConfig;
}

export function fetchCurrentContributors(
  repo: string,
  prNumber: number,
): {
  headSha: string;
  contributors: ContributorIdentity[];
} {
  const [owner, name] = requireRepo(repo);
  const contributors: ContributorIdentity[] = [];
  let cursor: string | null = null;
  let headSha = "";

  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${CONTRIBUTOR_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${name}`,
      "-F",
      `number=${prNumber}`,
    ];
    if (cursor) args.push("-F", `after=${cursor}`);
    const response = ghJson<ContributorQueryResponse>(args);
    const pullRequest = response.data?.repository?.pullRequest;
    if (
      !pullRequest?.headRefOid ||
      !pullRequest.commits ||
      !Array.isArray(pullRequest.commits.nodes) ||
      typeof pullRequest.commits.pageInfo?.hasNextPage !== "boolean"
    ) {
      throw new Error(`Could not resolve pull request #${prNumber}`);
    }
    if (headSha && headSha !== pullRequest.headRefOid) {
      throw new Error("Pull request head changed while contributor pages were being collected");
    }
    headSha = pullRequest.headRefOid;

    const opener = withReason(pullRequest.author, "pr_opener");
    if (opener) contributors.push(opener);
    for (const node of pullRequest.commits.nodes) {
      if (
        !node.commit?.authors ||
        !Array.isArray(node.commit.authors.nodes) ||
        typeof node.commit.authors.pageInfo?.hasNextPage !== "boolean"
      ) {
        throw new Error("GitHub returned incomplete commit author data");
      }
      const authors = node.commit.authors.nodes;
      if (node.commit.authors.pageInfo.hasNextPage) {
        throw new Error("A commit has more than 100 attributed authors; refusing a partial result");
      }
      authors.forEach((author, index) => {
        const contributor = withReason(author.user, index === 0 ? "commit_author" : "coauthor");
        if (contributor) contributors.push(contributor);
      });
      const committer = withReason(node.commit?.committer?.user, "commit_committer");
      if (committer) contributors.push(committer);
    }

    if (!pullRequest.commits.pageInfo?.hasNextPage) break;
    cursor = pullRequest.commits.pageInfo.endCursor ?? null;
    if (!cursor) throw new Error("Commit pagination did not provide an end cursor");
  }

  return { headSha, contributors: mergeContributors([contributors]) };
}

function fetchComments(repo: string, prNumber: number): IssueComment[] {
  const output = runGh([
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    ".[] | {body, created_at, updated_at, user: {id: .user.id, login: .user.login, type: .user.type}}",
  ]);
  return parseNdjson<IssueComment>(output);
}

export function fetchObservations(repo: string, prNumber: number): ContributorObservation[] {
  const observations: ContributorObservation[] = [];
  const eventBodies = new Map<string, string>();
  for (const comment of fetchComments(repo, prNumber)) {
    const body = comment.body ?? "";
    if (!body.includes(LEDGER_MARKER)) continue;
    if (
      comment.user?.login !== GITHUB_ACTIONS_BOT ||
      comment.user.id !== GITHUB_ACTIONS_BOT_ID ||
      comment.user.type !== "Bot"
    ) {
      continue;
    }
    if (!comment.created_at || comment.created_at !== comment.updated_at) {
      throw new Error("An independent-approval ledger comment was edited or has invalid dates");
    }
    const observation = parseObservationComment(body);
    if (!observation || observation.prNumber !== prNumber) {
      throw new Error("A trusted independent-approval ledger comment is malformed");
    }
    const serialized = JSON.stringify(observation);
    const existing = eventBodies.get(observation.eventId);
    if (existing && existing !== serialized) {
      throw new Error(`Conflicting contributor observations for event ${observation.eventId}`);
    }
    eventBodies.set(observation.eventId, serialized);
    observations.push(observation);
  }
  return observations;
}

function postObservation(
  repo: string,
  prNumber: number,
  observation: ContributorObservation,
): void {
  const body = renderObservationComment(observation);
  runGh(
    ["api", "--method", "POST", `repos/${repo}/issues/${prNumber}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
}

export function recordObservation(input: {
  repo: string;
  prNumber: number;
  eventAction: string;
  eventId: string;
  expectedHeadSha: string;
  beforeSha?: string;
  eventActor?: { id: number | null; login: string; type: string };
  observedAt?: string;
}): ContributorObservation {
  const snapshot = fetchCurrentContributors(input.repo, input.prNumber);
  if (!SHA_PATTERN.test(input.expectedHeadSha)) {
    throw new Error(`Invalid contributor event head SHA: ${input.expectedHeadSha || "<missing>"}`);
  }
  if (input.beforeSha && !SHA_PATTERN.test(input.beforeSha)) {
    throw new Error(`Invalid contributor event before SHA: ${input.beforeSha}`);
  }
  if (input.eventAction === "synchronize" && !input.beforeSha) {
    throw new Error("Synchronize contributor events require the previous head SHA");
  }
  if (!/^[0-9]+$/u.test(input.eventId)) {
    throw new Error("Contributor event ID must be a GitHub Actions run ID");
  }
  const contributors = [...snapshot.contributors];
  if (input.eventAction === "synchronize" && input.eventActor?.login) {
    contributors.push({ ...input.eventActor, reasons: ["push_actor"] });
  }
  const observation: ContributorObservation = {
    version: 1,
    prNumber: input.prNumber,
    headSha: input.expectedHeadSha,
    beforeSha: input.beforeSha || null,
    eventId: input.eventId,
    observedAt: input.observedAt ?? new Date().toISOString(),
    eventAction: input.eventAction,
    contributors: mergeContributors([contributors]),
  };

  const duplicate = fetchObservations(input.repo, input.prNumber).some(
    (existing) => existing.eventId === observation.eventId,
  );
  if (!duplicate) postObservation(input.repo, input.prNumber, observation);
  return observation;
}

function fetchReviews(repo: string, prNumber: number): ReviewApiRecord[] {
  const output = runGh([
    "api",
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "--paginate",
    "--jq",
    ".[] | {id, state, commit_id, submitted_at, user: {id: .user.id, login: .user.login, type: .user.type}}",
  ]);
  return parseNdjson<ReviewApiRecord>(output);
}

function validateReview(review: ReviewApiRecord): asserts review is ValidReviewApiRecord {
  if (
    !Number.isSafeInteger(review.id) ||
    (review.id ?? 0) <= 0 ||
    typeof review.state !== "string" ||
    !review.state.trim() ||
    typeof review.submitted_at !== "string" ||
    !review.submitted_at.trim() ||
    (review.commit_id !== null &&
      (typeof review.commit_id !== "string" || !SHA_PATTERN.test(review.commit_id))) ||
    !review.user ||
    !Number.isSafeInteger(review.user.id) ||
    (review.user.id ?? 0) <= 0 ||
    typeof review.user.login !== "string" ||
    !review.user.login.trim() ||
    typeof review.user.type !== "string" ||
    !review.user.type.trim()
  ) {
    throw new Error("GitHub returned a malformed pull request review");
  }
}

function fetchPermission(repo: string, login: string): string | null {
  try {
    const response = ghJson<{ permission?: string }>([
      "api",
      `repos/${repo}/collaborators/${login}/permission`,
    ]);
    return typeof response.permission === "string" ? response.permission : null;
  } catch {
    return null;
  }
}

export function evaluatePullRequest(repo: string, prNumber: number) {
  const snapshot = fetchCurrentContributors(repo, prNumber);
  const observations = fetchObservations(repo, prNumber);
  const apiReviews = fetchReviews(repo, prNumber);
  const permissionByLogin = new Map<string, string | null>();
  const reviews: ApprovalReview[] = apiReviews.map((review) => {
    validateReview(review);
    const login = review.user.login;
    if (login && !permissionByLogin.has(login)) {
      permissionByLogin.set(login, fetchPermission(repo, login));
    }
    return {
      id: review.id,
      state: review.state,
      commitId: review.commit_id ?? null,
      submittedAt: review.submitted_at,
      reviewer: {
        id: review.user.id ?? null,
        login: review.user.login,
        type: review.user.type,
      },
      permission: permissionByLogin.get(login) ?? null,
    };
  });
  const policy = readPolicy();
  return {
    headSha: snapshot.headSha,
    result: evaluateIndependentApproval({
      headSha: snapshot.headSha,
      currentContributors: snapshot.contributors,
      observations,
      reviews,
      eligiblePermissions: policy.eligiblePermissions,
      serviceAccountLogins: policy.serviceAccountLogins,
    }),
  };
}

function fetchHeadSha(repo: string, prNumber: number): string {
  const headSha = runGh([
    "api",
    `repos/${repo}/pulls/${prNumber}`,
    "--jq",
    ".head.sha",
  ]).toLowerCase();
  if (!SHA_PATTERN.test(headSha)) {
    throw new Error(`GitHub returned an invalid head SHA for pull request #${prNumber}`);
  }
  return headSha;
}

function findPolicyCheck(repo: string, headSha: string): number | null {
  const response = ghJson<CheckRunsApiResponse>([
    "api",
    `repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(INDEPENDENT_APPROVAL_CHECK)}&per_page=100`,
  ]);
  const candidates = (response.check_runs ?? [])
    .filter(
      (check) =>
        check.name === INDEPENDENT_APPROVAL_CHECK &&
        check.app?.slug === "github-actions" &&
        Number.isSafeInteger(check.id) &&
        (check.id ?? 0) > 0,
    )
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
  return candidates[0]?.id ?? null;
}

function beginPolicyCheck(repo: string, headSha: string): PublishedCheck {
  const existingId = findPolicyCheck(repo, headSha);
  const state = {
    name: INDEPENDENT_APPROVAL_CHECK,
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "Evaluating reviewer independence",
      summary: "The trusted repository reconciler is evaluating the live pull request state.",
    },
  };
  const response = existingId
    ? ghJson<{ id?: number }>(
        ["api", "--method", "PATCH", `repos/${repo}/check-runs/${existingId}`, "--input", "-"],
        JSON.stringify(state),
      )
    : ghJson<{ id?: number }>(
        ["api", "--method", "POST", `repos/${repo}/check-runs`, "--input", "-"],
        JSON.stringify({ ...state, head_sha: headSha }),
      );
  if (!Number.isSafeInteger(response.id) || (response.id ?? 0) <= 0) {
    throw new Error("GitHub did not return a valid independent-approval check run ID");
  }
  return { id: response.id as number, headSha };
}

function finishPolicyCheck(
  repo: string,
  check: PublishedCheck,
  input: { pass: boolean; title: string; summary: string },
): void {
  ghJson<{ id?: number }>(
    ["api", "--method", "PATCH", `repos/${repo}/check-runs/${check.id}`, "--input", "-"],
    JSON.stringify({
      status: "completed",
      conclusion: input.pass ? "success" : "failure",
      completed_at: new Date().toISOString(),
      output: { title: input.title, summary: input.summary },
    }),
  );
}

function resultSummary(result: ReturnType<typeof evaluateIndependentApproval>): string {
  if (result.pass) {
    const approvers = result.qualifyingApprovals.map(({ login }) => `@${login}`).join(", ");
    return `Current qualifying independent approval: ${approvers}.`;
  }
  if (result.reason === "missing_current_head_observation") {
    return "No trusted contributor observation covers the current head. The check fails closed.";
  }
  const rejected = result.rejectedApprovals
    .map(({ login, reasons }) => `@${login}: ${reasons.join(", ")}`)
    .join("; ");
  return rejected
    ? `No qualifying independent approval. Rejected approvals: ${rejected}.`
    : "No qualifying independent human has approved the current head.";
}

function fetchOpenPullRequestsForCommit(repo: string, headSha: string): number[] {
  const output = runGh([
    "api",
    `repos/${repo}/commits/${headSha}/pulls?per_page=100`,
    "--paginate",
    "--jq",
    `.[] | select(.state == "open" and .head.sha == "${headSha}") | .number`,
  ]);
  return [
    ...new Set(
      output
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(requirePrNumber),
    ),
  ].sort((left, right) => left - right);
}

export function publishPullRequestCheck(repo: string, prNumber: number) {
  const initialHeadSha = fetchHeadSha(repo, prNumber);
  const check = beginPolicyCheck(repo, initialHeadSha);
  try {
    const associatedPullRequests = fetchOpenPullRequestsForCommit(repo, initialHeadSha);
    if (!associatedPullRequests.includes(prNumber)) {
      throw new Error(`Pull request #${prNumber} is not associated with its reported head SHA`);
    }
    const evaluations = associatedPullRequests.map((number) => ({
      prNumber: number,
      ...evaluatePullRequest(repo, number),
    }));
    for (const evaluation of evaluations) {
      const finalHeadSha = fetchHeadSha(repo, evaluation.prNumber);
      if (evaluation.headSha !== initialHeadSha || finalHeadSha !== initialHeadSha) {
        throw new Error("Pull request head changed during independent-approval evaluation");
      }
    }
    const checkPass = evaluations.every((evaluation) => evaluation.result.pass);
    const primary = evaluations.find(
      (evaluation) => evaluation.prNumber === prNumber,
    ) as (typeof evaluations)[number];
    const summary = evaluations
      .map((evaluation) => `#${evaluation.prNumber}: ${resultSummary(evaluation.result)}`)
      .join("\n\n");
    finishPolicyCheck(repo, check, {
      pass: checkPass,
      title: checkPass
        ? "Independent human approval present"
        : "Independent human approval required",
      summary,
    });
    return {
      headSha: primary.headSha,
      result: primary.result,
      checkPass,
      evaluatedPullRequests: associatedPullRequests,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishPolicyCheck(repo, check, {
      pass: false,
      title: "Independent-approval evaluation failed closed",
      summary: message,
    });
    throw error;
  }
}

function fetchOpenPullRequestNumbers(repo: string): number[] {
  const output = runGh([
    "api",
    `repos/${repo}/pulls?state=open&per_page=100`,
    "--paginate",
    "--jq",
    ".[] | .number",
  ]);
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(requirePrNumber);
}

export function reconcileOpenPullRequests(repo: string): void {
  const failures: string[] = [];
  for (const prNumber of fetchOpenPullRequestNumbers(repo)) {
    try {
      const evaluation = publishPullRequestCheck(repo, prNumber);
      console.log(
        JSON.stringify({ prNumber, headSha: evaluation.headSha, result: evaluation.result }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`#${prNumber}: ${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to reconcile independent approval: ${failures.join("; ")}`);
  }
}

function parseFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const mode = args[0];
  const repo = parseFlag(args, "--repo") ?? "";
  requireRepo(repo);

  if (mode === "reconcile-open") {
    reconcileOpenPullRequests(repo);
    return;
  }

  const prValue = parseFlag(args, "--pr") ?? "";
  const prNumber = requirePrNumber(prValue);

  if (mode === "record") {
    const action = parseFlag(args, "--event-action") ?? "";
    if (!new Set(["opened", "synchronize"]).has(action)) {
      throw new Error(`Unsupported contributor observation action: ${action}`);
    }
    const actorLogin = parseFlag(args, "--event-actor-login") ?? "";
    const actorIdValue = parseFlag(args, "--event-actor-id") ?? "";
    const actorId = Number.parseInt(actorIdValue, 10);
    const observation = recordObservation({
      repo,
      prNumber,
      eventAction: action,
      eventId: parseFlag(args, "--event-id") ?? "",
      expectedHeadSha: parseFlag(args, "--expected-head-sha") ?? "",
      beforeSha: parseFlag(args, "--before-sha"),
      eventActor: actorLogin
        ? {
            id: Number.isSafeInteger(actorId) && actorId > 0 ? actorId : null,
            login: actorLogin,
            type: parseFlag(args, "--event-actor-type") ?? "User",
          }
        : undefined,
    });
    console.log(JSON.stringify({ recorded: true, observation }, null, 2));
    return;
  }

  if (mode === "evaluate") {
    const evaluation = evaluatePullRequest(repo, prNumber);
    console.log(JSON.stringify(evaluation, null, 2));
    if (!evaluation.result.pass) process.exitCode = 1;
    return;
  }

  if (mode === "publish") {
    const evaluation = publishPullRequestCheck(repo, prNumber);
    console.log(JSON.stringify(evaluation, null, 2));
    return;
  }

  throw new Error(
    "Usage: github.mts <record|evaluate|publish> --repo OWNER/REPO --pr NUMBER | github.mts reconcile-open --repo OWNER/REPO",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Independent approval check failed closed: ${message}`);
    process.exitCode = 1;
  }
}
