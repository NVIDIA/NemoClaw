// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { githubGraphql, githubRestPaginated } from "../advisors/github.mts";

const MAX_REVIEW_STATE_ITEMS = 500;
const MAX_REVIEW_THREADS = 1000;
const MAX_THREAD_COMMENTS = 100;
const BODY_CHARACTER_LIMIT = 4_000;
const MAX_REVIEW_STATE_BODY_CHARACTERS = 2_000_000;
const BODY_TRUNCATION_MARKER = "\n\n[PR Review Advisor truncated review text from the middle.]\n\n";

type RestRequest = <T>(apiPath: string, token: string, limit: number) => Promise<T[]>;
type GraphqlRequest = (
  token: string,
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

export type ReviewStateComment = Readonly<{
  id: string;
  databaseId: number | null;
  author: string | null;
  body: string;
  bodySha256: string;
  bodyTruncated: boolean;
  createdAt: string;
  updatedAt: string;
  commitSha: string | null;
  replyToId: string | null;
}>;

export type ReviewStateReview = Readonly<{
  id: number;
  author: string | null;
  state: string;
  body: string;
  bodySha256: string;
  bodyTruncated: boolean;
  commitSha: string;
  submittedAt: string;
}>;

export type ReviewStateIssueComment = Readonly<{
  id: number;
  author: string | null;
  body: string;
  bodySha256: string;
  bodyTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type ReviewStateThread = Readonly<{
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  comments: readonly ReviewStateComment[];
}>;

export type PullRequestReviewState = Readonly<{
  version: 1;
  repository: string;
  prNumber: number;
  headSha: string;
  issueComments: readonly ReviewStateIssueComment[];
  reviews: readonly ReviewStateReview[];
  threads: readonly ReviewStateThread[];
}>;

const REVIEW_THREADS_QUERY = `query AdvisorReviewThreads(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          comments(first: 100) {
            totalCount
            nodes {
              id
              databaseId
              author { login }
              body
              createdAt
              updatedAt
              commit { oid }
              replyTo { id }
            }
          }
        }
      }
    }
  }
}`;

export async function collectPullRequestReviewState(
  repository: string,
  prNumber: number,
  token: string,
  requests: { rest?: RestRequest; graphql?: GraphqlRequest } = {},
): Promise<PullRequestReviewState> {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error("Review state requires a canonical repository and pull request number");
  }
  const rest = requests.rest ?? githubRestPaginated;
  const graphql = requests.graphql ?? githubGraphql;
  const [rawIssueComments, rawReviews, threadResult] = await Promise.all([
    rest<unknown>(`repos/${repository}/issues/${prNumber}/comments`, token, MAX_REVIEW_STATE_ITEMS),
    rest<unknown>(`repos/${repository}/pulls/${prNumber}/reviews`, token, MAX_REVIEW_STATE_ITEMS),
    collectReviewThreads({ owner, name, prNumber, token, graphql }),
  ]);
  if (
    rawIssueComments.length >= MAX_REVIEW_STATE_ITEMS ||
    rawReviews.length >= MAX_REVIEW_STATE_ITEMS
  ) {
    throw new Error("Review state exceeds its bounded issue-comment or review limit");
  }
  return normalizeReviewState({
    version: 1,
    repository,
    prNumber,
    headSha: threadResult.headSha,
    issueComments: rawIssueComments.map(normalizeIssueComment),
    reviews: rawReviews.map(normalizeReview),
    threads: threadResult.threads,
  });
}

async function collectReviewThreads(input: {
  owner: string;
  name: string;
  prNumber: number;
  token: string;
  graphql: GraphqlRequest;
}): Promise<{ headSha: string; threads: ReviewStateThread[] }> {
  const threads: ReviewStateThread[] = [];
  let after: string | null = null;
  let headSha: string | undefined;
  for (;;) {
    const payload = await input.graphql(input.token, REVIEW_THREADS_QUERY, {
      owner: input.owner,
      name: input.name,
      number: input.prNumber,
      after,
    });
    const pull = nested(payload, ["data", "repository", "pullRequest"]);
    if (!isRecord(pull)) throw new Error("GitHub review state is missing its pull request");
    const pageHeadSha = fullSha(pull.headRefOid, "review-state head SHA");
    headSha ??= pageHeadSha;
    if (pageHeadSha !== headSha)
      throw new Error("Pull request head changed during review-state read");
    const connection = pull.reviewThreads;
    if (!isRecord(connection) || !Array.isArray(connection.nodes)) {
      throw new Error("GitHub review state is missing its thread connection");
    }
    for (const value of connection.nodes) {
      threads.push(normalizeThread(value));
      if (threads.length > MAX_REVIEW_THREADS) {
        throw new Error("Review state exceeds its bounded thread limit");
      }
    }
    const pageInfo = connection.pageInfo;
    if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
      throw new Error("GitHub review state has invalid pagination");
    }
    if (!pageInfo.hasNextPage) break;
    after = nonemptyString(pageInfo.endCursor, "review-state end cursor", 256);
  }
  return { headSha: headSha!, threads };
}

