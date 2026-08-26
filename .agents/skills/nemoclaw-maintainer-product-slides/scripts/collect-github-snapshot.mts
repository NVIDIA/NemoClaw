// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  prepareProtectedOutputBoundary,
  protectedOutputBoundaryFailure,
  type ProtectedOutputBoundary,
} from "./protected-output.mts";
import {
  canonicalJson,
  canonicalSha256,
  sha256Text,
  type ValidationFinding,
  withoutTopLevelKey,
} from "./validate-slide-model.mts";

export type PageInfo = { hasNextPage: boolean; endCursor: string | null };

export type ConnectionPage<T> = {
  nodes: T[];
  pageInfo: PageInfo;
  totalCount?: number;
};

export type CollectionReceipt = {
  source: string;
  queryId: string;
  querySha256: string;
  scope: Record<string, unknown>;
  requestSha256: string;
  pageCount: number;
  itemCount: number;
  declaredTotalCount: number | null;
  firstCursor: string | null;
  finalCursor: string | null;
  terminalHasNextPage: boolean;
  termination: "exhausted" | "window-cutoff";
  startedAt: string;
  completedAt: string;
  sourceRecords: unknown[];
  sourceSha256: string;
};

export type PaginatedResult<T> = { nodes: T[]; receipt: CollectionReceipt };

export function receiptRequestSha256(querySha256: string, scope: Record<string, unknown>): string {
  return canonicalSha256({ querySha256, scope });
}

export function paginateConnection<T>(options: {
  source: string;
  queryId: string;
  query: string;
  scope?: Record<string, unknown>;
  startedAt?: string;
  fetchPage: (cursor: string | null) => ConnectionPage<T>;
  stopAfterPage?: (nodes: T[]) => boolean;
}): PaginatedResult<T> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const querySha256 = sha256Text(options.query);
  const scope = options.scope ?? {};
  const nodes: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let firstCursor: string | null = null;
  let pageCount = 0;
  let terminalHasNextPage = false;
  let termination: CollectionReceipt["termination"] = "exhausted";
  let declaredTotalCount: number | null = null;

  while (true) {
    const page = options.fetchPage(cursor);
    pageCount += 1;
    if (!Array.isArray(page.nodes) || !page.pageInfo) {
      throw new Error(`${options.queryId} returned an invalid connection page`);
    }
    if (
      typeof page.pageInfo.hasNextPage !== "boolean" ||
      !isReceiptCursor(page.pageInfo.endCursor)
    ) {
      throw new Error(`${options.queryId} returned invalid page cursor state`);
    }
    if (page.totalCount !== undefined) {
      if (!Number.isInteger(page.totalCount) || page.totalCount < 0) {
        throw new Error(`${options.queryId} returned an invalid totalCount`);
      }
      if (declaredTotalCount !== null && declaredTotalCount !== page.totalCount) {
        throw new Error(`${options.queryId} changed totalCount during pagination`);
      }
      declaredTotalCount = page.totalCount;
    }
    nodes.push(...page.nodes);
    const endCursor = page.pageInfo.endCursor;
    if (pageCount === 1) firstCursor = endCursor;
    terminalHasNextPage = page.pageInfo.hasNextPage;

    if (options.stopAfterPage?.(page.nodes) && page.pageInfo.hasNextPage) {
      if (!endCursor) {
        throw new Error(`${options.queryId} reached a window cutoff but has no end cursor`);
      }
      termination = "window-cutoff";
      cursor = endCursor;
      break;
    }
    if (!page.pageInfo.hasNextPage) {
      cursor = endCursor;
      break;
    }
    if (!endCursor) {
      throw new Error(`${options.queryId} has another page but no end cursor`);
    }
    if (seenCursors.has(endCursor)) {
      throw new Error(`${options.queryId} repeated cursor ${endCursor}`);
    }
    seenCursors.add(endCursor);
    cursor = endCursor;
  }

  if (
    termination === "exhausted" &&
    declaredTotalCount !== null &&
    nodes.length !== declaredTotalCount
  ) {
    throw new Error(
      `${options.queryId} collected ${nodes.length} items but GitHub reported ${declaredTotalCount}`,
    );
  }

  const completedAt = new Date().toISOString();
  return {
    nodes,
    receipt: {
      source: options.source,
      queryId: options.queryId,
      querySha256,
      scope,
      requestSha256: receiptRequestSha256(querySha256, scope),
      pageCount,
      itemCount: nodes.length,
      declaredTotalCount,
      firstCursor,
      finalCursor: cursor,
      terminalHasNextPage,
      termination,
      startedAt,
      completedAt,
      sourceRecords: nodes,
      sourceSha256: canonicalSha256(nodes),
    },
  };
}

export function dedupeByNodeId<T extends { nodeId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item.nodeId)) {
      seen.add(item.nodeId);
      result.push(item);
    }
  }
  return result;
}

export function inHalfOpenWindow(timestamp: string, start: string, end: string): boolean {
  const value = Date.parse(timestamp);
  return value >= Date.parse(start) && value < Date.parse(end);
}

export function rollingWindow(asOf: string): { start: string; end: string } {
  const end = Date.parse(asOf);
  if (Number.isNaN(end)) throw new Error("asOf must be an ISO-8601 timestamp");
  return {
    start: new Date(end - 7 * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(end).toISOString(),
  };
}

function isReceiptCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

export function receiptTraversalError(
  receipt: CollectionReceipt,
  window: { start: string; end: string },
): string | null {
  if (receipt.termination !== "exhausted" && receipt.termination !== "window-cutoff") {
    return "termination is not exhausted or window-cutoff";
  }
  if (typeof receipt.terminalHasNextPage !== "boolean") {
    return "terminalHasNextPage is not a boolean";
  }
  if (!isReceiptCursor(receipt.firstCursor) || !isReceiptCursor(receipt.finalCursor)) {
    return "firstCursor and finalCursor must each be null or a nonempty string";
  }
  if (receipt.source === "github-rest-or-single-object") {
    if (receipt.firstCursor !== null || receipt.finalCursor !== null) {
      return "single-object receipts cannot retain connection cursors";
    }
  } else if (Number.isInteger(receipt.pageCount) && receipt.pageCount > 0) {
    if (receipt.pageCount === 1 && receipt.firstCursor !== receipt.finalCursor) {
      return "one-page receipts must retain the same first and final cursor";
    }
    if (
      receipt.pageCount > 1 &&
      (typeof receipt.firstCursor !== "string" || typeof receipt.finalCursor !== "string")
    ) {
      return "multi-page receipts must retain first and final cursors";
    }
  }
  if (receipt.termination === "exhausted") {
    return receipt.terminalHasNextPage === false
      ? null
      : "exhausted receipts must end with hasNextPage false";
  }
  const timestampField =
    receipt.queryId === "stargazers-window"
      ? "starredAt"
      : receipt.queryId === "forks-window"
        ? "createdAt"
        : null;
  if (timestampField === null) {
    return "window-cutoff is allowed only for stargazer and fork receipts";
  }
  if (receipt.terminalHasNextPage !== true) {
    return "window-cutoff receipts must end with hasNextPage true";
  }
  if (typeof receipt.finalCursor !== "string") {
    return "window-cutoff receipts must retain a terminal cursor";
  }
  if (!Array.isArray(receipt.sourceRecords) || receipt.sourceRecords.length === 0) {
    return "window-cutoff receipts must retain ordered source records";
  }
  const timestamps: number[] = [];
  for (const value of receipt.sourceRecords) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "window-cutoff source records must be JSON objects";
    }
    const timestamp = (value as Record<string, unknown>)[timestampField];
    if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
      return `window-cutoff source records must retain ${timestampField}`;
    }
    timestamps.push(Date.parse(timestamp));
  }
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] > timestamps[index - 1]) {
      return "window-cutoff source records are not ordered newest to oldest";
    }
  }
  const windowStart = Date.parse(window.start);
  const firstPreWindowIndex = timestamps.findIndex((timestamp) => timestamp < windowStart);
  if (firstPreWindowIndex < 0) {
    return "window-cutoff source records do not cross the window start";
  }
  for (let index = 0; index < firstPreWindowIndex; index += 1) {
    const rawTimestamp = (receipt.sourceRecords[index] as Record<string, unknown>)[timestampField];
    if (
      typeof rawTimestamp !== "string" ||
      !inHalfOpenWindow(rawTimestamp, window.start, window.end)
    ) {
      return "window-cutoff source records before the cutoff are not all in-window";
    }
  }
  const terminalTimestamp = timestamps.at(-1);
  if (terminalTimestamp === undefined || terminalTimestamp >= windowStart) {
    return "the terminal retained source record is not pre-window cutoff evidence";
  }
  return null;
}

function extractSection(body: string, heading: string): string | null {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const matcher = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*#*\\s*$`,
    "iu",
  );
  const start = lines.findIndex((line) => matcher.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const content = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return content || null;
}

export function extractOutcome(body: string): string | null {
  return (
    extractSection(body, "Outcome")
      ?.replace(/<!--.*?-->/gsu, " ")
      .replace(/\s+/gu, " ")
      .trim() ?? null
  );
}

export function workTrackingIssueNumbers(body: string): number[] {
  const section = extractSection(body, "Work Tracking");
  if (!section) return [];
  const numbers = new Set<number>();
  const pattern =
    /(?:https:\/\/github\.com\/NVIDIA\/NemoClaw\/issues\/|(?<![A-Za-z0-9])#)(\d+)\b/gu;
  for (const match of section.matchAll(pattern)) numbers.add(Number(match[1]));
  return [...numbers].sort((left, right) => left - right);
}

export function normalizeProgress(
  children: Array<{ nodeId: string; state: string }>,
): "Unknown" | { completed: number; total: number; percentage: number } {
  const normalized = dedupeByNodeId(children);
  if (normalized.length === 0) return "Unknown";
  const completed = normalized.filter((child) => child.state === "CLOSED").length;
  return {
    completed,
    total: normalized.length,
    percentage: Math.round((completed / normalized.length) * 1000) / 10,
  };
}

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

type TagCandidate = {
  name: string;
  tagObjectId: string;
  commitSha: string;
  publishedAt: string;
  commitDate: string;
  url: string;
  peeled: boolean;
  defaultBranchAncestor?: boolean;
};

export function selectStableTags(tags: TagCandidate[], count: number): TagCandidate[] {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("release-count must be a positive integer");
  const unpeeled = tags.find((tag) => STABLE_TAG.test(tag.name) && !tag.peeled);
  if (unpeeled) {
    throw new Error(
      `Stable tag ${unpeeled.name} could not be dereferenced to a commit; recollect after the tag object is readable`,
    );
  }
  const candidates = tags.filter((tag) => STABLE_TAG.test(tag.name) && tag.peeled);
  const unique = new Map<string, TagCandidate>();
  for (const tag of candidates) {
    if (unique.has(tag.name)) throw new Error(`Duplicate stable tag ref: ${tag.name}`);
    unique.set(tag.name, tag);
  }
  return [...unique.values()]
    .sort((left, right) => {
      const dateOrder = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
      if (dateOrder !== 0) return dateOrder;
      const leftParts = STABLE_TAG.exec(left.name)?.slice(1).map(Number) ?? [];
      const rightParts = STABLE_TAG.exec(right.name)?.slice(1).map(Number) ?? [];
      for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, count);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function exactAnnouncementMatches<T extends { title: string; body: string }>(
  tag: string,
  discussions: T[],
): T[] {
  const token = new RegExp(`(?<![A-Za-z0-9_.+-])${escapePattern(tag)}(?![A-Za-z0-9_.+-])`, "u");
  return discussions.filter((discussion) => token.test(`${discussion.title}\n${discussion.body}`));
}

function ghJson<T>(args: string[], input?: unknown): T {
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      input: input === undefined ? undefined : JSON.stringify(input),
      maxBuffer: 100 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return JSON.parse(output) as T;
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    if (stdout.trimStart().startsWith("{")) return JSON.parse(stdout) as T;
    throw error;
  }
}

function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: { allowNotFound?: boolean } = {},
): T {
  const payload = ghJson<{
    data?: T;
    errors?: Array<{ message?: string; type?: string }>;
  }>(["api", "graphql", "--input", "-"], { query, variables });
  const unexpectedErrors = (payload.errors ?? []).filter(
    (error) => !(options.allowNotFound && error.type === "NOT_FOUND"),
  );
  if (unexpectedErrors.length > 0) {
    throw new Error(
      `GitHub GraphQL returned errors: ${unexpectedErrors.map((error) => error.message ?? "unknown").join("; ")}`,
    );
  }
  if (!payload.data) throw new Error("GitHub GraphQL returned no data");
  return payload.data;
}

function repositoryRest<T>(apiPath: string): T {
  return ghJson<T>(["api", apiPath]);
}

export type RawMilestone = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  dueOn: string | null;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  url: string;
};

export type ResolvedMilestoneSelection = {
  milestone: RawMilestone;
  displayTitle: string;
};

export type RawIssue = {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  createdAt: string;
  closedAt: string | null;
  issueType: null | { id: string; name: string };
  subIssues: ConnectionPage<{
    id: string;
    number: number;
    state: string;
    url: string;
  }>;
};

export type RawOpenIssue = {
  id: string;
  number: number;
  title: string;
  body?: string;
  state: "OPEN";
  url: string;
  createdAt?: string;
  closedAt: null;
  issueType: null | { id: string; name: string };
  milestone: null | { id: string; number: number };
};

export type DetailedRawOpenIssue = RawOpenIssue & {
  body: string;
  createdAt: string;
};

type RawDiscussion = {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

type RawRef = {
  id: string;
  name: string;
  target:
    | { __typename: "Commit"; oid: string; committedDate: string; url: string }
    | {
        __typename: "Tag";
        id: string;
        tagger: null | { date: string };
        target:
          | {
              __typename: "Commit";
              oid: string;
              committedDate: string;
              url: string;
            }
          | { __typename: string };
      };
};

type CliOptions = {
  repo: string;
  milestones: string[];
  releaseCount: number;
  metricMode: "retained_additions" | "net_change";
  baselineSnapshot?: string;
  baselineApproval?: string;
  presentationMap?: string;
  output?: string;
  snapshotWorkerPath?: string;
};

type SnapshotSignal = "SIGINT" | "SIGTERM";

export type SnapshotOutputOperations = {
  open: (filePath: string, flags: number, mode: number) => number;
  fchmod: (descriptor: number, mode: number) => void;
  write: (descriptor: number, value: string) => void;
  fsync: (descriptor: number) => void;
  close: (descriptor: number) => void;
  link: (temporaryPath: string, outputPath: string) => void;
  lstat: (filePath: string) => { dev: number | bigint; ino: number | bigint };
  unlink: (filePath: string) => void;
};

type SnapshotOutputOptions = {
  operations?: Partial<SnapshotOutputOperations>;
  beforeLink?: (temporaryPath: string, outputPath: string) => void;
};

const DEFAULT_SNAPSHOT_OUTPUT_OPERATIONS: SnapshotOutputOperations = {
  open: (filePath, flags, mode) => openSync(filePath, flags, mode),
  fchmod: (descriptor, mode) => fchmodSync(descriptor, mode),
  write: (descriptor, value) => writeFileSync(descriptor, value, "utf8"),
  fsync: (descriptor) => fsyncSync(descriptor),
  close: (descriptor) => closeSync(descriptor),
  link: (temporaryPath, outputPath) => linkSync(temporaryPath, outputPath),
  lstat: (filePath) => lstatSync(filePath),
  unlink: (filePath) => unlinkSync(filePath),
};

class SnapshotInterruptionError extends Error {
  readonly signal: SnapshotSignal;

  constructor(signal: SnapshotSignal, context: string) {
    super(`${signal} interrupted GitHub snapshot ${context}`);
    this.name = "SnapshotInterruptionError";
    this.signal = signal;
  }
}

class SnapshotPublicationBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotPublicationBoundaryError";
  }
}

type TemporaryCleanup = {
  detail: string;
  unresolved: boolean;
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function escapeDiagnosticControls(message: string): string {
  return Array.from(message, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return character;
    const isDiagnosticControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (!isDiagnosticControl) return character;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }).join("");
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && ("path" in error || "dest" in error)) {
    const code = errorCode(error) ?? "filesystem error";
    const syscall =
      "syscall" in error && typeof error.syscall === "string" ? error.syscall : undefined;
    return escapeDiagnosticControls(syscall ? `${code} during ${syscall}` : code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return escapeDiagnosticControls(message);
}

function quotePath(filePath: string): string {
  return escapeDiagnosticControls(JSON.stringify(filePath));
}

function createPrivateSnapshotStage(
  outputPath: string,
  operations: SnapshotOutputOperations,
): { descriptor: number; temporaryPath: string } {
  const parent = path.dirname(outputPath);
  const base = path.basename(outputPath);
  const flags =
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const temporaryPath = path.join(
      parent,
      `.${base}.nemoclaw-stage-${process.pid}-${randomBytes(12).toString("hex")}`,
    );
    try {
      const descriptor = operations.open(temporaryPath, flags, 0o600);
      return { descriptor, temporaryPath };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not allocate a unique snapshot staging path for ${quotePath(outputPath)}`);
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function writeSnapshotToDescriptor(
  snapshot: Record<string, unknown>,
  descriptor: number,
  operations: SnapshotOutputOperations,
): void {
  let failure: unknown;
  try {
    const actualHash = canonicalSha256(withoutTopLevelKey(snapshot, "snapshotSha256"));
    if (snapshot.snapshotSha256 !== actualHash)
      throw new Error("Snapshot hash verification failed");
    operations.fchmod(descriptor, 0o600);
    operations.write(descriptor, canonicalJson(snapshot));
    operations.fsync(descriptor);
  } catch (error) {
    failure = error;
  }
  try {
    operations.close(descriptor);
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "Snapshot write and descriptor close failed")
      : error;
  }
  if (failure) throw failure;
}

function removeTemporaryPath(
  temporaryPath: string,
  operations: SnapshotOutputOperations,
): TemporaryCleanup {
  try {
    operations.unlink(temporaryPath);
    return {
      detail: `Removed invocation-created temporary path ${quotePath(temporaryPath)}`,
      unresolved: false,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        detail: `Invocation-created temporary path is absent ${quotePath(temporaryPath)}`,
        unresolved: false,
      };
    }
    return {
      detail: `Unresolved invocation-created temporary path ${quotePath(temporaryPath)}: ${errorMessage(error)}`,
      unresolved: true,
    };
  }
}

type FileIdentityResult =
  | {
      kind: "present";
      identity: { dev: number | bigint; ino: number | bigint };
    }
  | { kind: "absent" }
  | { kind: "unknown"; error: unknown };

function fileIdentity(filePath: string, operations: SnapshotOutputOperations): FileIdentityResult {
  try {
    return { kind: "present", identity: operations.lstat(filePath) };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unknown", error };
  }
}

function pathStateDetail(
  label: "possible snapshot target" | "invocation-created temporary path",
  filePath: string,
  state: FileIdentityResult,
): string {
  if (state.kind === "present") return `Preserved ${label} ${quotePath(filePath)}`;
  const sentenceLabel = `${label[0].toUpperCase()}${label.slice(1)}`;
  if (state.kind === "absent") return `${sentenceLabel} is absent ${quotePath(filePath)}`;
  return `${sentenceLabel} state is unknown for ${quotePath(filePath)}: ${errorMessage(state.error)}`;
}

function ambiguousFinalizationError(
  outputPath: string,
  temporaryPath: string,
  cause: unknown,
  target: FileIdentityResult,
  temporary: FileIdentityResult,
): Error {
  return new Error(
    `Snapshot finalization returned an error for ${quotePath(outputPath)}: ${errorMessage(cause)}. Target ownership is ambiguous. ${pathStateDetail("possible snapshot target", outputPath, target)}. ${pathStateDetail("invocation-created temporary path", temporaryPath, temporary)}. Inspect both paths; do not rerun with this output path.`,
    { cause },
  );
}

function reconcileLinkFailure(
  temporaryPath: string,
  outputPath: string,
  cause: unknown,
  operations: SnapshotOutputOperations,
): never {
  const target = fileIdentity(outputPath, operations);
  if (target.kind === "unknown") {
    const temporary = fileIdentity(temporaryPath, operations);
    throw ambiguousFinalizationError(outputPath, temporaryPath, cause, target, temporary);
  }
  if (target.kind === "absent") {
    const cleanup = removeTemporaryPath(temporaryPath, operations);
    throw new Error(
      `GitHub snapshot finalization failed for ${quotePath(outputPath)}: ${errorMessage(cause)}. This invocation did not publish the snapshot. ${cleanup.detail}.`,
      { cause },
    );
  }

  const temporary = fileIdentity(temporaryPath, operations);
  if (temporary.kind !== "present") {
    throw ambiguousFinalizationError(outputPath, temporaryPath, cause, target, temporary);
  }
  if (sameFile(target.identity, temporary.identity)) {
    throw ambiguousFinalizationError(outputPath, temporaryPath, cause, target, temporary);
  }

  const cleanup = removeTemporaryPath(temporaryPath, operations);
  const message =
    errorCode(cause) === "EEXIST"
      ? `Snapshot output already exists and was not changed: ${quotePath(outputPath)}`
      : `GitHub snapshot finalization failed while a different target exists at ${quotePath(outputPath)}: ${errorMessage(cause)}`;
  throw new Error(`${message}. ${cleanup.detail}.`, { cause });
}

type SnapshotFinalizationOptions = {
  beforeLink?: SnapshotOutputOptions["beforeLink"];
  assertBoundary?: () => void;
  confirmPublication?: () => void;
};

function finalizeSnapshotStage(
  temporaryPath: string,
  outputPath: string,
  operations: SnapshotOutputOperations,
  options: SnapshotFinalizationOptions = {},
): void {
  try {
    options.beforeLink?.(temporaryPath, outputPath);
    options.assertBoundary?.();
    operations.link(temporaryPath, outputPath);
  } catch (error) {
    if (error instanceof SnapshotPublicationBoundaryError) throw error;
    options.assertBoundary?.();
    reconcileLinkFailure(temporaryPath, outputPath, error, operations);
  }

  options.confirmPublication?.();

  const cleanup = removeTemporaryPath(temporaryPath, operations);
  if (cleanup.unresolved) {
    throw new Error(
      `GitHub snapshot was published at ${quotePath(outputPath)}, but temporary cleanup failed. Preserved published snapshot target ${quotePath(outputPath)}. ${cleanup.detail}.`,
    );
  }
}

export function writeGitHubSnapshotOutput(
  snapshot: Record<string, unknown>,
  requestedOutputPath: string,
  options: SnapshotOutputOptions = {},
): void {
  const outputBoundary = prepareProtectedOutputBoundary(requestedOutputPath, "Snapshot");
  const outputPath = outputBoundary.outputPath;

  const operations = {
    ...DEFAULT_SNAPSHOT_OUTPUT_OPERATIONS,
    ...options.operations,
  };
  let stage: { descriptor: number; temporaryPath: string };
  try {
    stage = createPrivateSnapshotStage(outputPath, operations);
  } catch (error) {
    throw new Error(
      `GitHub snapshot staging allocation failed for ${quotePath(outputPath)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    writeSnapshotToDescriptor(snapshot, stage.descriptor, operations);
  } catch (error) {
    const cleanup = removeTemporaryPath(stage.temporaryPath, operations);
    throw new Error(
      `GitHub snapshot staging failed for ${quotePath(outputPath)}: ${errorMessage(error)}. This invocation did not publish the snapshot. ${cleanup.detail}.`,
      { cause: error },
    );
  }
  finalizeSnapshotStage(stage.temporaryPath, outputPath, operations, {
    beforeLink: options.beforeLink,
    assertBoundary: () => {
      const boundaryFailure = protectedOutputBoundaryFailure(outputBoundary);
      if (boundaryFailure) {
        throw new SnapshotPublicationBoundaryError(
          `${boundaryFailure}. Preserved invocation-created temporary path ${quotePath(stage.temporaryPath)}`,
        );
      }
    },
  });
}

function validUtcDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] ?? "000"}Z`;
  return new Date(parsed).toISOString() === normalized;
}

export function resolveMilestoneSelections(
  all: RawMilestone[],
  requested: string[],
  aliases: Record<string, string> = {},
  asOf?: string,
  findings: ValidationFinding[] = [],
  openIssues: RawOpenIssue[] = [],
): ResolvedMilestoneSelection[] {
  const requestedSelections: ResolvedMilestoneSelection[] = [];
  const seen = new Set<string>();
  for (const requestedTitle of requested) {
    const title = aliases[requestedTitle] ?? requestedTitle;
    const matches = all.filter((milestone) => milestone.title === title);
    if (matches.length !== 1)
      throw new Error(`Milestone ${title} resolved to ${matches.length} matches`);
    if (seen.has(matches[0].id))
      throw new Error(`Milestone selected more than once: ${requestedTitle}`);
    seen.add(matches[0].id);
    requestedSelections.push({
      milestone: matches[0],
      displayTitle:
        aliases[requestedTitle] === matches[0].title ? requestedTitle : matches[0].title,
    });
  }

  if (!validUtcDateTime(asOf)) {
    throw new Error("Milestone selection requires an ISO-8601 asOf timestamp");
  }
  const asOfTime = Date.parse(asOf);
  findings.push(...roadmapLifecycleFindings(all, asOf, openIssues));
  const eligible = new Set<string>();
  for (const milestone of all) {
    validateMilestoneLifecycle(milestone);
    if (milestone.state === "CLOSED") continue;
    if (!validUtcDateTime(milestone.dueOn)) {
      continue;
    }
    const dueDate = milestone.dueOn.slice(0, 10);
    if (dueDate < new Date(asOfTime).toISOString().slice(0, 10)) continue;
    eligible.add(milestone.id);
  }

  if (requested.length > 0) {
    return requestedSelections.filter(({ milestone }) => eligible.has(milestone.id));
  }
  return all
    .filter((milestone) => eligible.has(milestone.id))
    .sort((left, right) => {
      const leftDate = Date.parse(String(left.dueOn));
      const rightDate = Date.parse(String(right.dueOn));
      return leftDate - rightDate || left.number - right.number;
    })
    .map((milestone) => ({ milestone, displayTitle: milestone.title }));
}

export function resolveMilestones(
  all: RawMilestone[],
  requested: string[],
  aliases: Record<string, string> = {},
  asOf?: string,
  findings: ValidationFinding[] = [],
  openIssues: RawOpenIssue[] = [],
): RawMilestone[] {
  return resolveMilestoneSelections(all, requested, aliases, asOf, findings, openIssues).map(
    ({ milestone }) => milestone,
  );
}

export function roadmapLifecycleFindings(
  milestones: RawMilestone[],
  asOf: string,
  openIssues: RawOpenIssue[] = [],
): ValidationFinding[] {
  if (!validUtcDateTime(asOf)) throw new Error("asOf must be an ISO-8601 timestamp");
  const asOfTime = Date.parse(asOf);
  const asOfDate = new Date(asOfTime).toISOString().slice(0, 10);
  const findings: ValidationFinding[] = [];
  for (const milestone of milestones) {
    validateMilestoneLifecycle(milestone);
    if (milestone.state === "CLOSED") continue;
    const omittedOpenEpicNumbers = openIssues
      .filter((issue) => issue.issueType?.name === "Epic" && issue.milestone?.id === milestone.id)
      .map((issue) => issue.number)
      .sort((left, right) => left - right);
    const omittedEpicText =
      omittedOpenEpicNumbers.length === 0
        ? "No open native Epics were assigned to it."
        : `Omitted open native Epics: ${omittedOpenEpicNumbers.map((number) => `#${number}`).join(", ")}.`;
    if (!validUtcDateTime(milestone.dueOn)) {
      findings.push({
        code: "MILESTONE_DUE_DATE_MISSING",
        message: `Open milestone #${milestone.number} ${milestone.title} has no valid due date and was omitted. ${omittedEpicText}`,
        remediation: "Set a valid due date on or after asOf, then recollect all evidence.",
        role: "roadmap-executive",
      });
      continue;
    }
    const dueDate = milestone.dueOn.slice(0, 10);
    if (dueDate < asOfDate) {
      findings.push({
        code: "MILESTONE_PAST_DUE",
        message: `Open milestone #${milestone.number} ${milestone.title} was due ${dueDate}, before ${asOfDate}, and was omitted. ${omittedEpicText}`,
        remediation:
          "Close the milestone or move every remaining Epic to another eligible milestone, then recollect all evidence.",
        role: "roadmap-executive",
      });
    }
  }
  return findings;
}