export function parsePullRequestReviewState(
  value: unknown,
  expected: { repository: string; prNumber: number; headSha: string },
): PullRequestReviewState {
  if (!isRecord(value)) throw new Error("Prepared review state must be an object");
  const normalized = normalizeReviewState(value as unknown as PullRequestReviewState);
  if (
    normalized.repository !== expected.repository ||
    normalized.prNumber !== expected.prNumber ||
    normalized.headSha !== expected.headSha
  ) {
    throw new Error("Prepared review state does not match the exact pull request head");
  }
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    throw new Error("Prepared review state is not canonical");
  }
  return normalized;
}

export function pullRequestReviewStateDigest(state: PullRequestReviewState): string {
  return `sha256:${sha256(canonicalJson(state))}`;
}

function normalizeReviewState(value: PullRequestReviewState): PullRequestReviewState {
  if (!isRecord(value)) throw new Error("Review state must be an object");
  exactKeys(
    value,
    ["version", "repository", "prNumber", "headSha", "issueComments", "reviews", "threads"],
    "review state",
  );
  if (value.version !== 1) throw new Error("Review state version must be 1");
  const repository = nonemptyString(value.repository, "review-state repository", 256);
  const prNumber = positiveInteger(value.prNumber, "review-state PR number");
  const headSha = fullSha(value.headSha, "review-state head SHA");
  if (!Array.isArray(value.issueComments) || value.issueComments.length >= MAX_REVIEW_STATE_ITEMS) {
    throw new Error("Review-state issue comments are invalid");
  }
  if (!Array.isArray(value.reviews) || value.reviews.length >= MAX_REVIEW_STATE_ITEMS) {
    throw new Error("Review-state reviews are invalid");
  }
  if (!Array.isArray(value.threads) || value.threads.length > MAX_REVIEW_THREADS) {
    throw new Error("Review-state threads are invalid");
  }
  let bodyCharacters = 0;
  const accountBodyCharacters = (amount: number): void => {
    bodyCharacters += amount;
    if (bodyCharacters > MAX_REVIEW_STATE_BODY_CHARACTERS) {
      throw new Error("Review-state text exceeds its bounded context budget");
    }
  };
  const issueComments = value.issueComments
    .map((item) => {
      const comment = normalizeIssueComment(item);
      accountBodyCharacters(comment.body.length);
      return comment;
    })
    .sort(byNumericId);
  const reviews = value.reviews
    .map((item) => {
      const review = normalizeReview(item);
      accountBodyCharacters(review.body.length);
      return review;
    })
    .sort(byNumericId);
  const threads = value.threads
    .map((item) => {
      const thread = normalizeThread(item);
      accountBodyCharacters(
        thread.comments.reduce((total, comment) => total + comment.body.length, 0),
      );
      return thread;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(
    issueComments.map(({ id }) => String(id)),
    "review-state issue-comment IDs",
  );
  assertUnique(
    reviews.map(({ id }) => String(id)),
    "review-state review IDs",
  );
  assertUnique(
    threads.map(({ id }) => id),
    "review-state thread IDs",
  );
  return Object.freeze({
    version: 1,
    repository,
    prNumber,
    headSha,
    issueComments: Object.freeze(issueComments),
    reviews: Object.freeze(reviews),
    threads: Object.freeze(threads),
  });
}

function normalizeIssueComment(value: unknown): ReviewStateIssueComment {
  if (!isRecord(value)) throw new Error("Review-state issue comment must be an object");
  const body = normalizedBody(value, "issue-comment");
  return Object.freeze({
    id: positiveInteger(value.id, "issue-comment id"),
    author: nullableLogin(isRecord(value.user) ? value.user.login : value.author),
    ...body,
    createdAt: timestamp(value.created_at ?? value.createdAt, "issue-comment createdAt"),
    updatedAt: timestamp(value.updated_at ?? value.updatedAt, "issue-comment updatedAt"),
  });
}

function normalizeReview(value: unknown): ReviewStateReview {
  if (!isRecord(value)) throw new Error("Review-state review must be an object");
  const body = normalizedBody(value, "review");
  return Object.freeze({
    id: positiveInteger(value.id, "review id"),
    author: nullableLogin(isRecord(value.user) ? value.user.login : value.author),
    state: nonemptyString(value.state, "review state", 64).toUpperCase(),
    ...body,
    commitSha: fullSha(value.commit_id ?? value.commitSha, "review commit SHA"),
    submittedAt: timestamp(value.submitted_at ?? value.submittedAt, "review submittedAt"),
  });
}

function normalizeThread(value: unknown): ReviewStateThread {
  if (!isRecord(value)) throw new Error("Review-state thread must be an object");
  const commentsConnection = value.comments;
  const comments = Array.isArray(commentsConnection)
    ? commentsConnection
    : isRecord(commentsConnection) && Array.isArray(commentsConnection.nodes)
      ? commentsConnection.nodes
      : undefined;
  if (!comments) throw new Error("Review-state thread comments are invalid");
  if (
    comments.length > MAX_THREAD_COMMENTS ||
    (isRecord(commentsConnection) && commentsConnection.totalCount !== comments.length)
  ) {
    throw new Error("Review-state thread comments exceed their complete bounded contract");
  }
  const normalizedComments = comments
    .map(normalizeThreadComment)
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(
    normalizedComments.map(({ id }) => id),
    "review-state thread-comment IDs",
  );
  return Object.freeze({
    id: nonemptyString(value.id, "review-thread id", 256),
    isResolved: boolean(value.isResolved, "review-thread isResolved"),
    isOutdated: boolean(value.isOutdated, "review-thread isOutdated"),
    path: safePath(value.path),
    line: nullablePositiveInteger(value.line, "review-thread line"),
    originalLine: nullablePositiveInteger(value.originalLine, "review-thread originalLine"),
    startLine: nullablePositiveInteger(value.startLine, "review-thread startLine"),
    originalStartLine: nullablePositiveInteger(
      value.originalStartLine,
      "review-thread originalStartLine",
    ),
    comments: Object.freeze(normalizedComments),
  });
}

function normalizeThreadComment(value: unknown): ReviewStateComment {
  if (!isRecord(value)) throw new Error("Review-state thread comment must be an object");
  const body = normalizedBody(value, "thread-comment");
  const commit = value.commit;
  const replyTo = value.replyTo;
  const commitSha = Object.hasOwn(value, "commitSha")
    ? value.commitSha
    : isRecord(commit)
      ? commit.oid
      : null;
  const replyToId = Object.hasOwn(value, "replyToId")
    ? value.replyToId
    : isRecord(replyTo)
      ? replyTo.id
      : null;
  return Object.freeze({
    id: nonemptyString(value.id, "thread-comment id", 256),
    databaseId:
      value.databaseId === null
        ? null
        : positiveInteger(value.databaseId, "thread-comment databaseId"),
    author: nullableLogin(isRecord(value.author) ? value.author.login : value.author),
    ...body,
    createdAt: timestamp(value.createdAt, "thread-comment createdAt"),
    updatedAt: timestamp(value.updatedAt, "thread-comment updatedAt"),
    commitSha: commitSha === null ? null : fullSha(commitSha, "thread-comment commit SHA"),
    replyToId:
      replyToId === null ? null : nonemptyString(replyToId, "thread-comment replyTo id", 256),
  });
}

function normalizedBody(
  value: Record<string, unknown>,
  label: "issue-comment" | "review" | "thread-comment",
): { body: string; bodySha256: string; bodyTruncated: boolean } {
  const body = string(value.body, `${label} body`);
  const hasDigest = Object.hasOwn(value, "bodySha256");
  const hasTruncated = Object.hasOwn(value, "bodyTruncated");
  if (hasDigest !== hasTruncated) {
    throw new Error(`${label} body metadata must be complete`);
  }
  if (!hasDigest) {
    return {
      body: boundedBody(body),
      bodySha256: `sha256:${sha256(body)}`,
      bodyTruncated: body.length > BODY_CHARACTER_LIMIT,
    };
  }
  const bodySha256 = sha256Digest(value.bodySha256, `${label} bodySha256`);
  const bodyTruncated = boolean(value.bodyTruncated, `${label} bodyTruncated`);
  if (body.length > BODY_CHARACTER_LIMIT) {
    throw new Error(`${label} prepared body exceeds its bounded contract`);
  }
  if (bodyTruncated) {
    if (body.length !== BODY_CHARACTER_LIMIT || !body.includes(BODY_TRUNCATION_MARKER)) {
      throw new Error(`${label} prepared truncated body is invalid`);
    }
  } else if (bodySha256 !== `sha256:${sha256(body)}`) {
    throw new Error(`${label} prepared body digest does not match its text`);
  }
  return { body, bodySha256, bodyTruncated };
}

function boundedBody(value: string): string {
  if (value.length <= BODY_CHARACTER_LIMIT) return value;
  const remaining = BODY_CHARACTER_LIMIT - BODY_TRUNCATION_MARKER.length;
  const first = Math.ceil(remaining / 2);
  return `${value.slice(0, first)}${BODY_TRUNCATION_MARKER}${value.slice(value.length - (remaining - first))}`;
}

function nested(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be bounded printable text`);
  }
  return value;
}

function nullableLogin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return nonemptyString(value, "review-state author", 64);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : positiveInteger(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full SHA`);
  }
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = nonemptyString(value, label, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp`);
  return result;
}

function safePath(value: unknown): string {
  const result = nonemptyString(value, "review-thread path", 512);
  if (!/^[A-Za-z0-9._/ -]+$/u.test(result) || result.startsWith("/") || result.includes("..")) {
    throw new Error("Review-thread path must be repository-relative");
  }
  return result;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function byNumericId(left: { id: number }, right: { id: number }): number {
  return left.id - right.id;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