export function unmilestonedEpicFindings(openIssues: RawOpenIssue[]): ValidationFinding[] {
  return openUnmilestonedEpicCandidates(openIssues).map((issue) => ({
    code: "EPIC_MILESTONE_MISSING",
    message: `Open native Epic #${issue.number} ${issue.title} has no milestone and requires an owner-reviewed presentation grouping before it can appear.`,
    remediation:
      "Assign the Epic to an eligible milestone and recollect, or add an owner-reviewed presentation grouping and rebuild the model.",
    role: "roadmap-executive" as const,
  }));
}

export function openUnmilestonedEpicCandidates<T extends RawOpenIssue>(openIssues: T[]): T[] {
  return openIssues.filter(
    (issue) =>
      issue.state === "OPEN" && issue.issueType?.name === "Epic" && issue.milestone === null,
  );
}

export function collectRoadmapEpicEvidence(options: {
  selectedMilestones: RawMilestone[];
  openIssues: DetailedRawOpenIssue[];
  collectMilestoneIssues: (milestone: RawMilestone) => RawIssue[];
  collectEpicEvidence: (
    issue: RawIssue | DetailedRawOpenIssue,
    nativeMilestone: RawMilestone | null,
  ) => void;
}): {
  excludedIssues: Array<Record<string, unknown>>;
  findings: ValidationFinding[];
} {
  const excludedIssues: Array<Record<string, unknown>> = [];
  const findings: ValidationFinding[] = [];
  for (const milestone of options.selectedMilestones) {
    const issues = options.collectMilestoneIssues(milestone);
    for (const issue of issues) {
      if (issue.issueType?.name !== "Epic") {
        excludedIssues.push({
          nodeId: issue.id,
          issueNumber: issue.number,
          title: issue.title,
          nativeIssueType: issue.issueType?.name ?? null,
          milestoneNodeId: milestone.id,
          reason: "native issue type is not Epic",
        });
        continue;
      }
      options.collectEpicEvidence(issue, milestone);
    }
  }

  const unmilestonedEpicCandidates = openUnmilestonedEpicCandidates(options.openIssues);
  findings.push(...unmilestonedEpicFindings(unmilestonedEpicCandidates));
  for (const issue of unmilestonedEpicCandidates) {
    if (typeof issue.body !== "string" || typeof issue.createdAt !== "string") {
      findings.push({
        code: "EPIC_RECEIPT_MISMATCH",
        message: `Open native Epic #${issue.number} lacks complete body evidence and was omitted.`,
        remediation: "Recollect the complete repository-open-issues connection.",
        role: "roadmap-executive",
      });
      continue;
    }
    options.collectEpicEvidence(issue, null);
  }
  return { excludedIssues, findings };
}

function validateMilestoneLifecycle(milestone: RawMilestone): void {
  if (milestone.state === "OPEN") {
    if (milestone.closedAt !== null) {
      throw new Error(`Open milestone ${milestone.title} unexpectedly has closedAt`);
    }
    return;
  }
  if (milestone.state !== "CLOSED" || !milestone.closedAt) {
    throw new Error(`Closed milestone ${milestone.title} has no closedAt timestamp`);
  }
  if (!validUtcDateTime(milestone.closedAt)) {
    throw new Error(`Closed milestone ${milestone.title} has an invalid closedAt timestamp`);
  }
}

function pageFrom<T>(
  data: unknown,
  selector: (value: Record<string, unknown>) => unknown,
): ConnectionPage<T> {
  const connection = selector(data as Record<string, unknown>) as ConnectionPage<T> | undefined;
  if (!connection) throw new Error("GitHub response omitted a required connection");
  return connection;
}

const REPOSITORY_QUERY = `
  query RepositoryAndMilestones($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      url
      stargazerCount
      forkCount
      defaultBranchRef { name target { ... on Commit { oid committedDate } } }
      pullRequests(states: MERGED) { totalCount }
      milestones(first: 100, after: $cursor, states: [OPEN, CLOSED]) {
        nodes { id number title description dueOn state closedAt url }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const REPOSITORY_OPEN_ISSUES_QUERY = `
  query RepositoryOpenIssues($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          id number title body state url createdAt closedAt
          issueType { id name }
          milestone { id number }
        }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const MILESTONE_ISSUES_QUERY = `
  query MilestoneIssues($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      milestone(number: $number) {
        issues(first: 100, after: $cursor, states: [OPEN, CLOSED]) {
          nodes {
            id number title body state url createdAt closedAt
            issueType { id name }
            subIssues(first: 100) {
              nodes { id number state url }
              pageInfo { hasNextPage endCursor }
              totalCount
            }
          }
          pageInfo { hasNextPage endCursor }
          totalCount
        }
      }
    }
  }
`;

const SUBISSUES_QUERY = `
  query IssueSubIssues($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        subIssues(first: 100, after: $cursor) {
          nodes { id number state url }
          pageInfo { hasNextPage endCursor }
          totalCount
        }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query TrackedIssue($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue { id number state url }
        ... on PullRequest { id number state url }
      }
    }
  }
`;

const TAGS_QUERY = `
  query TagRefs($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      refs(refPrefix: "refs/tags/", first: 100, after: $cursor) {
        nodes {
          id name
          target {
            __typename
            ... on Commit { oid committedDate url }
            ... on Tag {
              id
              tagger { date }
              target { __typename ... on Commit { oid committedDate url } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const DISCUSSION_CATEGORIES_QUERY = `
  query DiscussionCategories($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussionCategories(first: 100, after: $cursor) {
        nodes { id name slug }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const DISCUSSIONS_QUERY = `
  query Announcements($owner: String!, $name: String!, $categoryId: ID!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      discussions(first: 100, after: $cursor, categoryId: $categoryId, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { id number title body url createdAt updatedAt }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const STARGAZERS_QUERY = `
  query Stargazers($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      stargazers(first: 100, after: $cursor, orderBy: {field: STARRED_AT, direction: DESC}) {
        edges { starredAt node { id } }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const FORKS_QUERY = `
  query Forks($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      forks(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { id createdAt }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
`;

const SEARCH_QUERY = `
  query SearchWindow($query: String!, $cursor: String) {
    search(query: $query, type: ISSUE, first: 100, after: $cursor) {
      issueCount
      nodes {
        ... on Issue { id number url createdAt closedAt }
        ... on PullRequest { id number url mergedAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const FIXED_RECEIPT_QUERIES = new Map<string, string>([
  ["authenticated-viewer", "REST GET /user"],
  ["repository-milestones", REPOSITORY_QUERY],
  ["repository-summary", REPOSITORY_QUERY],
  ["repository-open-issues", REPOSITORY_OPEN_ISSUES_QUERY],
  ["work-tracking-issues", ISSUE_QUERY],
  ["tag-refs", TAGS_QUERY],
  ["tag-default-branch-ancestry", "REST compare tag...default"],
  ["discussion-categories", DISCUSSION_CATEGORIES_QUERY],
  ["announcement-discussions", DISCUSSIONS_QUERY],
  ["stargazers-window", STARGAZERS_QUERY],
  ["forks-window", FORKS_QUERY],
  ["merged-prs-window", SEARCH_QUERY],
  ["vdr-opened-window", SEARCH_QUERY],
  ["vdr-closed-window", SEARCH_QUERY],
  ["uat-opened-window", SEARCH_QUERY],
  ["uat-closed-window", SEARCH_QUERY],
]);

export function expectedReceiptQuerySha256(queryId: string): string | null {
  const fixed = FIXED_RECEIPT_QUERIES.get(queryId);
  if (fixed) return sha256Text(fixed);
  if (/^milestone-\d+-issues$/u.test(queryId)) return sha256Text(MILESTONE_ISSUES_QUERY);
  if (/^issue-\d+-subissues$/u.test(queryId)) return sha256Text(SUBISSUES_QUERY);
  return null;
}

export function expectedReceiptSourceForQuery(queryId: string): string | null {
  if (
    queryId === "authenticated-viewer" ||
    queryId === "repository-summary" ||
    queryId === "work-tracking-issues" ||
    queryId === "tag-default-branch-ancestry"
  ) {
    return "github-rest-or-single-object";
  }
  if (
    queryId === "merged-prs-window" ||
    queryId === "vdr-opened-window" ||
    queryId === "vdr-closed-window" ||
    queryId === "uat-opened-window" ||
    queryId === "uat-closed-window"
  ) {
    return "github-graphql-search";
  }
  if (
    queryId === "repository-milestones" ||
    queryId === "repository-open-issues" ||
    queryId === "tag-refs" ||
    queryId === "discussion-categories" ||
    queryId === "announcement-discussions" ||
    queryId === "stargazers-window" ||
    queryId === "forks-window" ||
    /^milestone-\d+-issues$/u.test(queryId) ||
    /^issue-\d+-subissues$/u.test(queryId)
  ) {
    return "github-graphql";
  }
  return null;
}

export function requiredReceiptQueryIds(snapshot: {
  milestones: Array<{ nodeId: string; number: number }>;
  epics: Array<{ issueNumber: number; milestoneNodeId: string | null }>;
}): string[] {
  const roadmapReceipts = snapshot.milestones.flatMap((milestone) => [
    `milestone-${milestone.number}-issues`,
    ...snapshot.epics
      .filter((epic) => epic.milestoneNodeId === milestone.nodeId)
      .map((epic) => `issue-${epic.issueNumber}-subissues`),
  ]);
  const unmilestonedEpicCandidateReceipts = snapshot.epics
    .filter((epic) => epic.milestoneNodeId === null)
    .map((epic) => `issue-${epic.issueNumber}-subissues`);
  return [
    "authenticated-viewer",
    "repository-milestones",
    "repository-summary",
    "repository-open-issues",
    ...roadmapReceipts,
    ...unmilestonedEpicCandidateReceipts,
    "work-tracking-issues",
    "tag-refs",
    "tag-default-branch-ancestry",
    "discussion-categories",
    "announcement-discussions",
    "stargazers-window",
    "forks-window",
    "merged-prs-window",
    "vdr-opened-window",
    "vdr-closed-window",
    "uat-opened-window",
    "uat-closed-window",
  ];
}

type ReceiptScopeSnapshot = {
  repository: {
    nodeId: string;
    defaultBranch: string;
    commitSha: string;
    commitDate: string;
  };
  window: { start: string; end: string };
  milestones: Array<{ nodeId: string; number: number }>;
  epics: Array<{
    issueNumber: number;
    milestoneNodeId: string | null;
  }>;
  releases: Array<{ tag: string }>;
};

function scopeRecords(
  receipts: CollectionReceipt[],
  queryId: string,
): Array<Record<string, unknown>> {
  const records = receipts.find((receipt) => receipt.queryId === queryId)?.sourceRecords;
  return Array.isArray(records)
    ? records.filter(
        (value): value is Record<string, unknown> =>
          value !== null && typeof value === "object" && !Array.isArray(value),
      )
    : [];
}

export function expectedReceiptScopeForSnapshot(
  snapshot: ReceiptScopeSnapshot,
  receipts: CollectionReceipt[],
  queryId: string,
): Record<string, unknown> | null {
  const repositoryScope = { owner: "NVIDIA", name: "NemoClaw" };
  if (queryId === "authenticated-viewer") return { restPath: "user" };
  if (
    queryId === "repository-milestones" ||
    queryId === "repository-summary" ||
    queryId === "repository-open-issues" ||
    queryId === "tag-refs" ||
    queryId === "discussion-categories"
  ) {
    return repositoryScope;
  }
  const milestoneMatch = /^milestone-(\d+)-issues$/u.exec(queryId);
  if (milestoneMatch) {
    return {
      ...repositoryScope,
      milestoneNumber: Number(milestoneMatch[1]),
    };
  }
  const issueMatch = /^issue-(\d+)-subissues$/u.exec(queryId);
  if (issueMatch) {
    return { ...repositoryScope, issueNumber: Number(issueMatch[1]) };
  }
  if (queryId === "work-tracking-issues") {
    const requests: Array<{
      parentIssueNumber: number;
      issueNumber: number;
    }> = [];
    const nativeEpicRecords = snapshot.milestones.flatMap((milestone) =>
      scopeRecords(receipts, `milestone-${milestone.number}-issues`),
    );
    const openIssueRecords = scopeRecords(receipts, "repository-open-issues");
    const unmilestonedEpicCandidateRecords = snapshot.epics
      .filter((epic) => epic.milestoneNodeId === null)
      .flatMap((epic) => openIssueRecords.filter((issue) => issue.number === epic.issueNumber));
    for (const issue of [...nativeEpicRecords, ...unmilestonedEpicCandidateRecords]) {
      if (
        (issue.issueType as Record<string, unknown> | null)?.name !== "Epic" ||
        typeof issue.body !== "string" ||
        typeof issue.number !== "number"
      ) {
        continue;
      }
      for (const number of workTrackingIssueNumbers(issue.body)) {
        requests.push({
          parentIssueNumber: issue.number,
          issueNumber: number,
        });
      }
    }
    return { ...repositoryScope, requests };
  }
  if (queryId === "tag-default-branch-ancestry") {
    try {
      const candidates = scopeRecords(receipts, "tag-refs").map((record) =>
        tagCandidate(record as RawRef),
      );
      const selected = selectStableTags(candidates, snapshot.releases.length);
      const relevant = candidates.filter(
        (tag) =>
          STABLE_TAG.test(tag.name) &&
          tag.peeled &&
          (selected.some((candidate) => candidate.name === tag.name) ||
            inHalfOpenWindow(tag.publishedAt, snapshot.window.start, snapshot.window.end)),
      );
      return {
        restPaths: relevant.map(
          (tag) =>
            `repos/NVIDIA/NemoClaw/compare/${tag.commitSha}...${snapshot.repository.commitSha}`,
        ),
      };
    } catch {
      return null;
    }
  }
  if (queryId === "announcement-discussions") {
    const categories = scopeRecords(receipts, "discussion-categories").filter(
      (record) => record.name === "Announcements",
    );
    if (categories.length !== 1 || typeof categories[0].id !== "string") {
      return null;
    }
    return { ...repositoryScope, categoryId: categories[0].id };
  }
  if (queryId === "stargazers-window" || queryId === "forks-window") {
    return { ...repositoryScope, window: snapshot.window };
  }
  const range = dateSearchRange(snapshot.window);
  const searchTextById: Record<string, string> = {
    "merged-prs-window": `repo:NVIDIA/NemoClaw is:pr is:merged merged:${range}`,
    "vdr-opened-window": `repo:NVIDIA/NemoClaw is:issue label:VDR created:${range}`,
    "vdr-closed-window": `repo:NVIDIA/NemoClaw is:issue label:VDR closed:${range}`,
    "uat-opened-window": `repo:NVIDIA/NemoClaw is:issue label:UAT created:${range}`,
    "uat-closed-window": `repo:NVIDIA/NemoClaw is:issue label:UAT closed:${range}`,
  };
  return searchTextById[queryId] ? { queryText: searchTextById[queryId] } : null;
}

function collectMilestones(
  owner: string,
  name: string,
  receipts: CollectionReceipt[],
): {
  repository: Record<string, unknown>;
  milestones: RawMilestone[];
} {
  let repository: Record<string, unknown> | null = null;
  const result = paginateConnection<RawMilestone>({
    source: "github-graphql",
    queryId: "repository-milestones",
    query: REPOSITORY_QUERY,
    scope: { owner, name },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(REPOSITORY_QUERY, {
        owner,
        name,
        cursor,
      });
      repository = data.repository;
      return pageFrom<RawMilestone>(
        data,
        (root) => (root.repository as Record<string, unknown>).milestones as unknown,
      );
    },
  });
  receipts.push(result.receipt);
  if (!repository) throw new Error("Repository not found");
  return { repository, milestones: result.nodes };
}

function collectRepositoryOpenIssues(
  owner: string,
  name: string,
  receipts: CollectionReceipt[],
): DetailedRawOpenIssue[] {
  const result = paginateConnection<DetailedRawOpenIssue>({
    source: "github-graphql",
    queryId: "repository-open-issues",
    query: REPOSITORY_OPEN_ISSUES_QUERY,
    scope: { owner, name },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(REPOSITORY_OPEN_ISSUES_QUERY, {
        owner,
        name,
        cursor,
      });
      return pageFrom<DetailedRawOpenIssue>(
        data,
        (root) => (root.repository as Record<string, unknown>).issues as unknown,
      );
    },
  });
  receipts.push(result.receipt);
  return result.nodes;
}

function collectIssueSubIssues(
  owner: string,
  name: string,
  issue: { number: number },
  receipts: CollectionReceipt[],
): Array<{ id: string; number: number; state: string; url: string }> {
  const result = paginateConnection<{
    id: string;
    number: number;
    state: string;
    url: string;
  }>({
    source: "github-graphql",
    queryId: `issue-${issue.number}-subissues`,
    query: SUBISSUES_QUERY,
    scope: { owner, name, issueNumber: issue.number },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(SUBISSUES_QUERY, {
        owner,
        name,
        number: issue.number,
        cursor,
      });
      return pageFrom(
        data,
        (root) =>
          ((root.repository as Record<string, unknown>).issue as Record<string, unknown>)
            .subIssues as unknown,
      );
    },
  });
  receipts.push(result.receipt);
  return result.nodes;
}

function collectMilestoneIssues(
  owner: string,
  name: string,
  milestone: RawMilestone,
  receipts: CollectionReceipt[],
): RawIssue[] {
  const result = paginateConnection<RawIssue>({
    source: "github-graphql",
    queryId: `milestone-${milestone.number}-issues`,
    query: MILESTONE_ISSUES_QUERY,
    scope: { owner, name, milestoneNumber: milestone.number },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(MILESTONE_ISSUES_QUERY, {
        owner,
        name,
        number: milestone.number,
        cursor,
      });
      return pageFrom(data, (root) => {
        const nativeMilestone = (root.repository as Record<string, unknown>).milestone as Record<
          string,
          unknown
        > | null;
        if (!nativeMilestone)
          throw new Error(`Milestone disappeared during collection: ${milestone.title}`);
        return nativeMilestone.issues;
      });
    },
  });
  receipts.push(result.receipt);
  return result.nodes;
}

function resolveTrackedIssues(
  owner: string,
  name: string,
  numbers: number[],
  parentIssueNumber: number,
  findings: ValidationFinding[],
): Array<{ nodeId: string; number: number; state: string; url: string }> {
  return numbers.flatMap((number) => {
    const data = graphql<{
      repository: {
        issueOrPullRequest: null | {
          __typename: string;
          id: string;
          number: number;
          state: string;
          url: string;
        };
      };
    }>(ISSUE_QUERY, { owner, name, number }, { allowNotFound: true });
    const item = data.repository.issueOrPullRequest;
    if (!item || item.__typename !== "Issue") {
      findings.push({
        code: "WORK_TRACKING_REFERENCE_INVALID",
        message: `Epic #${parentIssueNumber} references #${number}, which is not a same-repository issue.`,
        remediation:
          "Stop; have an authorized owner correct the reference through its owning GitHub workflow, then recollect all evidence.",
        role: "roadmap-executive",
      });
      return [];
    }
    return [
      {
        nodeId: item.id,
        number: item.number,
        state: item.state,
        url: item.url,
      },
    ];
  });
}

function collectTagRefs(owner: string, name: string, receipts: CollectionReceipt[]): RawRef[] {
  const result = paginateConnection<RawRef>({
    source: "github-graphql",
    queryId: "tag-refs",
    query: TAGS_QUERY,
    scope: { owner, name },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(TAGS_QUERY, {
        owner,
        name,
        cursor,
      });
      return pageFrom(data, (root) => (root.repository as Record<string, unknown>).refs);
    },
  });
  receipts.push(result.receipt);
  return result.nodes;
}

function tagCandidate(ref: RawRef): TagCandidate {
  const releaseUrl = `https://github.com/NVIDIA/NemoClaw/releases/tag/${encodeURIComponent(ref.name)}`;
  if (ref.target.__typename === "Commit") {
    return {
      name: ref.name,
      tagObjectId: ref.id,
      commitSha: ref.target.oid,
      publishedAt: ref.target.committedDate,
      commitDate: ref.target.committedDate,
      url: releaseUrl,
      peeled: true,
    };
  }
  const target = ref.target.target;
  if (target.__typename === "Commit" && "oid" in target) {
    return {
      name: ref.name,
      tagObjectId: ref.target.id,
      commitSha: target.oid,
      publishedAt: ref.target.tagger?.date ?? target.committedDate,
      commitDate: target.committedDate,
      url: releaseUrl,
      peeled: true,
    };
  }
  return {
    name: ref.name,
    tagObjectId: ref.target.id,
    commitSha: "",
    publishedAt: ref.target.tagger?.date ?? "",
    commitDate: "",
    url: releaseUrl,
    peeled: false,
  };
}

function verifyAncestor(tagCommit: string, defaultCommit: string): boolean {
  const comparison = repositoryRest<{ status?: string }>(
    `repos/NVIDIA/NemoClaw/compare/${tagCommit}...${defaultCommit}`,
  );
  return comparison.status === "ahead" || comparison.status === "identical";
}

function collectAnnouncements(
  owner: string,
  name: string,
  receipts: CollectionReceipt[],
): { categoryId: string; discussions: RawDiscussion[] } {
  const categories = paginateConnection<{
    id: string;
    name: string;
    slug: string;
  }>({
    source: "github-graphql",
    queryId: "discussion-categories",
    query: DISCUSSION_CATEGORIES_QUERY,
    scope: { owner, name },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(DISCUSSION_CATEGORIES_QUERY, {
        owner,
        name,
        cursor,
      });
      return pageFrom(
        data,
        (root) => (root.repository as Record<string, unknown>).discussionCategories,
      );
    },
  });
  receipts.push(categories.receipt);
  const matches = categories.nodes.filter((category) => category.name === "Announcements");
  if (matches.length !== 1)
    throw new Error(`Announcements category resolved to ${matches.length} matches`);
  const categoryId = matches[0].id;
  const discussions = paginateConnection<RawDiscussion>({
    source: "github-graphql",
    queryId: "announcement-discussions",
    query: DISCUSSIONS_QUERY,
    scope: { owner, name, categoryId },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(DISCUSSIONS_QUERY, {
        owner,
        name,
        categoryId,
        cursor,
      });
      return pageFrom(data, (root) => (root.repository as Record<string, unknown>).discussions);
    },
  });
  receipts.push(discussions.receipt);
  return { categoryId, discussions: discussions.nodes };
}

type SearchNode = {
  id: string;
  number: number;
  url: string;
  createdAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
};

function collectSearch(
  queryText: string,
  queryId: string,
  receipts: CollectionReceipt[],
): SearchNode[] {
  let issueCount = 0;
  const result = paginateConnection<SearchNode>({
    source: "github-graphql-search",
    queryId,
    query: SEARCH_QUERY,
    scope: { queryText },
    fetchPage: (cursor) => {
      const data = graphql<{
        search: ConnectionPage<SearchNode> & { issueCount: number };
      }>(SEARCH_QUERY, {
        query: queryText,
        cursor,
      });
      issueCount = data.search.issueCount;
      if (issueCount > 1000) {
        throw new Error(`${queryId} exceeds GitHub search's 1,000-result boundary`);
      }
      return {
        nodes: data.search.nodes,
        pageInfo: data.search.pageInfo,
        totalCount: issueCount,
      };
    },
  });
  if (result.nodes.length !== issueCount) {
    throw new Error(
      `${queryId} collected ${result.nodes.length} items but GitHub reported ${issueCount}`,
    );
  }
  receipts.push(result.receipt);
  return result.nodes;
}

function dateSearchRange(window: { start: string; end: string }): string {
  const start = window.start.slice(0, 10);
  const lastIncluded = new Date(Date.parse(window.end) - 1).toISOString().slice(0, 10);
  return `${start}..${lastIncluded}`;
}

function collectWindowMetrics(options: {
  owner: string;
  name: string;
  window: { start: string; end: string };
  repository: Record<string, unknown>;
  receipts: CollectionReceipt[];
}): Record<string, unknown> {
  const stars = paginateConnection<{ nodeId: string; starredAt: string }>({
    source: "github-graphql",
    queryId: "stargazers-window",
    query: STARGAZERS_QUERY,
    scope: { owner: options.owner, name: options.name, window: options.window },
    fetchPage: (cursor) => {
      const data = graphql<{
        repository: {
          stargazers: {
            edges: Array<{ starredAt: string; node: { id: string } }>;
            pageInfo: PageInfo;
            totalCount: number;
          };
        };
      }>(STARGAZERS_QUERY, {
        owner: options.owner,
        name: options.name,
        cursor,
      });
      return {
        nodes: data.repository.stargazers.edges.map((edge) => ({
          nodeId: edge.node.id,
          starredAt: edge.starredAt,
        })),
        pageInfo: data.repository.stargazers.pageInfo,
        totalCount: data.repository.stargazers.totalCount,
      };
    },
    stopAfterPage: (nodes) =>
      nodes.some((node) => Date.parse(node.starredAt) < Date.parse(options.window.start)),
  });
  options.receipts.push(stars.receipt);

  const forks = paginateConnection<{ id: string; createdAt: string }>({
    source: "github-graphql",
    queryId: "forks-window",
    query: FORKS_QUERY,
    scope: { owner: options.owner, name: options.name, window: options.window },
    fetchPage: (cursor) => {
      const data = graphql<{ repository: Record<string, unknown> }>(FORKS_QUERY, {
        owner: options.owner,
        name: options.name,
        cursor,
      });
      return pageFrom(data, (root) => (root.repository as Record<string, unknown>).forks);
    },
    stopAfterPage: (nodes) =>
      nodes.some((node) => Date.parse(node.createdAt) < Date.parse(options.window.start)),
  });
  options.receipts.push(forks.receipt);

  const range = dateSearchRange(options.window);
  const merged = collectSearch(
    `repo:NVIDIA/NemoClaw is:pr is:merged merged:${range}`,
    "merged-prs-window",
    options.receipts,
  ).filter(
    (item) =>
      item.mergedAt && inHalfOpenWindow(item.mergedAt, options.window.start, options.window.end),
  );
  const issueQueries = (["VDR", "UAT"] as const).flatMap((label) => [
    {
      kind: "opened" as const,
      nodes: collectSearch(
        `repo:NVIDIA/NemoClaw is:issue label:${label} created:${range}`,
        `${label.toLowerCase()}-opened-window`,
        options.receipts,
      ),
    },
    {
      kind: "closed" as const,
      nodes: collectSearch(
        `repo:NVIDIA/NemoClaw is:issue label:${label} closed:${range}`,
        `${label.toLowerCase()}-closed-window`,
        options.receipts,
      ),
    },
  ]);
  const opened = dedupeByNodeId(
    issueQueries
      .filter((entry) => entry.kind === "opened")
      .flatMap((entry) => entry.nodes)
      .filter(
        (item) =>
          item.createdAt &&
          inHalfOpenWindow(item.createdAt, options.window.start, options.window.end),
      )
      .map((item) => ({ ...item, nodeId: item.id })),
  );
  const closed = dedupeByNodeId(
    issueQueries
      .filter((entry) => entry.kind === "closed")
      .flatMap((entry) => entry.nodes)
      .filter(
        (item) =>
          item.closedAt &&
          inHalfOpenWindow(item.closedAt, options.window.start, options.window.end),
      )
      .map((item) => ({ ...item, nodeId: item.id })),
  );

  return {
    stars: {
      total: options.repository.stargazerCount,
      retainedAdditions: stars.nodes.filter((item) =>
        inHalfOpenWindow(item.starredAt, options.window.start, options.window.end),
      ).length,
    },
    forks: {
      total: options.repository.forkCount,
      retainedAdditions: forks.nodes.filter((item) =>
        inHalfOpenWindow(item.createdAt, options.window.start, options.window.end),
      ).length,
    },
    mergedPullRequests: {
      total: (options.repository.pullRequests as Record<string, unknown>).totalCount,
      inWindow: dedupeByNodeId(merged.map((item) => ({ ...item, nodeId: item.id }))).length,
    },
    validationIssues: { opened: opened.length, closed: closed.length },
  };
}

export function buildSnapshot(options: {
  repository: Record<string, unknown>;
  asOf: string;
  window: { start: string; end: string };
  milestones: unknown[];
  epics: unknown[];
  excludedIssues: unknown[];
  releases: unknown[];
  metrics: Record<string, unknown>;
  metricMode: CliOptions["metricMode"];
  receipts: CollectionReceipt[];
  findings: ValidationFinding[];
  startedAt: string;
  completedAt: string;
}): Record<string, unknown> {
  const snapshotWithoutHash = {
    schemaVersion: 1,
    repository: options.repository,
    asOf: options.asOf,
    window: options.window,
    milestones: options.milestones,
    epics: options.epics,
    excludedIssues: options.excludedIssues,
    releases: options.releases,
    metrics: { mode: options.metricMode, ...options.metrics },
    collection: {
      readOnly: true,
      complete: true,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      receipts: options.receipts,
      receiptsSha256: canonicalSha256(options.receipts),
    },
    findings: options.findings,
  };
  return {
    ...snapshotWithoutHash,
    snapshotSha256: canonicalSha256(snapshotWithoutHash),
  };
}

function addReceiptForRecords(
  receipts: CollectionReceipt[],
  queryId: string,
  query: string,
  scope: Record<string, unknown>,
  records: unknown[],
  startedAt: string,
): void {
  const querySha256 = sha256Text(query);
  receipts.push({
    source: "github-rest-or-single-object",
    queryId,
    querySha256,
    scope,
    requestSha256: receiptRequestSha256(querySha256, scope),
    pageCount: records.length === 0 ? 0 : records.length,
    itemCount: records.length,
    declaredTotalCount: records.length,
    firstCursor: null,
    finalCursor: null,
    terminalHasNextPage: false,
    termination: "exhausted",
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRecords: records,
    sourceSha256: canonicalSha256(records),
  });
}

function readAndVerifySnapshot(snapshotPath: string): Record<string, unknown> {
  const snapshot = JSON.parse(readFileSync(path.resolve(snapshotPath), "utf8")) as Record<
    string,
    unknown
  >;
  const expected = snapshot.snapshotSha256;
  const actual = canonicalSha256(withoutTopLevelKey(snapshot, "snapshotSha256"));
  if (expected !== actual) throw new Error(`Baseline snapshot hash mismatch: ${snapshotPath}`);
  return snapshot;
}

export function verifyBaselineReceiptProvenance(baseline: Record<string, unknown>): void {
  const repository = baseline.repository as Record<string, unknown> | undefined;
  if (
    baseline.schemaVersion !== 1 ||
    repository?.nameWithOwner !== "NVIDIA/NemoClaw" ||
    repository.url !== "https://github.com/NVIDIA/NemoClaw" ||
    typeof repository.commitSha !== "string"
  ) {
    throw new Error("Baseline snapshot has an invalid repository identity");
  }
  const milestones = baseline.milestones;
  const epics = baseline.epics;
  const window = baseline.window;
  const asOf = baseline.asOf;
  const collection = baseline.collection as Record<string, unknown> | undefined;
  const receipts = collection?.receipts;
  if (
    !Array.isArray(milestones) ||
    !Array.isArray(epics) ||
    !window ||
    typeof window !== "object" ||
    typeof asOf !== "string" ||
    Number.isNaN(Date.parse(asOf)) ||
    collection?.startedAt !== asOf ||
    typeof collection.completedAt !== "string" ||
    Number.isNaN(Date.parse(collection.completedAt)) ||
    Date.parse(collection.completedAt) < Date.parse(asOf) ||
    canonicalJson(window) !== canonicalJson(rollingWindow(asOf)) ||
    collection?.readOnly !== true ||
    collection.complete !== true ||
    !Array.isArray(receipts) ||
    receipts.length === 0 ||
    collection.receiptsSha256 !== canonicalSha256(receipts)
  ) {
    throw new Error("Baseline snapshot lacks complete read-only receipt provenance");
  }
  const typedBaseline = baseline as unknown as ReceiptScopeSnapshot;
  const typedReceipts = receipts as CollectionReceipt[];
  const authenticatedReceipt = typedReceipts.find(
    (receipt) => receipt.queryId === "authenticated-viewer",
  );
  if (
    authenticatedReceipt?.startedAt !== asOf ||
    canonicalJson(typedReceipts.map((receipt) => receipt.queryId)) !==
      canonicalJson(requiredReceiptQueryIds(typedBaseline))
  ) {
    throw new Error("Baseline snapshot has an incomplete receipt set");
  }
  const summaryReceipt = typedReceipts.find((receipt) => receipt.queryId === "repository-summary");
  const summaryRecords = summaryReceipt?.sourceRecords;
  const summary =
    Array.isArray(summaryRecords) && summaryRecords.length === 1
      ? (summaryRecords[0] as Record<string, unknown>)
      : null;
  const starReceipt = typedReceipts.find((receipt) => receipt.queryId === "stargazers-window");
  const forkReceipt = typedReceipts.find((receipt) => receipt.queryId === "forks-window");
  const baselineMetrics = baseline.metrics as Record<string, unknown> | undefined;
  const baselineStars = baselineMetrics?.stars as Record<string, unknown> | undefined;
  const baselineForks = baselineMetrics?.forks as Record<string, unknown> | undefined;
  if (
    !summary ||
    summary.nameWithOwner !== "NVIDIA/NemoClaw" ||
    summary.url !== "https://github.com/NVIDIA/NemoClaw" ||
    summary.nodeId !== repository.nodeId ||
    summary.defaultBranch !== repository.defaultBranch ||
    summary.commitSha !== repository.commitSha ||
    summary.commitDate !== repository.commitDate ||
    !Number.isInteger(summary.stargazerCount) ||
    !Number.isInteger(summary.forkCount) ||
    !Number.isInteger(summary.mergedPullRequestCount) ||
    summary.stargazerCount !== starReceipt?.declaredTotalCount ||
    summary.forkCount !== forkReceipt?.declaredTotalCount ||
    baselineStars?.total !== starReceipt?.declaredTotalCount ||
    baselineForks?.total !== forkReceipt?.declaredTotalCount
  ) {
    throw new Error(
      "Baseline repository identity and current totals are not bound to owning receipts",
    );
  }
  for (const receipt of typedReceipts) {
    const expectedQuerySha256 = expectedReceiptQuerySha256(receipt.queryId);
    const expectedSource = expectedReceiptSourceForQuery(receipt.queryId);
    const expectedScope = expectedReceiptScopeForSnapshot(
      typedBaseline,
      typedReceipts,
      receipt.queryId,
    );
    const traversalError = receiptTraversalError(receipt, typedBaseline.window);
    if (
      expectedQuerySha256 === null ||
      expectedSource === null ||
      receipt.source !== expectedSource ||
      receipt.querySha256 !== expectedQuerySha256 ||
      expectedScope === null ||
      canonicalJson(receipt.scope) !== canonicalJson(expectedScope) ||
      receipt.requestSha256 !== receiptRequestSha256(receipt.querySha256, receipt.scope) ||
      !Array.isArray(receipt.sourceRecords) ||
      receipt.itemCount !== receipt.sourceRecords.length ||
      receipt.sourceSha256 !== canonicalSha256(receipt.sourceRecords) ||
      !Number.isInteger(receipt.declaredTotalCount) ||
      Number(receipt.declaredTotalCount) < receipt.itemCount ||
      (receipt.termination === "exhausted" && receipt.declaredTotalCount !== receipt.itemCount) ||
      traversalError !== null ||
      Number.isNaN(Date.parse(receipt.startedAt)) ||
      Number.isNaN(Date.parse(receipt.completedAt)) ||
      Date.parse(receipt.startedAt) < Date.parse(asOf) ||
      Date.parse(receipt.completedAt) > Date.parse(collection.completedAt)
    ) {
      throw new Error(
        `Baseline receipt ${receipt.queryId} lacks complete request and source provenance`,
      );
    }
  }
  const authenticatedRecords = authenticatedReceipt?.sourceRecords;
  if (
    authenticatedReceipt?.source !== "github-rest-or-single-object" ||
    authenticatedReceipt.pageCount !== 1 ||
    authenticatedReceipt.itemCount !== 1 ||
    authenticatedReceipt.declaredTotalCount !== 1 ||
    authenticatedReceipt.firstCursor !== null ||
    authenticatedReceipt.finalCursor !== null ||
    authenticatedReceipt.terminalHasNextPage !== false ||
    authenticatedReceipt.termination !== "exhausted" ||
    !Array.isArray(authenticatedRecords) ||
    authenticatedRecords.length !== 1 ||
    canonicalJson(authenticatedRecords[0]) !== canonicalJson({ authenticated: true })
  ) {
    throw new Error(
      "Baseline authenticated-viewer receipt does not prove one authenticated viewer",
    );
  }
}

export function verifyBaselineApproval(
  approval: Record<string, unknown>,
  baseline: Record<string, unknown>,
): void {
  const exactKeys = [
    "approvalSha256",
    "approved",
    "approvedAt",
    "approvedBy",
    "kind",
    "repository",
    "schemaVersion",
    "snapshotSha256",
  ];
  if (
    canonicalJson(Object.keys(approval).sort()) !== canonicalJson(exactKeys) ||
    approval.schemaVersion !== 1 ||
    approval.kind !== "nemoclaw-product-slides-baseline-approval" ||
    approval.repository !== "NVIDIA/NemoClaw" ||
    approval.approved !== true ||
    approval.snapshotSha256 !== baseline.snapshotSha256 ||
    typeof approval.approvedBy !== "string" ||
    approval.approvedBy.trim().length === 0 ||
    typeof approval.approvedAt !== "string" ||
    Number.isNaN(Date.parse(approval.approvedAt)) ||
    approval.approvalSha256 !== canonicalSha256(withoutTopLevelKey(approval, "approvalSha256"))
  ) {
    throw new Error(
      "Baseline approval must explicitly bind an approver and timestamp to the exact snapshot",
    );
  }
  const collection = baseline.collection as Record<string, unknown> | undefined;
  if (
    typeof collection?.completedAt !== "string" ||
    Date.parse(String(approval.approvedAt)) < Date.parse(collection.completedAt)
  ) {
    throw new Error("Baseline approval must be recorded after the approved snapshot completed");
  }
}

function readAndVerifyBaselineApproval(
  approvalPath: string | undefined,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  if (!approvalPath) {
    throw new Error("net_change requires --baseline-approval");
  }
  const approval = JSON.parse(readFileSync(path.resolve(approvalPath), "utf8")) as Record<
    string,
    unknown
  >;
  verifyBaselineApproval(approval, baseline);
  return approval;
}

export function applyMetricMode(
  metrics: Record<string, unknown>,
  mode: CliOptions["metricMode"],
  baselinePath: string | undefined,
  baselineApprovalPath: string | undefined,
  windowStart: string,
): void {
  if (mode === "retained_additions") return;
  if (!baselinePath) throw new Error("net_change requires --baseline-snapshot");
  const baseline = readAndVerifySnapshot(baselinePath);
  verifyBaselineReceiptProvenance(baseline);
  const approval = readAndVerifyBaselineApproval(baselineApprovalPath, baseline);
  if (baseline.asOf !== windowStart) {
    throw new Error(`Baseline asOf must equal the window start ${windowStart}`);
  }
  const baselineMetrics = baseline.metrics as Record<string, unknown>;
  const stars = metrics.stars as Record<string, unknown>;
  const forks = metrics.forks as Record<string, unknown>;
  const oldStars = (baselineMetrics.stars as Record<string, unknown>)?.total;
  const oldForks = (baselineMetrics.forks as Record<string, unknown>)?.total;
  if (typeof oldStars !== "number" || typeof oldForks !== "number") {
    throw new Error("Baseline snapshot lacks numeric star and fork totals");
  }
  stars.netChange = Number(stars.total) - oldStars;
  forks.netChange = Number(forks.total) - oldForks;
  delete stars.retainedAdditions;
  delete forks.retainedAdditions;
  (metrics as Record<string, unknown>).baselineSnapshotSha256 = baseline.snapshotSha256;
  (metrics as Record<string, unknown>).baselineApproval = {
    approvalSha256: approval.approvalSha256,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
  };
  (metrics as Record<string, unknown>).baselineEvidence = {
    snapshot: baseline,
    approval,
  };
}

export function collectGitHubSnapshot(options: CliOptions): Record<string, unknown> {
  if (options.repo !== "NVIDIA/NemoClaw") {
    throw new Error("This collector accepts only NVIDIA/NemoClaw");
  }
  const owner = "NVIDIA";
  const name = "NemoClaw";
  const startedAt = new Date().toISOString();
  const asOf = startedAt;
  const window = rollingWindow(asOf);
  const receipts: CollectionReceipt[] = [];
  const findings: ValidationFinding[] = [];
  const viewer = repositoryRest<{ login?: string }>("user");
  if (!viewer.login) throw new Error("Authenticated GitHub viewer identity is unavailable");
  addReceiptForRecords(
    receipts,
    "authenticated-viewer",
    "REST GET /user",
    { restPath: "user" },
    [{ authenticated: true }],
    startedAt,
  );
  let aliases: Record<string, string> = {};
  if (options.presentationMap) {
    const presentation = JSON.parse(
      readFileSync(path.resolve(options.presentationMap), "utf8"),
    ) as {
      milestoneAliases?: Record<string, string>;
    };
    aliases = presentation.milestoneAliases ?? {};
  }

  const base = collectMilestones(owner, name, receipts);
  if (base.repository.nameWithOwner !== "NVIDIA/NemoClaw") {
    throw new Error("GitHub returned an unexpected repository identity");
  }
  const defaultBranchRef = base.repository.defaultBranchRef as {
    name: string;
    target: { oid: string; committedDate: string };
  } | null;
  if (!defaultBranchRef?.target?.oid) throw new Error("Repository has no default-branch commit");
  addReceiptForRecords(
    receipts,
    "repository-summary",
    REPOSITORY_QUERY,
    { owner, name },
    [
      {
        nodeId: base.repository.id,
        nameWithOwner: base.repository.nameWithOwner,
        url: base.repository.url,
        defaultBranch: defaultBranchRef.name,
        commitSha: defaultBranchRef.target.oid,
        commitDate: defaultBranchRef.target.committedDate,
        stargazerCount: base.repository.stargazerCount,
        forkCount: base.repository.forkCount,
        mergedPullRequestCount: (base.repository.pullRequests as Record<string, unknown>)
          .totalCount,
      },
    ],
    startedAt,
  );
  const openIssues = collectRepositoryOpenIssues(owner, name, receipts);
  const milestoneSelections = resolveMilestoneSelections(
    base.milestones,
    options.milestones,
    aliases,
    asOf,
    findings,
    openIssues,
  );
  const selectedMilestones = milestoneSelections.map(({ milestone }) => milestone);
  const epics: Array<Record<string, unknown>> = [];
  const excludedIssues: Array<Record<string, unknown>> = [];
  const trackedIssueRecords: Array<Record<string, unknown>> = [];
  const trackedQueryRequests: Array<{
    parentIssueNumber: number;
    issueNumber: number;
  }> = [];
  const collectEpic = (
    issue: RawIssue | DetailedRawOpenIssue,
    nativeMilestone: RawMilestone | null,
  ): void => {
    if (issue.issueType?.name !== "Epic") {
      throw new Error(`Issue #${issue.number} is not a native Epic`);
    }
    const nativeChildren = collectIssueSubIssues(owner, name, issue, receipts).map((child) => ({
      nodeId: child.id,
      issueNumber: child.number,
      state: child.state,
      url: child.url,
      sourceKind: "native-subissue",
    }));
    const trackedNumbers = workTrackingIssueNumbers(issue.body);
    for (const number of trackedNumbers) {
      trackedQueryRequests.push({
        parentIssueNumber: issue.number,
        issueNumber: number,
      });
    }
    const trackedIssues = resolveTrackedIssues(owner, name, trackedNumbers, issue.number, findings);
    const trackedChildren = trackedIssues
      .filter((child) => child.number !== issue.number)
      .map((child) => ({
        ...child,
        issueNumber: child.number,
        sourceKind: "work-tracking",
      }));
    trackedIssueRecords.push(
      ...trackedIssues.map((child) => ({
        ...child,
        issueNumber: child.number,
        sourceKind: "work-tracking",
      })),
    );
    const children = dedupeByNodeId([...nativeChildren, ...trackedChildren]);
    const outcome = extractOutcome(issue.body);
    if (!outcome) {
      findings.push({
        code: "OUTCOME_MISSING",
        message: `Epic #${issue.number} has no ## Outcome section; review its body-bound presentation summary before publication.`,
        remediation:
          "Review or add a concise ## Outcome section, then supply a body-bound presentation summary; a preview without one uses the bounded Needs summary marker.",
        role: "roadmap-executive",
      });
    }
    epics.push({
      nodeId: issue.id,
      issueNumber: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      closedAt: issue.closedAt,
      nativeIssueType: { id: issue.issueType.id, name: issue.issueType.name },
      milestoneNodeId: nativeMilestone?.id ?? null,
      ...(nativeMilestone ? { milestoneNumber: nativeMilestone.number } : {}),
      bodySha256: sha256Text(issue.body.replace(/\r\n?/gu, "\n")),
      outcome,
      children,
      progress: normalizeProgress(children),
    });
  };
  const roadmapEvidence = collectRoadmapEpicEvidence({
    selectedMilestones,
    openIssues,
    collectMilestoneIssues: (milestone) => collectMilestoneIssues(owner, name, milestone, receipts),
    collectEpicEvidence: collectEpic,
  });
  excludedIssues.push(...roadmapEvidence.excludedIssues);
  findings.push(...roadmapEvidence.findings);
  const uniqueEpicIds = new Set(epics.map((epic) => epic.nodeId));
  if (uniqueEpicIds.size !== epics.length) {
    findings.push({
      code: "EPIC_DUPLICATE",
      message: "One native Epic appeared more than once in the collected roadmap evidence.",
      remediation:
        "Stop; have an authorized owner correct the native milestone assignment through its owning GitHub workflow, then recollect all evidence.",
    });
  }
  addReceiptForRecords(
    receipts,
    "work-tracking-issues",
    ISSUE_QUERY,
    {
      owner,
      name,
      requests: trackedQueryRequests,
    },
    trackedIssueRecords,
    startedAt,
  );

  const allTagCandidates = collectTagRefs(owner, name, receipts).map(tagCandidate);
  const selectedTags = selectStableTags(allTagCandidates, options.releaseCount);
  if (selectedTags.length === 0) throw new Error("No stable release tags were found");
  const ancestryRecords: Array<Record<string, unknown>> = [];
  const relevantTags = allTagCandidates.filter(
    (tag) =>
      STABLE_TAG.test(tag.name) &&
      tag.peeled &&
      (selectedTags.some((selected) => selected.name === tag.name) ||
        inHalfOpenWindow(tag.publishedAt, window.start, window.end)),
  );
  for (const tag of relevantTags) {
    tag.defaultBranchAncestor = verifyAncestor(tag.commitSha, defaultBranchRef.target.oid);
    ancestryRecords.push({
      tag: tag.name,
      commitSha: tag.commitSha,
      ancestor: tag.defaultBranchAncestor,
    });
    if (!tag.defaultBranchAncestor) {
      findings.push({
        code: "TAG_NOT_ON_DEFAULT_BRANCH",
        message: `Stable tag ${tag.name} is not in the frozen default-branch history.`,
        remediation:
          "Stop; have an authorized release owner correct the tag through its owning release workflow, then recollect all evidence.",
        role: "weekly-release",
      });
    }
  }
  addReceiptForRecords(
    receipts,
    "tag-default-branch-ancestry",
    "REST compare tag...default",
    {
      restPaths: relevantTags.map(
        (tag) => `repos/NVIDIA/NemoClaw/compare/${tag.commitSha}...${defaultBranchRef.target.oid}`,
      ),
    },
    ancestryRecords,
    startedAt,
  );
  const releasesInWindow = relevantTags.filter(
    (tag) =>
      tag.defaultBranchAncestor && inHalfOpenWindow(tag.publishedAt, window.start, window.end),
  );
  if (releasesInWindow.length > options.releaseCount) {
    findings.push({
      code: "RELEASE_WINDOW_TRUNCATED",
      message: `${releasesInWindow.length} stable releases occurred in the window but only ${options.releaseCount} were requested.`,
      remediation: `Run collection again with --release-count ${releasesInWindow.length} or larger.`,
      role: "weekly-release",
    });
  }

  const announcements = collectAnnouncements(owner, name, receipts);
  const releases = selectedTags.map((tag) => {
    const matches = exactAnnouncementMatches(tag.name, announcements.discussions);
    if (matches.length !== 1) {
      findings.push({
        code: matches.length === 0 ? "ANNOUNCEMENT_MISSING" : "ANNOUNCEMENT_AMBIGUOUS",
        message: `${tag.name} matched ${matches.length} Discussions in the Announcements category.`,
        remediation:
          "Stop; have an authorized release owner create or correct one official Announcement through its owning GitHub workflow, then recollect all evidence.",
        role: "weekly-release",
      });
    }
    const discussion = matches.length === 1 ? matches[0] : null;
    return {
      tag: tag.name,
      tagObjectId: tag.tagObjectId,
      commitSha: tag.commitSha,
      publishedAt: tag.publishedAt,
      commitDate: tag.commitDate,
      url: tag.url,
      defaultBranchAncestor: tag.defaultBranchAncestor === true,
      inWindow: inHalfOpenWindow(tag.publishedAt, window.start, window.end),
      announcementMatchCount: matches.length,
      announcement: discussion
        ? {
            nodeId: discussion.id,
            number: discussion.number,
            url: discussion.url,
            categoryId: announcements.categoryId,
            title: discussion.title,
            createdAt: discussion.createdAt,
            updatedAt: discussion.updatedAt,
            bodySha256: sha256Text(discussion.body.replace(/\r\n?/gu, "\n")),
          }
        : null,
    };
  });

  const metrics = collectWindowMetrics({
    owner,
    name,
    window,
    repository: base.repository,
    receipts,
  });
  applyMetricMode(
    metrics,
    options.metricMode,
    options.baselineSnapshot,
    options.baselineApproval,
    window.start,
  );

  const completedAt = new Date().toISOString();
  const selectedMilestoneModels = milestoneSelections.map(({ milestone, displayTitle }) => {
    return {
      nodeId: milestone.id,
      number: milestone.number,
      title: milestone.title,
      displayTitle,
      description: milestone.description,
      dueOn: milestone.dueOn,
      state: milestone.state,
      closedAt: milestone.closedAt,
      url: milestone.url,
    };
  });
  const repository = {
    nameWithOwner: "NVIDIA/NemoClaw",
    nodeId: base.repository.id,
    url: base.repository.url,
    defaultBranch: defaultBranchRef.name,
    commitSha: defaultBranchRef.target.oid,
    commitDate: defaultBranchRef.target.committedDate,
  };
  return buildSnapshot({
    repository,
    asOf,
    window,
    milestones: selectedMilestoneModels,
    epics,
    excludedIssues,
    releases,
    metrics,
    metricMode: options.metricMode,
    receipts,
    findings,
    startedAt,
    completedAt,
  });
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repo: "NVIDIA/NemoClaw",
    milestones: [],
    releaseCount: 5,
    metricMode: "retained_additions",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    const take = (): string => {
      if (!next) throw new Error(`Missing value for ${argument}`);
      index += 1;
      return next;
    };
    if (argument === "--repo") options.repo = take();
    else if (argument === "--milestone") options.milestones.push(take());
    else if (argument === "--release-count") options.releaseCount = Number(take());
    else if (argument === "--metric-mode") {
      const mode = take();
      if (mode !== "retained_additions" && mode !== "net_change")
        throw new Error(`Invalid metric mode: ${mode}`);
      options.metricMode = mode;
    } else if (argument === "--baseline-snapshot") options.baselineSnapshot = take();
    else if (argument === "--baseline-approval") options.baselineApproval = take();
    else if (argument === "--presentation-map") options.presentationMap = take();
    else if (argument === "--output") options.output = take();
    else if (argument === "--snapshot-worker-path") options.snapshotWorkerPath = take();
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node --import tsx collect-github-snapshot.mts [--repo NVIDIA/NemoClaw] [--milestone TITLE ...] --output PATH [--release-count 5] [--metric-mode retained_additions|net_change] [--baseline-snapshot PATH --baseline-approval PATH] [--presentation-map PATH]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

type SnapshotWorkerReceipt = { complete: boolean };
export type SnapshotWorkerResult = {
  receipt?: SnapshotWorkerReceipt;
  failure?: unknown;
};
type SnapshotStagingWorkspace = {
  outputBoundary: ProtectedOutputBoundary;
  directory: string;
  directoryIdentity: { dev: bigint; ino: bigint };
  temporaryPath: string;
  temporaryIdentity?: { dev: bigint; ino: bigint };
};
type SnapshotWorkerObservation = {
  wait: Promise<SnapshotWorkerResult>;
  detach: () => void;
};
type PromiseSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

export type SnapshotCollectorRuntime = {
  outputOperations?: Partial<SnapshotOutputOperations>;
  beforePublish?: (temporaryPath: string, outputPath: string) => void;
  onWorkerSpawn?: (worker: ChildProcess) => void;
  terminateWorkerTree?: (worker: ChildProcess, signal: SnapshotSignal) => Promise<boolean>;
  treeTerminationTimeoutMilliseconds?: number;
  workerCloseTimeoutMilliseconds?: number;
};

const TREE_TERMINATION_TIMEOUT_MILLISECONDS = 4_500;
const WORKER_CLOSE_TIMEOUT_MILLISECONDS = 500;

type SnapshotPathState =
  | { kind: "present"; metadata: BigIntStats }
  | { kind: "absent" }
  | { kind: "unknown"; error: unknown };

function snapshotPathState(filePath: string): SnapshotPathState {
  try {
    return { kind: "present", metadata: lstatSync(filePath, { bigint: true }) };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unknown", error };
  }
}

function snapshotIdentity(metadata: Pick<BigIntStats, "dev" | "ino">): {
  dev: bigint;
  ino: bigint;
} {
  return { dev: metadata.dev, ino: metadata.ino };
}

function hasExactSnapshotDirectoryMode(metadata: Pick<BigIntStats, "mode">): boolean {
  return (metadata.mode & 0o7777n) === 0o700n;
}

function hasExactSnapshotFileMode(metadata: Pick<BigIntStats, "mode">): boolean {
  return (metadata.mode & 0o7777n) === 0o600n;
}

function snapshotPathStateDetail(
  label: string,
  filePath: string,
  state: SnapshotPathState,
): string {
  if (state.kind === "present") return `Preserved ${label} ${quotePath(filePath)}`;
  if (state.kind === "absent") return `${label} is absent ${quotePath(filePath)}`;
  return `${label} status is unknown for ${quotePath(filePath)}: ${errorMessage(state.error)}`;
}

function snapshotStagingWorkspaceBoundary(workspace: SnapshotStagingWorkspace): TemporaryCleanup {
  const parentFailure = protectedOutputBoundaryFailure(workspace.outputBoundary);
  if (parentFailure) {
    return {
      detail: `${parentFailure}. Preserved invocation-created staging directory ${quotePath(workspace.directory)}`,
      unresolved: true,
    };
  }
  const directoryState = snapshotPathState(workspace.directory);
  if (
    directoryState.kind !== "present" ||
    !directoryState.metadata.isDirectory() ||
    directoryState.metadata.uid !== workspace.outputBoundary.ownerUid ||
    !hasExactSnapshotDirectoryMode(directoryState.metadata) ||
    !sameFile(directoryState.metadata, workspace.directoryIdentity)
  ) {
    return {
      detail: `${snapshotPathStateDetail("Possible invocation-created staging directory", workspace.directory, directoryState)}. Snapshot staging-directory boundary is not trusted`,
      unresolved: true,
    };
  }
  return { detail: "Snapshot staging-directory boundary is trusted", unresolved: false };
}

function snapshotTemporaryIdentity(
  workspace: SnapshotStagingWorkspace,
):
  | { kind: "present"; identity: { dev: bigint; ino: bigint } }
  | { kind: "absent" }
  | { kind: "unresolved"; detail: string } {
  const temporaryState = snapshotPathState(workspace.temporaryPath);
  if (temporaryState.kind === "absent") return { kind: "absent" };
  if (
    temporaryState.kind !== "present" ||
    !temporaryState.metadata.isFile() ||
    temporaryState.metadata.uid !== workspace.outputBoundary.ownerUid ||
    !hasExactSnapshotFileMode(temporaryState.metadata)
  ) {
    return {
      kind: "unresolved",
      detail: `${snapshotPathStateDetail("Possible invocation-created temporary path", workspace.temporaryPath, temporaryState)}. Snapshot staging-file ownership is not trusted`,
    };
  }
  const identity = snapshotIdentity(temporaryState.metadata);
  if (workspace.temporaryIdentity && !sameFile(identity, workspace.temporaryIdentity)) {
    return {
      kind: "unresolved",
      detail: `Snapshot staging-file identity changed. Preserved possible invocation-created temporary path ${quotePath(workspace.temporaryPath)}`,
    };
  }
  return { kind: "present", identity };
}

function recordSnapshotTemporaryIdentity(workspace: SnapshotStagingWorkspace): void {
  const boundary = snapshotStagingWorkspaceBoundary(workspace);
  if (boundary.unresolved) throw new SnapshotPublicationBoundaryError(boundary.detail);
  const temporary = snapshotTemporaryIdentity(workspace);
  if (temporary.kind !== "present") {
    const detail =
      temporary.kind === "absent"
        ? `Invocation-created temporary path is absent ${quotePath(workspace.temporaryPath)}`
        : temporary.detail;
    throw new SnapshotPublicationBoundaryError(
      `${detail}. Preserved invocation-created staging directory ${quotePath(workspace.directory)}`,
    );
  }
  workspace.temporaryIdentity = temporary.identity;
}

function confirmSnapshotPublication(
  workspace: SnapshotStagingWorkspace,
  outputPath: string,
  operations: SnapshotOutputOperations,
): void {
  recordSnapshotTemporaryIdentity(workspace);
  const target = fileIdentity(outputPath, operations);
  if (
    target.kind !== "present" ||
    !workspace.temporaryIdentity ||
    !sameFile(target.identity, workspace.temporaryIdentity)
  ) {
    throw new SnapshotPublicationBoundaryError(
      `Snapshot link completed for ${quotePath(outputPath)}, but publication ownership could not be confirmed. ${pathStateDetail("possible snapshot target", outputPath, target)}. Preserved invocation-created staging directory ${quotePath(workspace.directory)}`,
    );
  }
}

function createSnapshotStagingWorkspace(
  outputBoundary: ProtectedOutputBoundary,
): SnapshotStagingWorkspace {
  const outputPath = outputBoundary.outputPath;
  const prefix = path.join(
    outputBoundary.outputParentPath,
    `.${path.basename(outputPath)}.nemoclaw-stage-`,
  );
  try {
    const directory = mkdtempSync(prefix);
    const directoryState = snapshotPathState(directory);
    if (
      directoryState.kind !== "present" ||
      !directoryState.metadata.isDirectory() ||
      directoryState.metadata.uid !== outputBoundary.ownerUid ||
      !hasExactSnapshotDirectoryMode(directoryState.metadata)
    ) {
      throw new SnapshotPublicationBoundaryError(
        `Snapshot staging directory could not be identified. ${snapshotPathStateDetail("Possible invocation-created staging directory", directory, directoryState)}`,
      );
    }
    const workspace = {
      outputBoundary,
      directory,
      directoryIdentity: snapshotIdentity(directoryState.metadata),
      temporaryPath: path.join(directory, "snapshot.json"),
    };
    const boundary = snapshotStagingWorkspaceBoundary(workspace);
    if (boundary.unresolved) throw new SnapshotPublicationBoundaryError(boundary.detail);
    return workspace;
  } catch (error) {
    throw new Error(
      `Could not create private snapshot staging directory from ${quotePath(prefix)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function cleanupStagingWorkspace(
  workspace: SnapshotStagingWorkspace,
  operations: SnapshotOutputOperations,
): TemporaryCleanup {
  const boundary = snapshotStagingWorkspaceBoundary(workspace);
  if (boundary.unresolved) return boundary;
  const temporary = snapshotTemporaryIdentity(workspace);
  if (temporary.kind === "unresolved") {
    return {
      detail: `${temporary.detail}. Preserved invocation-created staging directory ${quotePath(workspace.directory)}`,
      unresolved: true,
    };
  }
  let temporaryDetail = `Invocation-created temporary path is absent ${quotePath(workspace.temporaryPath)}`;
  if (temporary.kind === "present") {
    workspace.temporaryIdentity ??= temporary.identity;
    const removal = removeTemporaryPath(workspace.temporaryPath, operations);
    if (removal.unresolved) {
      return {
        detail: `${removal.detail}. Preserved invocation-created staging directory ${quotePath(workspace.directory)} because its temporary path remains unresolved`,
        unresolved: true,
      };
    }
    temporaryDetail = removal.detail;
  }
  const finalBoundary = snapshotStagingWorkspaceBoundary(workspace);
  if (finalBoundary.unresolved) return finalBoundary;
  try {
    rmdirSync(workspace.directory);
    return {
      detail: `${temporaryDetail}. Removed invocation-created staging directory ${quotePath(workspace.directory)}`,
      unresolved: false,
    };
  } catch (error) {
    return {
      detail: `${temporaryDetail}. Unresolved invocation-created staging directory ${quotePath(workspace.directory)}: ${errorMessage(error)}`,
      unresolved: true,
    };
  }
}

function stagingWorkspaceState(workspace: SnapshotStagingWorkspace): string {
  const temporary = snapshotPathState(workspace.temporaryPath);
  return `${snapshotPathStateDetail("Invocation-created temporary path", workspace.temporaryPath, temporary)}. Preserved invocation-created staging directory ${quotePath(workspace.directory)}`;
}

function cleanupWorkspaceAfterFinalization(workspace: SnapshotStagingWorkspace): TemporaryCleanup {
  const boundary = snapshotStagingWorkspaceBoundary(workspace);
  if (boundary.unresolved) return boundary;
  const temporary = snapshotPathState(workspace.temporaryPath);
  if (temporary.kind !== "absent") {
    return { detail: stagingWorkspaceState(workspace), unresolved: true };
  }
  const finalBoundary = snapshotStagingWorkspaceBoundary(workspace);
  if (finalBoundary.unresolved) return finalBoundary;
  try {
    rmdirSync(workspace.directory);
    return {
      detail: `Invocation-created temporary path is absent ${quotePath(workspace.temporaryPath)}. Removed invocation-created staging directory ${quotePath(workspace.directory)}`,
      unresolved: false,
    };
  } catch (error) {
    return {
      detail: `Invocation-created temporary path is absent ${quotePath(workspace.temporaryPath)}. Unresolved invocation-created staging directory ${quotePath(workspace.directory)}: ${errorMessage(error)}`,
      unresolved: true,
    };
  }
}

function signalSnapshotWorker(child: ChildProcess, signal: SnapshotSignal | "SIGKILL"): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The worker can exit between the signal request and process-group lookup.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The close event reconciles a worker that exited before the fallback signal.
  }
}

function observeSnapshotWorker(child: ChildProcess): SnapshotWorkerObservation {
  let stdout = "";
  let stderr = "";
  let childError: unknown;
  let detached = false;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  stdoutStream?.setEncoding("utf8");
  stderrStream?.setEncoding("utf8");
  const onStdout = (chunk: string): void => {
    stdout += chunk;
  };
  const onStderr = (chunk: string): void => {
    stderr += chunk;
  };
  let onError: (error: Error) => void;
  let onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  const removeObservationListeners = (): void => {
    stdoutStream?.off("data", onStdout);
    stderrStream?.off("data", onStderr);
    child.off("error", onError);
    child.off("close", onClose);
  };
  const wait = new Promise<SnapshotWorkerResult>((resolve) => {
    onError = (error): void => {
      childError = error;
    };
    onClose = (code, signal): void => {
      removeObservationListeners();
      if (childError) {
        resolve({ failure: childError });
        return;
      }
      if (code !== 0) {
        resolve({
          failure: new Error(
            `GitHub snapshot worker stopped before publication (exit ${String(code)}, signal ${String(signal)}). Worker diagnostic: ${JSON.stringify(stderr.trim() || "no worker diagnostic")}`,
          ),
        });
        return;
      }
      try {
        const receipt = JSON.parse(stdout) as Partial<SnapshotWorkerReceipt>;
        if (typeof receipt.complete !== "boolean") {
          throw new Error("worker receipt lacks a boolean complete field");
        }
        resolve({ receipt: { complete: receipt.complete } });
      } catch (error) {
        resolve({
          failure: new Error(
            `GitHub snapshot worker returned an invalid receipt: ${errorMessage(error)}`,
          ),
        });
      }
    };
    stdoutStream?.on("data", onStdout);
    stderrStream?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
  return {
    wait,
    detach: () => {
      if (detached) return;
      detached = true;
      removeObservationListeners();
      stdoutStream?.destroy();
      stderrStream?.destroy();
      child.on("error", () => undefined);
      child.unref();
    },
  };
}

export function waitForSnapshotWorker(child: ChildProcess): Promise<SnapshotWorkerResult> {
  return observeSnapshotWorker(child).wait;
}

function waitForPromiseSettlement<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
): Promise<PromiseSettlement<T>> {
  return new Promise((resolve) => {
    let complete = false;
    const timeout = setTimeout(() => {
      if (complete) return;
      complete = true;
      resolve({ status: "timeout" });
    }, timeoutMilliseconds);
    promise.then(
      (value) => {
        if (complete) return;
        complete = true;
        clearTimeout(timeout);
        resolve({ status: "fulfilled", value });
      },
      (reason: unknown) => {
        if (complete) return;
        complete = true;
        clearTimeout(timeout);
        resolve({ status: "rejected", reason });
      },
    );
  });
}

function processGroupIsActive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function waitForDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processGroupIsActive(processGroupId)) return true;
    await waitForDelay(25);
  }
  return !processGroupIsActive(processGroupId);
}

async function terminateSnapshotWorkerTree(
  child: ChildProcess,
  signal: SnapshotSignal,
): Promise<boolean> {
  if (process.platform === "win32") return terminateWindowsSnapshotWorkerTree(child);
  signalSnapshotWorker(child, signal);
  if (!child.pid) {
    await waitForDelay(2_000);
    signalSnapshotWorker(child, "SIGKILL");
    return false;
  }
  if (await waitForProcessGroupExit(child.pid, 2_000)) return true;
  signalSnapshotWorker(child, "SIGKILL");
  return waitForProcessGroupExit(child.pid, 2_000);
}

function terminateWindowsSnapshotWorkerTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) {
    signalSnapshotWorker(child, "SIGKILL");
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let complete = false;
    let taskkillError: unknown;
    const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (confirmed: boolean): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      taskkill.off("error", onError);
      taskkill.off("close", onClose);
      resolve(confirmed);
    };
    const onError = (error: Error): void => {
      taskkillError = error;
    };
    const onClose = (code: number | null): void => {
      finish(taskkillError === undefined && code === 0);
    };
    const timeout = setTimeout(() => {
      taskkill.on("error", () => undefined);
      taskkill.kill("SIGKILL");
      taskkill.unref();
      finish(false);
    }, 4_000);
    taskkill.once("error", onError);
    taskkill.once("close", onClose);
  });
}

function runSnapshotWorker(options: CliOptions): void {
  if (process.env.NEMOCLAW_SNAPSHOT_WORKER !== "1" || !options.snapshotWorkerPath) {
    throw new Error("The snapshot worker requires its supervised staging path");
  }
  if (!path.isAbsolute(options.snapshotWorkerPath)) {
    throw new Error("The supervised snapshot staging path must be absolute");
  }
  const stagingBoundary = prepareProtectedOutputBoundary(
    options.snapshotWorkerPath,
    "GitHub snapshot staging",
  );
  const snapshot = collectGitHubSnapshot(options);
  const boundaryFailure = protectedOutputBoundaryFailure(stagingBoundary);
  if (boundaryFailure) throw new SnapshotPublicationBoundaryError(boundaryFailure);
  const descriptor = DEFAULT_SNAPSHOT_OUTPUT_OPERATIONS.open(
    stagingBoundary.outputPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeSnapshotToDescriptor(snapshot, descriptor, DEFAULT_SNAPSHOT_OUTPUT_OPERATIONS);
  const collection = snapshot.collection as { complete: boolean };
  process.stdout.write(`${JSON.stringify({ complete: collection.complete })}\n`);
}

export async function runGitHubSnapshotCollector(
  argv: string[],
  runtime: SnapshotCollectorRuntime = {},
): Promise<void> {
  const options = parseArgs(argv);
  if (options.snapshotWorkerPath !== undefined) {
    runSnapshotWorker(options);
    return;
  }
  if (!options.output) throw new Error("--output is required");
  const outputBoundary = prepareProtectedOutputBoundary(options.output, "Snapshot");
  const outputPath = outputBoundary.outputPath;
  const outputOperations = {
    ...DEFAULT_SNAPSHOT_OUTPUT_OPERATIONS,
    ...runtime.outputOperations,
  };

  const interruption: { signal?: SnapshotSignal } = {};
  let activeWorker: ChildProcess | undefined;
  let workerObservation: SnapshotWorkerObservation | undefined;
  let shutdown: Promise<boolean> | undefined;
  let resolveInterruption: (signal: SnapshotSignal) => void = () => undefined;
  const interruptionWait = new Promise<SnapshotSignal>((resolve) => {
    resolveInterruption = resolve;
  });
  const terminateWorkerTree = runtime.terminateWorkerTree ?? terminateSnapshotWorkerTree;
  const requestInterruption = (signal: SnapshotSignal): void => {
    interruption.signal ??= signal;
    resolveInterruption(signal);
    if (!activeWorker) return;
    const worker = activeWorker;
    shutdown ??= Promise.resolve().then(() => terminateWorkerTree(worker, signal));
  };
  const handlers = new Map<SnapshotSignal, () => void>(
    (["SIGINT", "SIGTERM"] as const).map((signal) => [signal, () => requestInterruption(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);

  let workspace: SnapshotStagingWorkspace | undefined;
  let finalizationStarted = false;
  let workerTreeConfirmed = true;
  let failure: unknown;
  let receipt: SnapshotWorkerReceipt | undefined;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (interruption.signal) throw new SnapshotInterruptionError(interruption.signal, "setup");
    workspace = createSnapshotStagingWorkspace(outputBoundary);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (interruption.signal) throw new SnapshotInterruptionError(interruption.signal, "setup");

    activeWorker = spawn(
      process.execPath,
      [
        ...process.execArgv,
        path.resolve(process.argv[1]),
        ...argv,
        "--snapshot-worker-path",
        workspace.temporaryPath,
      ],
      {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: { ...process.env, NEMOCLAW_SNAPSHOT_WORKER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    workerTreeConfirmed = false;
    workerObservation = observeSnapshotWorker(activeWorker);
    runtime.onWorkerSpawn?.(activeWorker);
    const workerOutcome = await Promise.race([
      workerObservation.wait.then((result) => ({ kind: "worker" as const, result })),
      interruptionWait.then((signal) => ({ kind: "interruption" as const, signal })),
    ]);
    if (workerOutcome.kind === "interruption") {
      throw new SnapshotInterruptionError(workerOutcome.signal, "collection");
    }
    const result = workerOutcome.result;
    if (interruption.signal) throw new SnapshotInterruptionError(interruption.signal, "collection");
    if (result.failure) throw result.failure;
    if (!result.receipt) throw new Error("GitHub snapshot worker returned no receipt");
    receipt = result.receipt;
    if (
      process.platform !== "win32" &&
      activeWorker.pid &&
      processGroupIsActive(activeWorker.pid)
    ) {
      throw new Error("GitHub snapshot worker exited while its process group remained active");
    }
    workerTreeConfirmed = true;
    activeWorker = undefined;
    if (interruption.signal) throw new SnapshotInterruptionError(interruption.signal, "collection");
    recordSnapshotTemporaryIdentity(workspace);
    const completedWorkspace = workspace;

    finalizationStarted = true;
    try {
      finalizeSnapshotStage(completedWorkspace.temporaryPath, outputPath, outputOperations, {
        beforeLink: runtime.beforePublish,
        assertBoundary: () => recordSnapshotTemporaryIdentity(completedWorkspace),
        confirmPublication: () =>
          confirmSnapshotPublication(completedWorkspace, outputPath, outputOperations),
      });
    } catch (error) {
      const workspaceState = cleanupWorkspaceAfterFinalization(workspace);
      throw new Error(`${errorMessage(error)}. ${workspaceState.detail}.`, {
        cause: error,
      });
    }
    const workspaceCleanup = cleanupWorkspaceAfterFinalization(workspace);
    if (workspaceCleanup.unresolved) {
      throw new Error(
        `GitHub snapshot was published at ${quotePath(outputPath)}, but staging-directory cleanup failed. ${workspaceCleanup.detail}.`,
      );
    }
  } catch (error) {
    failure = error;
    if (activeWorker && workerObservation) {
      const worker = activeWorker;
      shutdown ??= Promise.resolve().then(() =>
        terminateWorkerTree(worker, interruption.signal ?? "SIGTERM"),
      );
      const shutdownSettlement = await waitForPromiseSettlement(
        shutdown,
        runtime.treeTerminationTimeoutMilliseconds ?? TREE_TERMINATION_TIMEOUT_MILLISECONDS,
      );
      const closeSettlement = await waitForPromiseSettlement(
        workerObservation.wait,
        runtime.workerCloseTimeoutMilliseconds ?? WORKER_CLOSE_TIMEOUT_MILLISECONDS,
      );
      workerTreeConfirmed =
        shutdownSettlement.status === "fulfilled" &&
        shutdownSettlement.value &&
        closeSettlement.status === "fulfilled";
      if (closeSettlement.status !== "fulfilled") workerObservation.detach();
      activeWorker = undefined;
    }
  }

  let cleanup: TemporaryCleanup | undefined;
  if (failure && !finalizationStarted && workspace) {
    cleanup = workerTreeConfirmed
      ? cleanupStagingWorkspace(workspace, outputOperations)
      : {
          detail: `Worker-tree termination was not confirmed. ${stagingWorkspaceState(workspace)}`,
          unresolved: true,
        };
  }
  if (interruption.signal) {
    console.error(
      `${interruption.signal} interrupted GitHub snapshot collection for ${quotePath(outputPath)}. This invocation did not publish the snapshot. ${cleanup?.detail ?? "No invocation-created temporary path was allocated"}.`,
    );
    process.exitCode = interruption.signal === "SIGINT" ? 130 : 143;
  } else if (failure) {
    console.error(
      `collect-github-snapshot: error: ${errorMessage(failure)}${cleanup ? `. ${cleanup.detail}.` : ""}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`GitHub snapshot written: ${quotePath(outputPath)}`);
    if (!receipt?.complete) process.exitCode = 1;
  }
  for (const [signal, handler] of handlers) process.off(signal, handler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runGitHubSnapshotCollector(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`collect-github-snapshot: error: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
