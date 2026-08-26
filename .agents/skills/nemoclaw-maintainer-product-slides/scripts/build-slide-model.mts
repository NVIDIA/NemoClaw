// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type DocumentationEvidence,
  isDocumentationEvidenceVerified,
  verifyDocumentationEvidence,
} from "./collect-doc-evidence.mts";
import {
  exactAnnouncementMatches,
  expectedReceiptQuerySha256,
  expectedReceiptScopeForSnapshot,
  expectedReceiptSourceForQuery,
  extractOutcome,
  inHalfOpenWindow,
  normalizeProgress,
  type RawMilestone,
  type RawOpenIssue,
  receiptRequestSha256,
  receiptTraversalError,
  requiredReceiptQueryIds,
  roadmapLifecycleFindings,
  rollingWindow,
  selectStableTags,
  unmilestonedEpicFindings,
  verifyBaselineApproval,
  verifyBaselineReceiptProvenance,
  workTrackingIssueNumbers,
} from "./collect-github-snapshot.mts";
import {
  calculateModelSha256,
  canonicalJson,
  canonicalSha256,
  ROADMAP_AREAS,
  ROADMAP_EXECUTIVE_ROW_MAX_CHARACTERS,
  roadmapPresentationWordCount,
  sha256Text,
  type ValidationFinding,
  withoutTopLevelKey,
} from "./validate-slide-model.mts";
import {
  assertProtectedOutputAbsent,
  protectedOutputDiagnostic,
  quoteProtectedOutputPath,
  writeProtectedOutput,
} from "./protected-output.mts";

type SnapshotMilestone = {
  nodeId: string;
  number: number;
  title: string;
  displayTitle?: string;
  description?: string | null;
  dueOn?: string | null;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  url: string;
};

type SnapshotChild = {
  nodeId: string;
  issueNumber: number;
  number?: number;
  state: string;
  url: string;
  sourceKind: "native-subissue" | "work-tracking";
};

type SnapshotEpic = {
  nodeId: string;
  issueNumber: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  milestoneNodeId: string | null;
  bodySha256: string;
  outcome: string | null;
  children?: SnapshotChild[];
  progress: "Unknown" | { completed: number; total: number; percentage: number };
  nativeIssueType: { id: string; name: string };
};

type SnapshotRelease = {
  tag: string;
  tagObjectId?: string;
  commitSha?: string;
  publishedAt?: string;
  commitDate?: string;
  url: string;
  inWindow: boolean;
  defaultBranchAncestor: boolean;
  announcementMatchCount: number;
  announcement: null | {
    nodeId: string;
    number?: number;
    url: string;
    categoryId?: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    bodySha256: string;
  };
};

type SourceSnapshot = {
  schemaVersion: 1;
  repository: {
    nameWithOwner: string;
    nodeId: string;
    url: string;
    defaultBranch: string;
    commitSha: string;
    commitDate: string;
  };
  asOf: string;
  window: { start: string; end: string };
  snapshotSha256: string;
  milestones: SnapshotMilestone[];
  epics: SnapshotEpic[];
  releases: SnapshotRelease[];
  metrics: Record<string, unknown> & {
    mode: "retained_additions" | "net_change";
  };
  findings: ValidationFinding[];
  collection: {
    readOnly: boolean;
    complete: boolean;
    startedAt: string;
    completedAt: string;
    receiptsSha256: string;
    receipts: Array<{
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
    }>;
  };
};

type PresentationEntry = {
  epicNodeId: string;
  issueNumber: number;
  displayTitle: string;
  roadmapArea?: string;
  displayOrder: number;
  shortenedOutcome: string;
  boundBodySha256: string;
  presentationMilestoneNodeId?: string;
};

type ResolvedPresentation = {
  displayTitle: string;
  shortenedOutcome: string;
  roadmapArea?: string;
};

type PresentationMap = {
  schemaVersion: 1;
  roadmapAreas: string[];
  milestoneAliases?: Record<string, string>;
  epics: PresentationEntry[];
};

type ClaimDefinition = {
  claimId: string;
  text: string;
  path: string;
  heading: string;
  evidenceAnchors: string[];
  platformGate?: {
    matrixSection: string;
    entryName: string;
    allowedStatuses: string[];
  };
};

type ClaimLedger = {
  schemaVersion: 1;
  claims: ClaimDefinition[];
  nodes: Array<{
    contentId: string;
    claimId: string;
    text: string;
    lane: number;
    order: number;
  }>;
  connectors: Array<{
    contentId: string;
    claimId: string;
    from: string;
    to: string;
    label: string;
    lineStyle: "solid" | "dashed";
  }>;
};

type NarrativeInput = {
  schemaVersion: 1;
  observedAt: string;
  reportSha256: string;
  milestoneRows: Array<{
    milestoneNodeId: string;
    updates: Array<{
      epicNodeId: string;
      epicBodySha256: string;
      label: string;
      text: string;
    }>;
    risks: Array<{
      label: string;
      text: string;
    }>;
  }>;
};

type SourceRecord = {
  sourceId: string;
  kind: "github" | "documentation" | "claim" | "mapping";
  digest: string;
  url?: string;
  path?: string;
  heading?: string;
  commitSha?: string;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const CANONICAL_REPOSITORY = "NVIDIA/NemoClaw";
const CANONICAL_REPOSITORY_URL = "https://github.com/NVIDIA/NemoClaw";
const MISSING_SUMMARY_TITLE = "Needs summary";
const MISSING_SUMMARY_CONTEXT = "Review the Epic body recorded in the snapshot.";

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as T;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
  return normalized || "item";
}

function blocker(
  code: string,
  message: string,
  remediation: string,
  role?: ValidationFinding["role"],
): ValidationFinding {
  return role ? { code, message, remediation, role } : { code, message, remediation };
}

function uniqueFindings(values: ValidationFinding[]): ValidationFinding[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type JsonRecord = Record<string, unknown>;
type SnapshotReceipt = SourceSnapshot["collection"]["receipts"][number];

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function hasExactFields(record: JsonRecord, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => sameJsonValue(record[key], value));
}

function hasExactKeys(record: JsonRecord, keys: string[]): boolean {
  return sameJsonValue(Object.keys(record).sort(), [...keys].sort());
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] ?? "000"}Z`;
  return new Date(parsed).toISOString() === normalized;
}

function isTimestampOrNull(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isIssueState(value: unknown): value is string {
  return value === "OPEN" || value === "CLOSED";
}

function isExactIssueRecord(record: JsonRecord): boolean {
  return (
    hasExactKeys(record, ["id", "number", "state", "url"]) &&
    isNonemptyString(record.id) &&
    isPositiveInteger(record.number) &&
    isIssueState(record.state) &&
    record.url === `${CANONICAL_REPOSITORY_URL}/issues/${record.number}`
  );
}

function isExactIssueType(value: unknown): boolean {
  if (value === null) return true;
  const record = asRecord(value);
  return Boolean(
    record &&
    hasExactKeys(record, ["id", "name"]) &&
    isNonemptyString(record.id) &&
    isNonemptyString(record.name),
  );
}

function isExactSubIssueConnection(value: unknown): boolean {
  const connection = asRecord(value);
  const pageInfo = asRecord(connection?.pageInfo);
  return Boolean(
    connection &&
    hasExactKeys(connection, ["nodes", "pageInfo", "totalCount"]) &&
    Array.isArray(connection.nodes) &&
    connection.nodes.every((node) => {
      const record = asRecord(node);
      return record !== null && isExactIssueRecord(record);
    }) &&
    isNonnegativeInteger(connection.totalCount) &&
    pageInfo &&
    hasExactKeys(pageInfo, ["endCursor", "hasNextPage"]) &&
    typeof pageInfo.hasNextPage === "boolean" &&
    (pageInfo.endCursor === null || isNonemptyString(pageInfo.endCursor)),
  );
}

function isExactTagTarget(value: unknown): boolean {
  const target = asRecord(value);
  if (!target || !isNonemptyString(target.__typename)) return false;
  if (target.__typename === "Commit") {
    return (
      hasExactKeys(target, ["__typename", "committedDate", "oid", "url"]) &&
      typeof target.oid === "string" &&
      GIT_SHA_PATTERN.test(target.oid) &&
      isTimestamp(target.committedDate) &&
      target.url === `${CANONICAL_REPOSITORY_URL}/commit/${target.oid}`
    );
  }
  if (target.__typename !== "Tag") return false;
  const tagger = target.tagger === null ? null : asRecord(target.tagger);
  const nested = asRecord(target.target);
  const validTagger =
    target.tagger === null ||
    Boolean(tagger && hasExactKeys(tagger, ["date"]) && isTimestamp(tagger.date));
  const validNested =
    nested !== null &&
    (nested.__typename === "Commit"
      ? isExactTagTarget(nested)
      : hasExactKeys(nested, ["__typename"]) && isNonemptyString(nested.__typename));
  return (
    hasExactKeys(target, ["__typename", "id", "tagger", "target"]) &&
    isNonemptyString(target.id) &&
    validTagger &&
    validNested
  );
}

function sourceRecordError(queryId: string, value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return "record is not a JSON object";
  if (queryId === "authenticated-viewer") {
    return hasExactKeys(record, ["authenticated"]) && record.authenticated === true
      ? null
      : "record is not the exact authenticated viewer evidence";
  }
  if (queryId === "repository-milestones") {
    const valid =
      hasExactKeys(record, [
        "closedAt",
        "description",
        "dueOn",
        "id",
        "number",
        "state",
        "title",
        "url",
      ]) &&
      isNonemptyString(record.id) &&
      isPositiveInteger(record.number) &&
      isNonemptyString(record.title) &&
      (record.description === null || typeof record.description === "string") &&
      isTimestampOrNull(record.dueOn) &&
      isIssueState(record.state) &&
      isTimestampOrNull(record.closedAt) &&
      ((record.state === "OPEN" && record.closedAt === null) ||
        (record.state === "CLOSED" && isTimestamp(record.closedAt))) &&
      record.url === `${CANONICAL_REPOSITORY_URL}/milestone/${record.number}`;
    return valid ? null : "record is not an exact native milestone";
  }
  if (queryId === "repository-summary") {
    const valid =
      hasExactKeys(record, [
        "commitDate",
        "commitSha",
        "defaultBranch",
        "forkCount",
        "mergedPullRequestCount",
        "nameWithOwner",
        "nodeId",
        "stargazerCount",
        "url",
      ]) &&
      isNonemptyString(record.nodeId) &&
      record.nameWithOwner === CANONICAL_REPOSITORY &&
      record.url === CANONICAL_REPOSITORY_URL &&
      isNonemptyString(record.defaultBranch) &&
      typeof record.commitSha === "string" &&
      GIT_SHA_PATTERN.test(record.commitSha) &&
      isTimestamp(record.commitDate) &&
      isNonnegativeInteger(record.stargazerCount) &&
      isNonnegativeInteger(record.forkCount) &&
      isNonnegativeInteger(record.mergedPullRequestCount);
    return valid ? null : "record is not an exact repository summary";
  }
  if (queryId === "repository-open-issues") {
    const issueType = record.issueType === null ? null : asRecord(record.issueType);
    const milestone = record.milestone === null ? null : asRecord(record.milestone);
    const validIssueType =
      issueType === null ||
      (hasExactKeys(issueType, ["id", "name"]) &&
        isNonemptyString(issueType.id) &&
        isNonemptyString(issueType.name));
    const validMilestone =
      milestone === null ||
      (hasExactKeys(milestone, ["id", "number"]) &&
        isNonemptyString(milestone.id) &&
        isPositiveInteger(milestone.number));
    const valid =
      hasExactKeys(record, [
        "body",
        "closedAt",
        "createdAt",
        "id",
        "issueType",
        "milestone",
        "number",
        "state",
        "title",
        "url",
      ]) &&
      isNonemptyString(record.id) &&
      isPositiveInteger(record.number) &&
      isNonemptyString(record.title) &&
      typeof record.body === "string" &&
      record.state === "OPEN" &&
      isTimestamp(record.createdAt) &&
      record.closedAt === null &&
      validIssueType &&
      validMilestone &&
      record.url === `${CANONICAL_REPOSITORY_URL}/issues/${record.number}`;
    return valid ? null : "record is not an exact open repository issue";
  }
  if (/^milestone-\d+-issues$/u.test(queryId)) {
    const valid =
      hasExactKeys(record, [
        "body",
        "closedAt",
        "createdAt",
        "id",
        "issueType",
        "number",
        "state",
        "subIssues",
        "title",
        "url",
      ]) &&
      isNonemptyString(record.id) &&
      isPositiveInteger(record.number) &&
      isNonemptyString(record.title) &&
      typeof record.body === "string" &&
      isIssueState(record.state) &&
      record.url === `${CANONICAL_REPOSITORY_URL}/issues/${record.number}` &&
      isTimestamp(record.createdAt) &&
      isTimestampOrNull(record.closedAt) &&
      ((record.state === "OPEN" && record.closedAt === null) ||
        (record.state === "CLOSED" && isTimestamp(record.closedAt))) &&
      isExactIssueType(record.issueType) &&
      isExactSubIssueConnection(record.subIssues);
    return valid ? null : "record is not an exact native milestone issue";
  }
  if (/^issue-\d+-subissues$/u.test(queryId)) {
    return isExactIssueRecord(record) ? null : "record is not an exact native sub-issue";
  }
  if (queryId === "work-tracking-issues") {
    const valid =
      hasExactKeys(record, ["issueNumber", "nodeId", "number", "sourceKind", "state", "url"]) &&
      isNonemptyString(record.nodeId) &&
      isPositiveInteger(record.number) &&
      record.issueNumber === record.number &&
      record.sourceKind === "work-tracking" &&
      isIssueState(record.state) &&
      record.url === `${CANONICAL_REPOSITORY_URL}/issues/${record.number}`;
    return valid ? null : "record is not an exact same-repository issue";
  }
  if (queryId === "tag-refs") {
    const valid =
      hasExactKeys(record, ["id", "name", "target"]) &&
      isNonemptyString(record.id) &&
      isNonemptyString(record.name) &&
      isExactTagTarget(record.target);
    return valid ? null : "record is not an exact native tag ref";
  }
  if (queryId === "tag-default-branch-ancestry") {
    const valid =
      hasExactKeys(record, ["ancestor", "commitSha", "tag"]) &&
      isNonemptyString(record.tag) &&
      typeof record.commitSha === "string" &&
      GIT_SHA_PATTERN.test(record.commitSha) &&
      typeof record.ancestor === "boolean";
    return valid ? null : "record is not an exact tag ancestry result";
  }
  if (queryId === "discussion-categories") {
    const valid =
      hasExactKeys(record, ["id", "name", "slug"]) &&
      isNonemptyString(record.id) &&
      isNonemptyString(record.name) &&
      isNonemptyString(record.slug);
    return valid ? null : "record is not an exact Discussion category";
  }
  if (queryId === "announcement-discussions") {
    const valid =
      hasExactKeys(record, ["body", "createdAt", "id", "number", "title", "updatedAt", "url"]) &&
      isNonemptyString(record.id) &&
      isPositiveInteger(record.number) &&
      isNonemptyString(record.title) &&
      typeof record.body === "string" &&
      record.url === `${CANONICAL_REPOSITORY_URL}/discussions/${record.number}` &&
      isTimestamp(record.createdAt) &&
      isTimestamp(record.updatedAt);
    return valid ? null : "record is not an exact Announcement Discussion";
  }
  if (queryId === "stargazers-window") {
    const valid =
      hasExactKeys(record, ["nodeId", "starredAt"]) &&
      isNonemptyString(record.nodeId) &&
      isTimestamp(record.starredAt);
    return valid ? null : "record is not an exact stargazer edge";
  }
  if (queryId === "forks-window") {
    const valid =
      hasExactKeys(record, ["createdAt", "id"]) &&
      isNonemptyString(record.id) &&
      isTimestamp(record.createdAt);
    return valid ? null : "record is not an exact fork node";
  }
  if (queryId === "merged-prs-window") {
    const valid =
      hasExactKeys(record, ["id", "mergedAt", "number", "url"]) &&
      isNonemptyString(record.id) &&
      isPositiveInteger(record.number) &&
      isTimestamp(record.mergedAt) &&
      record.url === `${CANONICAL_REPOSITORY_URL}/pull/${record.number}`;
    return valid ? null : "record is not an exact merged pull request";
  }
  if (/^(?:vdr|uat)-(?:opened|closed)-window$/u.test(queryId)) {
    const valid =
      hasExactKeys(record, ["closedAt", "createdAt", "id", "number", "url"]) &&
      isNonemptyString(record.id) &&
      isPositiveInteger(record.number) &&
      isTimestamp(record.createdAt) &&
      isTimestampOrNull(record.closedAt) &&
      record.url === `${CANONICAL_REPOSITORY_URL}/issues/${record.number}`;
    return valid ? null : "record is not an exact validation issue";
  }
  return "record belongs to an unrecognized receipt query";
}

function receiptRecords(receipts: Map<string, SnapshotReceipt>, queryId: string): JsonRecord[] {
  const records = receipts.get(queryId)?.sourceRecords;
  return Array.isArray(records)
    ? records.flatMap((value) => {
        const record = asRecord(value);
        return record ? [record] : [];
      })
    : [];
}

function sourceMismatch(
  code: string,
  message: string,
  role?: ValidationFinding["role"],
): ValidationFinding {
  return blocker(
    code,
    message,
    "Recollect the frozen GitHub snapshot so each derived record is bound to its owning receipt sourceRecords.",
    role,
  );
}

type ReceiptMetricValues = {
  stars: { total: number; retainedAdditions: number };
  forks: { total: number; retainedAdditions: number };
  mergedPullRequests: { total: number; inWindow: number };
  validationIssues: { opened: number; closed: number };
};

type BaselineEvidence = {
  snapshot: SourceSnapshot;
  approval: Record<string, unknown>;
};

function oneReceipt(receipts: Map<string, SnapshotReceipt>, queryId: string): SnapshotReceipt {
  const receipt = receipts.get(queryId);
  if (!receipt) throw new Error(`Missing metric receipt ${queryId}`);
  return receipt;
}

function exactNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return Number(value);
}

function exactReceiptRecords(
  receipt: SnapshotReceipt,
  idField: "id" | "nodeId",
  timestampField: "starredAt" | "createdAt" | "closedAt" | "mergedAt",
): Array<{ id: string; timestamp: string }> {
  return receipt.sourceRecords.map((value, index) => {
    const record = asRecord(value);
    const id = record?.[idField];
    const timestamp = record?.[timestampField];
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof timestamp !== "string" ||
      Number.isNaN(Date.parse(timestamp))
    ) {
      throw new Error(
        `${receipt.queryId} source record ${index + 1} lacks ${idField} or ${timestampField}`,
      );
    }
    return { id, timestamp };
  });
}

function uniqueInWindowCount(
  records: Array<{ id: string; timestamp: string }>,
  window: { start: string; end: string },
): number {
  return new Set(
    records
      .filter((record) => inHalfOpenWindow(record.timestamp, window.start, window.end))
      .map((record) => record.id),
  ).size;
}

function deriveReceiptMetricValues(
  snapshot: SourceSnapshot,
  receiptList: SnapshotReceipt[],
): ReceiptMetricValues {
  const receipts = new Map(receiptList.map((receipt) => [receipt.queryId, receipt] as const));
  if (receipts.size !== receiptList.length) {
    throw new Error("Metric receipts contain duplicate query IDs");
  }
  const summaryRecords = receiptRecords(receipts, "repository-summary");
  if (summaryRecords.length !== 1) {
    throw new Error("repository-summary must retain exactly one source record");
  }
  const summary = summaryRecords[0];
  if (
    !hasExactFields(summary, {
      nodeId: snapshot.repository.nodeId,
      nameWithOwner: CANONICAL_REPOSITORY,
      url: CANONICAL_REPOSITORY_URL,
      defaultBranch: snapshot.repository.defaultBranch,
      commitSha: snapshot.repository.commitSha,
      commitDate: snapshot.repository.commitDate,
    })
  ) {
    throw new Error("repository-summary does not bind the frozen repository identity");
  }

  const starReceipt = oneReceipt(receipts, "stargazers-window");
  const forkReceipt = oneReceipt(receipts, "forks-window");
  exactNonnegativeInteger(starReceipt.declaredTotalCount, "stargazers-window declaredTotalCount");
  exactNonnegativeInteger(forkReceipt.declaredTotalCount, "forks-window declaredTotalCount");
  const starsTotal = exactNonnegativeInteger(
    summary.stargazerCount,
    "repository-summary stargazerCount",
  );
  const forksTotal = exactNonnegativeInteger(summary.forkCount, "repository-summary forkCount");
  const mergedTotal = exactNonnegativeInteger(
    summary.mergedPullRequestCount,
    "repository-summary mergedPullRequestCount",
  );

  const stars = exactReceiptRecords(starReceipt, "nodeId", "starredAt");
  const forks = exactReceiptRecords(forkReceipt, "id", "createdAt");
  const merged = exactReceiptRecords(oneReceipt(receipts, "merged-prs-window"), "id", "mergedAt");
  const opened = ["vdr-opened-window", "uat-opened-window"].flatMap((queryId) =>
    exactReceiptRecords(oneReceipt(receipts, queryId), "id", "createdAt"),
  );
  const closed = ["vdr-closed-window", "uat-closed-window"].flatMap((queryId) =>
    exactReceiptRecords(oneReceipt(receipts, queryId), "id", "closedAt"),
  );

  return {
    stars: {
      total: starsTotal,
      retainedAdditions: uniqueInWindowCount(stars, snapshot.window),
    },
    forks: {
      total: forksTotal,
      retainedAdditions: uniqueInWindowCount(forks, snapshot.window),
    },
    mergedPullRequests: {
      total: mergedTotal,
      inWindow: uniqueInWindowCount(merged, snapshot.window),
    },
    validationIssues: {
      opened: uniqueInWindowCount(opened, snapshot.window),
      closed: uniqueInWindowCount(closed, snapshot.window),
    },
  };
}

function validateSnapshotTimeBinding(snapshot: SourceSnapshot): string | null {
  const { startedAt, completedAt, receipts } = snapshot.collection;
  if (
    typeof startedAt !== "string" ||
    typeof completedAt !== "string" ||
    Number.isNaN(Date.parse(startedAt)) ||
    Number.isNaN(Date.parse(completedAt)) ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    snapshot.asOf !== startedAt
  ) {
    return "asOf must equal the valid collection start timestamp";
  }
  if (!sameJsonValue(snapshot.window, rollingWindow(snapshot.asOf))) {
    return "The reporting window must be the exact half-open seven days ending at asOf";
  }
  const authenticated = receipts.find((receipt) => receipt.queryId === "authenticated-viewer");
  if (authenticated?.startedAt !== startedAt) {
    return "The authenticated collection receipt must start at asOf";
  }
  if (
    receipts.some(
      (receipt) =>
        Date.parse(receipt.startedAt) < Date.parse(startedAt) ||
        Date.parse(receipt.completedAt) > Date.parse(completedAt),
    )
  ) {
    return "Every receipt timestamp must fall within the collection interval";
  }
  return null;
}

function approvedBaselineMetricValues(
  current: SourceSnapshot,
  evidence: BaselineEvidence,
): { starsTotal: number; forksTotal: number } {
  verifyDigest(evidence.snapshot as unknown as Record<string, unknown>, "snapshotSha256");
  verifyBaselineReceiptProvenance(evidence.snapshot as unknown as Record<string, unknown>);
  verifyBaselineApproval(
    evidence.approval,
    evidence.snapshot as unknown as Record<string, unknown>,
  );
  if (
    evidence.snapshot.repository.nameWithOwner !== CANONICAL_REPOSITORY ||
    evidence.snapshot.repository.url !== CANONICAL_REPOSITORY_URL ||
    evidence.snapshot.asOf !== current.window.start ||
    validateSnapshotTimeBinding(evidence.snapshot) !== null
  ) {
    throw new Error(
      "Approved baseline repository or collection time does not match the current window start",
    );
  }
  const derived = deriveReceiptMetricValues(
    evidence.snapshot,
    evidence.snapshot.collection.receipts,
  );
  const baselineMetrics = evidence.snapshot.metrics;
  const baselineStars = asRecord(baselineMetrics.stars);
  const baselineForks = asRecord(baselineMetrics.forks);
  if (
    baselineStars?.total !== derived.stars.total ||
    baselineForks?.total !== derived.forks.total
  ) {
    throw new Error("Approved baseline totals do not derive from its owning receipts");
  }
  return { starsTotal: derived.stars.total, forksTotal: derived.forks.total };
}

function dedupeSnapshotChildren(children: SnapshotChild[]): SnapshotChild[] {
  const seen = new Set<string>();
  return children.filter((child) => {
    if (seen.has(child.nodeId)) return false;
    seen.add(child.nodeId);
    return true;
  });
}

function tagCandidateFromReceipt(record: JsonRecord): {
  name: string;
  tagObjectId: string;
  commitSha: string;
  publishedAt: string;
  commitDate: string;
  url: string;
  peeled: boolean;
} | null {
  if (typeof record.id !== "string" || typeof record.name !== "string") {
    return null;
  }
  const target = asRecord(record.target);
  if (!target || typeof target.__typename !== "string") return null;
  const url = `https://github.com/NVIDIA/NemoClaw/releases/tag/${encodeURIComponent(record.name)}`;
  if (target.__typename === "Commit") {
    if (typeof target.oid !== "string" || typeof target.committedDate !== "string") {
      return null;
    }
    return {
      name: record.name,
      tagObjectId: record.id,
      commitSha: target.oid,
      publishedAt: target.committedDate,
      commitDate: target.committedDate,
      url,
      peeled: true,
    };
  }
  if (target.__typename !== "Tag" || typeof target.id !== "string") {
    return null;
  }
  const commit = asRecord(target.target);
  const tagger = asRecord(target.tagger);
  if (
    commit?.__typename === "Commit" &&
    typeof commit.oid === "string" &&
    typeof commit.committedDate === "string"
  ) {
    return {
      name: record.name,
      tagObjectId: target.id,
      commitSha: commit.oid,
      publishedAt: typeof tagger?.date === "string" ? tagger.date : commit.committedDate,
      commitDate: commit.committedDate,
      url,
      peeled: true,
    };
  }
  return {
    name: record.name,
    tagObjectId: target.id,
    commitSha: "",
    publishedAt: typeof tagger?.date === "string" ? tagger.date : "",
    commitDate: "",
    url,
    peeled: false,
  };
}

function receiptSourceFindings(
  snapshot: SourceSnapshot,
  receiptList: SnapshotReceipt[],
  presentation: PresentationMap,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const receipts = new Map(receiptList.map((receipt) => [receipt.queryId, receipt] as const));
  const milestoneRecords = receiptRecords(receipts, "repository-milestones");
  const openIssueRecords = receiptRecords(receipts, "repository-open-issues");
  const eligibleMilestoneIds = new Set(snapshot.milestones.map((milestone) => milestone.nodeId));
  const unresolvedOpenIssueRecords = openIssueRecords.filter((record) => {
    const matchingEntries = presentation.epics.filter(
      (entry) => entry.issueNumber === record.number || entry.epicNodeId === record.id,
    );
    const entry = matchingEntries[0];
    return !(
      matchingEntries.length === 1 &&
      entry.issueNumber === record.number &&
      entry.epicNodeId === record.id &&
      entry?.presentationMilestoneNodeId &&
      eligibleMilestoneIds.has(entry.presentationMilestoneNodeId)
    );
  });
  findings.push(
    ...roadmapLifecycleFindings(
      milestoneRecords as unknown as RawMilestone[],
      snapshot.asOf,
      openIssueRecords as unknown as RawOpenIssue[],
    ),
    ...unmilestonedEpicFindings(unresolvedOpenIssueRecords as unknown as RawOpenIssue[]),
  );
  const workTrackingRecords = receiptRecords(receipts, "work-tracking-issues");
  const nativeEpicSourceRecords = snapshot.milestones.flatMap((milestone) =>
    receiptRecords(receipts, `milestone-${milestone.number}-issues`),
  );
  const unmilestonedEpicCandidateSourceRecords = snapshot.epics
    .filter((epic) => epic.milestoneNodeId === null)
    .flatMap((epic) => openIssueRecords.filter((issue) => issue.id === epic.nodeId));
  const expectedWorkTrackingRequests = [
    ...nativeEpicSourceRecords,
    ...unmilestonedEpicCandidateSourceRecords,
  ].flatMap((issue) => {
    const issueType = asRecord(issue.issueType);
    if (
      issueType?.name !== "Epic" ||
      typeof issue.number !== "number" ||
      typeof issue.body !== "string"
    ) {
      return [];
    }
    return workTrackingIssueNumbers(issue.body).map((issueNumber) => ({
      parentIssueNumber: Number(issue.number),
      issueNumber,
    }));
  });
  const workTrackingScope = asRecord(receipts.get("work-tracking-issues")?.scope);
  const declaredWorkTrackingRequests = Array.isArray(workTrackingScope?.requests)
    ? workTrackingScope.requests.flatMap((value) => {
        const request = asRecord(value);
        return request &&
          hasExactKeys(request, ["issueNumber", "parentIssueNumber"]) &&
          isPositiveInteger(request.issueNumber) &&
          isPositiveInteger(request.parentIssueNumber)
          ? [
              {
                parentIssueNumber: Number(request.parentIssueNumber),
                issueNumber: Number(request.issueNumber),
              },
            ]
          : [];
      })
    : [];
  const sourceWorkTrackingIssueNumbers = workTrackingRecords.map((record) => record.issueNumber);
  const workTrackingEvidenceComplete =
    Array.isArray(workTrackingScope?.requests) &&
    declaredWorkTrackingRequests.length === workTrackingScope.requests.length &&
    sameJsonValue(declaredWorkTrackingRequests, expectedWorkTrackingRequests) &&
    sameJsonValue(
      sourceWorkTrackingIssueNumbers,
      expectedWorkTrackingRequests.map((request) => request.issueNumber),
    );
  if (!workTrackingEvidenceComplete) {
    findings.push(
      sourceMismatch(
        "WORK_TRACKING_REFERENCE_INVALID",
        "Work Tracking requests do not each resolve exactly once, in request order, to the referenced same-repository issue.",
        "roadmap-executive",
      ),
    );
  }

  const validateEpicReceipt = (
    epic: SnapshotEpic,
    matches: JsonRecord[],
    sourceName: string,
    expectedSourceFields: Record<string, unknown> = {},
  ): void => {
    const source = matches[0];
    const issueType = source ? asRecord(source.issueType) : null;
    const body = typeof source?.body === "string" ? source.body : null;
    if (
      matches.length !== 1 ||
      !source ||
      !issueType ||
      body === null ||
      !hasExactFields(source, {
        id: epic.nodeId,
        number: epic.issueNumber,
        title: epic.title,
        url: epic.url,
        state: epic.state,
        closedAt: epic.closedAt,
        ...expectedSourceFields,
      }) ||
      !hasExactFields(issueType, epic.nativeIssueType) ||
      sha256Text(body.replace(/\r\n?/gu, "\n")) !== epic.bodySha256 ||
      extractOutcome(body) !== epic.outcome
    ) {
      findings.push(
        sourceMismatch(
          "EPIC_RECEIPT_MISMATCH",
          `Epic #${epic.issueNumber} identity, body, issue type, or Outcome differs from ${sourceName}.`,
          "roadmap-executive",
        ),
      );
      return;
    }

    const nativeChildren = receiptRecords(receipts, `issue-${epic.issueNumber}-subissues`).flatMap(
      (record): SnapshotChild[] => {
        if (
          typeof record.id !== "string" ||
          typeof record.number !== "number" ||
          typeof record.state !== "string" ||
          typeof record.url !== "string"
        ) {
          return [];
        }
        return [
          {
            nodeId: record.id,
            issueNumber: record.number,
            state: record.state,
            url: record.url,
            sourceKind: "native-subissue",
          },
        ];
      },
    );
    const trackedNumbers = workTrackingIssueNumbers(body);
    const trackedChildren = workTrackingEvidenceComplete
      ? expectedWorkTrackingRequests.flatMap((request, index): SnapshotChild[] => {
          if (
            request.parentIssueNumber !== epic.issueNumber ||
            request.issueNumber === epic.issueNumber ||
            !trackedNumbers.includes(request.issueNumber)
          ) {
            return [];
          }
          const record = workTrackingRecords[index];
          if (!record) return [];
          return [
            {
              nodeId: String(record.nodeId),
              number: Number(record.number),
              issueNumber: Number(record.issueNumber),
              state: String(record.state),
              url: String(record.url),
              sourceKind: "work-tracking",
            },
          ];
        })
      : [];
    const expectedChildren = dedupeSnapshotChildren([...nativeChildren, ...trackedChildren]);
    if (
      !Array.isArray(epic.children) ||
      !sameJsonValue(epic.children, expectedChildren) ||
      !sameJsonValue(epic.progress, normalizeProgress(expectedChildren))
    ) {
      findings.push(
        sourceMismatch(
          "EPIC_PROGRESS_RECEIPT_MISMATCH",
          `Epic #${epic.issueNumber} children or progress do not derive from its sub-issue and Work Tracking receipts.`,
          "roadmap-executive",
        ),
      );
    }
  };

  for (const milestone of snapshot.milestones) {
    const matches = milestoneRecords.filter((record) => record.id === milestone.nodeId);
    if (
      matches.length !== 1 ||
      !hasExactFields(matches[0], {
        id: milestone.nodeId,
        number: milestone.number,
        title: milestone.title,
        description: milestone.description,
        dueOn: milestone.dueOn,
        state: milestone.state,
        closedAt: milestone.closedAt,
        url: milestone.url,
      })
    ) {
      findings.push(
        sourceMismatch(
          "MILESTONE_RECEIPT_MISMATCH",
          `Milestone ${milestone.nodeId} is not represented exactly once by repository-milestones sourceRecords.`,
          "roadmap-executive",
        ),
      );
    }

    const issueRecords = receiptRecords(receipts, `milestone-${milestone.number}-issues`);
    const sourceEpicIds = issueRecords
      .filter((record) => asRecord(record.issueType)?.name === "Epic")
      .map((record) => record.id)
      .filter((value): value is string => typeof value === "string")
      .sort();
    const snapshotEpicIds = snapshot.epics
      .filter((epic) => epic.milestoneNodeId === milestone.nodeId)
      .map((epic) => epic.nodeId)
      .sort();
    if (!sameJsonValue(sourceEpicIds, snapshotEpicIds)) {
      findings.push(
        sourceMismatch(
          "EPIC_RECEIPT_MISMATCH",
          `Milestone #${milestone.number} does not derive the exact native Epic identity set retained by its issue receipt.`,
          "roadmap-executive",
        ),
      );
    }

    for (const epic of snapshot.epics.filter((epic) => epic.milestoneNodeId === milestone.nodeId)) {
      validateEpicReceipt(
        epic,
        issueRecords.filter((record) => record.id === epic.nodeId),
        `its milestone #${milestone.number} receipt`,
      );
    }
  }

  for (const epic of snapshot.epics.filter((epic) => epic.milestoneNodeId === null)) {
    validateEpicReceipt(
      epic,
      openIssueRecords.filter((record) => record.id === epic.nodeId),
      "the repository-open-issues receipt",
      { milestone: null },
    );
  }

  const tagCandidates = receiptRecords(receipts, "tag-refs").flatMap((record) => {
    const candidate = tagCandidateFromReceipt(record);
    return candidate ? [candidate] : [];
  });
  let allStableTags: typeof tagCandidates = [];
  try {
    allStableTags = selectStableTags(tagCandidates, Math.max(1, tagCandidates.length));
  } catch {
    findings.push(
      sourceMismatch(
        "TAG_RECEIPT_MISMATCH",
        "tag-refs cannot reproduce the complete stable-tag set.",
        "weekly-release",
      ),
    );
  }
  const selectedTags = allStableTags.slice(0, snapshot.releases.length);
  if (
    !sameJsonValue(
      selectedTags.map((tag) => tag.name),
      snapshot.releases.map((release) => release.tag),
    )
  ) {
    findings.push(
      sourceMismatch(
        "TAG_RECEIPT_MISMATCH",
        "The release list is not the exact ordered stable-tag selection derived from tag-refs.",
        "weekly-release",
      ),
    );
  }
  const ancestryRecords = receiptRecords(receipts, "tag-default-branch-ancestry");
  const sourceProvenWindowTags: string[] = [];
  for (const tag of allStableTags.filter((candidate) =>
    inHalfOpenWindow(candidate.publishedAt, snapshot.window.start, snapshot.window.end),
  )) {
    const matches = ancestryRecords.filter(
      (record) => record.tag === tag.name && record.commitSha === tag.commitSha,
    );
    if (matches.length !== 1) {
      findings.push(
        sourceMismatch(
          "TAG_RECEIPT_MISMATCH",
          `In-window stable tag ${tag.name} does not have exactly one default-branch ancestry result.`,
          "weekly-release",
        ),
      );
      continue;
    }
    if (matches[0].ancestor === true) sourceProvenWindowTags.push(tag.name);
  }
  const retainedReleaseTags = new Set(snapshot.releases.map((release) => release.tag));
  const omittedWindowTags = sourceProvenWindowTags.filter((tag) => !retainedReleaseTags.has(tag));
  if (omittedWindowTags.length > 0) {
    findings.push(
      sourceMismatch(
        "RELEASE_WINDOW_TRUNCATED",
        `${omittedWindowTags.length} source-proven stable ${omittedWindowTags.length === 1 ? "release is" : "releases are"} in the reporting window but absent from the retained release set: ${omittedWindowTags.join(", ")}.`,
        "weekly-release",
      ),
    );
  }
  const categoryMatches = receiptRecords(receipts, "discussion-categories").filter(
    (record) => record.name === "Announcements",
  );
  if (categoryMatches.length !== 1 || typeof categoryMatches[0].id !== "string") {
    findings.push(
      sourceMismatch(
        "ANNOUNCEMENT_RECEIPT_MISMATCH",
        "discussion-categories does not contain exactly one native Announcements category.",
        "weekly-release",
      ),
    );
  }
  const discussions = receiptRecords(receipts, "announcement-discussions").filter(
    (record): record is JsonRecord & { title: string; body: string } =>
      typeof record.title === "string" && typeof record.body === "string",
  );
  for (const release of snapshot.releases) {
    const tag = selectedTags.find((candidate) => candidate.name === release.tag);
    if (
      !tag ||
      !hasExactFields(release as unknown as JsonRecord, {
        tagObjectId: tag.tagObjectId,
        commitSha: tag.commitSha,
        publishedAt: tag.publishedAt,
        commitDate: tag.commitDate,
        url: tag.url,
        inWindow: inHalfOpenWindow(tag.publishedAt, snapshot.window.start, snapshot.window.end),
      })
    ) {
      findings.push(
        sourceMismatch(
          "TAG_RECEIPT_MISMATCH",
          `Stable tag ${release.tag} identity or window membership differs from tag-refs.`,
          "weekly-release",
        ),
      );
    }
    const ancestryMatches = ancestryRecords.filter(
      (record) => record.tag === release.tag && record.commitSha === release.commitSha,
    );
    if (
      ancestryMatches.length !== 1 ||
      ancestryMatches[0].ancestor !== release.defaultBranchAncestor
    ) {
      findings.push(
        sourceMismatch(
          "TAG_RECEIPT_MISMATCH",
          `Stable tag ${release.tag} does not have one matching default-branch ancestry receipt.`,
          "weekly-release",
        ),
      );
    }

    const announcementMatches = exactAnnouncementMatches(release.tag, discussions);
    if (release.announcementMatchCount !== announcementMatches.length) {
      findings.push(
        sourceMismatch(
          "ANNOUNCEMENT_RECEIPT_MISMATCH",
          `${release.tag} claims ${release.announcementMatchCount} exact Announcement matches, but sourceRecords contain ${announcementMatches.length}.`,
          "weekly-release",
        ),
      );
    }
    if (announcementMatches.length !== 1) {
      if (release.announcement !== null) {
        findings.push(
          sourceMismatch(
            "ANNOUNCEMENT_RECEIPT_MISMATCH",
            `${release.tag} retains an Announcement identity without exactly one source match.`,
            "weekly-release",
          ),
        );
      }
      continue;
    }
    const discussion = announcementMatches[0];
    const expectedAnnouncement = {
      nodeId: discussion.id,
      number: discussion.number,
      url: discussion.url,
      categoryId: categoryMatches[0]?.id,
      title: discussion.title,
      createdAt: discussion.createdAt,
      updatedAt: discussion.updatedAt,
      bodySha256: sha256Text(discussion.body.replace(/\r\n?/gu, "\n")),
    };
    if (
      !release.announcement ||
      !hasExactFields(release.announcement as unknown as JsonRecord, expectedAnnouncement)
    ) {
      findings.push(
        sourceMismatch(
          "ANNOUNCEMENT_RECEIPT_MISMATCH",
          `${release.tag} Announcement identity or body digest differs from the exact source match.`,
          "weekly-release",
        ),
      );
    }
  }

  return findings;
}

function verifyDigest(value: Record<string, unknown>, field: string): void {
  const expected = value[field];
  if (typeof expected !== "string" || !SHA256_PATTERN.test(expected)) {
    throw new Error(`${field} is missing or invalid`);
  }
  const actual = canonicalSha256(withoutTopLevelKey(value, field));
  if (actual !== expected) throw new Error(`${field} does not match the canonical input bytes`);
}

function sourceLine(source: SourceRecord): string {
  const location =
    source.url ?? `${source.path ?? ""}${source.heading ? `#${source.heading}` : ""}`;
  return [source.sourceId, source.kind, location, source.commitSha ?? "", source.digest].join(
    " | ",
  );
}

function managedNotes(options: {
  role: string;
  instanceId?: string;
  pageIndex?: number;
  pageCount?: number;
  modelSha256: string;
  snapshotSha256: string;
  sources: SourceRecord[];
  metadata?: string[];
  claims?: Array<{
    claimId: string;
    path: string;
    heading: string;
    commitSha: string;
    sectionSha256: string;
  }>;
}): string {
  const lines = [
    "[NEMOCLAW-MANAGED-SLIDE v1]",
    `role=${options.role}`,
    ...(options.instanceId ? [`instance_id=${options.instanceId}`] : []),
    ...(options.pageIndex && options.pageCount
      ? [`page=${options.pageIndex}/${options.pageCount}`]
      : []),
    ...(options.metadata ?? []),
    `model_sha256=${options.modelSha256}`,
    `snapshot_sha256=${options.snapshotSha256}`,
    "[Sources]",
    ...options.sources.map(sourceLine),
  ];
  if (options.claims) {
    lines.push(
      "[Claims]",
      ...options.claims.map((claim) =>
        [claim.claimId, claim.path, claim.heading, claim.commitSha, claim.sectionSha256].join(
          " | ",
        ),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function githubSource(sourceId: string, url: string, digest: string): SourceRecord {
  return { sourceId, kind: "github", url, digest };
}

function githubDiscussionNumber(url: string): number | null {
  const match = /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/discussions\/([1-9]\d*)$/u.exec(url);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

function mappingIndex(
  presentation: PresentationMap,
  blockers: ValidationFinding[],
): Map<string, PresentationEntry> {
  if (
    presentation.schemaVersion !== 1 ||
    JSON.stringify(presentation.roadmapAreas) !== JSON.stringify(ROADMAP_AREAS)
  ) {
    throw new Error("Presentation mapping must contain the approved four-row taxonomy in order");
  }
  const byNodeId = new Map<string, PresentationEntry>();
  const issueNumbers = new Set<number>();
  for (const entry of presentation.epics) {
    if (byNodeId.has(entry.epicNodeId) || issueNumbers.has(entry.issueNumber)) {
      blockers.push(
        blocker(
          "PRESENTATION_MAPPING_DUPLICATE",
          `Presentation mapping duplicates Epic ${entry.epicNodeId} or issue #${entry.issueNumber}.`,
          "Keep one row for each immutable Epic identity in the owner-only runtime presentation map, then rebuild the model.",
          "roadmap-capability",
        ),
      );
    }
    if (entry.roadmapArea !== undefined && !ROADMAP_AREAS.includes(entry.roadmapArea as never)) {
      blockers.push(
        blocker(
          "PRESENTATION_AREA_INVALID",
          `Presentation mapping uses unknown roadmap area ${entry.roadmapArea}.`,
          "Choose one of the four reviewed roadmap areas in the owner-only runtime presentation map, then rebuild the model.",
          "roadmap-capability",
        ),
      );
    }
    byNodeId.set(entry.epicNodeId, entry);
    issueNumbers.add(entry.issueNumber);
  }
  return byNodeId;
}

function uniqueSources(sources: SourceRecord[]): SourceRecord[] {
  const result = new Map<string, SourceRecord>();
  for (const source of sources) result.set(source.sourceId, source);
  return [...result.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function claimDefinition(value: ClaimDefinition): ClaimDefinition {
  return {
    claimId: value.claimId,
    text: value.text,
    path: value.path,
    heading: value.heading,
    evidenceAnchors: value.evidenceAnchors,
    ...(value.platformGate ? { platformGate: value.platformGate } : {}),
  };
}

function verifiedDocumentationClaims(
  docs: DocumentationEvidence,
  ledger: ClaimLedger,
): Map<string, DocumentationEvidence["claims"][number]> {
  if (
    docs.schemaVersion !== 1 ||
    ledger.schemaVersion !== 1 ||
    !Array.isArray(docs.sources) ||
    !Array.isArray(docs.claims) ||
    !Array.isArray(ledger.claims)
  ) {
    throw new Error("Documentation evidence and claim ledger must use schemaVersion 1");
  }

  const sourceByScope = new Map<string, DocumentationEvidence["sources"][number]>();
  for (const source of docs.sources) {
    const scope = `${source.path}\u0000${source.heading}`;
    if (
      sourceByScope.has(scope) ||
      source.sourceId !== `doc:${source.path}#${source.heading}` ||
      source.commitSha !== docs.commitSha ||
      !GIT_SHA_PATTERN.test(source.blobSha) ||
      !SHA256_PATTERN.test(source.sectionSha256)
    ) {
      throw new Error(
        `Documentation source identity is invalid for ${source.path}#${source.heading}`,
      );
    }
    sourceByScope.set(scope, source);
  }

  const expectedScopes = [
    ...new Set(ledger.claims.map((claim) => `${claim.path}\u0000${claim.heading}`)),
  ].sort();
  const actualScopes = [...sourceByScope.keys()].sort();
  if (canonicalJson(actualScopes) !== canonicalJson(expectedScopes)) {
    throw new Error("Documentation source scopes do not exactly cover the visible claim ledger");
  }

  const claimById = new Map<string, DocumentationEvidence["claims"][number]>();
  for (const claim of docs.claims) {
    if (claimById.has(claim.claimId)) {
      throw new Error(`Documentation evidence duplicates claim ${claim.claimId}`);
    }
    claimById.set(claim.claimId, claim);
  }
  if (claimById.size !== ledger.claims.length) {
    throw new Error("Documentation evidence does not exactly cover the visible claim ledger");
  }

  for (const expected of ledger.claims) {
    const actual = claimById.get(expected.claimId);
    const source = sourceByScope.get(`${expected.path}\u0000${expected.heading}`);
    if (
      !actual ||
      !source ||
      canonicalJson(claimDefinition(actual)) !== canonicalJson(claimDefinition(expected)) ||
      actual.commitSha !== docs.commitSha ||
      actual.commitSha !== source.commitSha ||
      actual.blobSha !== source.blobSha ||
      actual.sectionSha256 !== source.sectionSha256
    ) {
      throw new Error(
        `Visible claim ${expected.claimId} is not bound to the exact collected documentation source`,
      );
    }
  }
  return claimById;
}

export function conciseEvidenceText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function weeklyScorecardTitle(window: { start: string; end: string }): string {
  const start = new Date(window.start);
  const end = new Date(window.end);
  const month = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const startMonth = month.format(start);
  const endMonth = month.format(end);
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const range =
    startYear !== endYear
      ? `${startMonth} ${startDay}, ${startYear}–${endMonth} ${endDay}, ${endYear}`
      : startMonth === endMonth
        ? `${startMonth} ${startDay}–${endDay}, ${endYear}`
        : `${startMonth} ${startDay}–${endMonth} ${endDay}, ${endYear}`;
  return `NemoClaw Weekly Executive Scorecard | ${range}`;
}

function presentationSummaryIsValid(entry: PresentationEntry, completed: boolean): boolean {
  if (
    typeof entry.displayTitle !== "string" ||
    typeof entry.shortenedOutcome !== "string" ||
    conciseEvidenceText(entry.displayTitle) !== entry.displayTitle ||
    conciseEvidenceText(entry.shortenedOutcome) !== entry.shortenedOutcome ||
    entry.displayTitle.includes(":")
  ) {
    return false;
  }
  const labelWords = roadmapPresentationWordCount(entry.displayTitle);
  const contextWords = roadmapPresentationWordCount(entry.shortenedOutcome);
  return (
    labelWords >= 2 &&
    labelWords <= 4 &&
    contextWords >= 3 &&
    contextWords <= 10 &&
    `${completed ? "✓ " : ""}${entry.displayTitle}: ${entry.shortenedOutcome}`.length <=
      ROADMAP_EXECUTIVE_ROW_MAX_CHARACTERS
  );
}

function milestoneDisplayTitle(
  presentation: PresentationMap,
  milestone: SnapshotMilestone,
): string {
  const alias = Object.entries(presentation.milestoneAliases ?? {}).find(
    ([, canonical]) => canonical === milestone.title,
  )?.[0];
  return alias ?? milestone.displayTitle ?? milestone.title;
}

function milestoneFocusLabel(
  epics: SnapshotEpic[],
  presentationByEpic: Map<string, ResolvedPresentation>,
  roadmapAreas: string[],
): string {
  if (epics.length === 0) return "No Epic outcomes";
  const countByArea = new Map<string, number>();
  for (const epic of epics) {
    const area = presentationByEpic.get(epic.nodeId)?.roadmapArea;
    if (area) countByArea.set(area, (countByArea.get(area) ?? 0) + 1);
  }
  if (countByArea.size === 0) return "Needs classification";
  const areaOrder = new Map(roadmapAreas.map((area, index) => [area, index]));
  return [...countByArea].sort(
    ([leftArea, leftCount], [rightArea, rightCount]) =>
      rightCount - leftCount ||
      (areaOrder.get(leftArea) ?? Number.MAX_SAFE_INTEGER) -
        (areaOrder.get(rightArea) ?? Number.MAX_SAFE_INTEGER) ||
      (leftArea < rightArea ? -1 : leftArea > rightArea ? 1 : 0),
  )[0][0];
}

type MilestoneStatus = { state: "open"; label: "Active" };

function milestoneStatus(milestone: SnapshotMilestone, asOf: string): MilestoneStatus {
  if (milestone.state === "OPEN" && milestone.closedAt === null) {
    return { state: "open", label: "Active" };
  }
  throw new Error(`Milestone #${milestone.number} must be OPEN with a null closedAt at ${asOf}`);
}

function chunkRoadmapMilestones<T>(milestones: T[]): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < milestones.length; index += 3) {
    pages.push(milestones.slice(index, index + 3));
  }
  return pages;
}

function collectionReceiptFindings(
  snapshot: SourceSnapshot,
  receipts: SourceSnapshot["collection"]["receipts"],
  presentation: PresentationMap,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!Array.isArray(receipts) || receipts.length === 0) {
    findings.push(
      blocker(
        "COLLECTION_RECEIPTS_MISSING",
        "The GitHub source snapshot has no collection receipts.",
        "Recollect every required source connection and retain its completion receipt.",
      ),
    );
    return findings;
  }

  const receiptIds = new Set<string>();
  for (const receipt of receipts) {
    const expectedSource = expectedReceiptSourceForQuery(receipt.queryId);
    const sourceRecordErrors = Array.isArray(receipt.sourceRecords)
      ? receipt.sourceRecords.flatMap((value, index) => {
          const error = sourceRecordError(receipt.queryId, value);
          return error ? [`record ${index + 1} ${error}`] : [];
        })
      : ["sourceRecords is not an array"];
    const traversalError = receiptTraversalError(receipt, snapshot.window);
    const invalidCounts =
      !Number.isInteger(receipt.pageCount) ||
      receipt.pageCount < (expectedSource === "github-rest-or-single-object" ? 0 : 1) ||
      !Number.isInteger(receipt.itemCount) ||
      receipt.itemCount < 0 ||
      !Array.isArray(receipt.sourceRecords) ||
      receipt.itemCount !== receipt.sourceRecords.length;
    const invalidIdentity =
      !receipt.queryId ||
      receiptIds.has(receipt.queryId) ||
      expectedSource === null ||
      receipt.source !== expectedSource ||
      !SHA256_PATTERN.test(receipt.querySha256) ||
      Number.isNaN(Date.parse(receipt.startedAt)) ||
      Number.isNaN(Date.parse(receipt.completedAt)) ||
      Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt);
    const expectedQuerySha256 = expectedReceiptQuerySha256(receipt.queryId);
    const invalidQuery =
      expectedQuerySha256 === null || receipt.querySha256 !== expectedQuerySha256;
    const expectedScope = expectedReceiptScopeForSnapshot(snapshot, receipts, receipt.queryId);
    const invalidRequest =
      expectedScope === null ||
      !sameJsonValue(receipt.scope, expectedScope) ||
      typeof receipt.requestSha256 !== "string" ||
      receipt.requestSha256 !== receiptRequestSha256(receipt.querySha256, receipt.scope);
    const invalidDeclaredTotal =
      !Number.isInteger(receipt.declaredTotalCount) ||
      Number(receipt.declaredTotalCount) < receipt.itemCount ||
      (receipt.termination === "exhausted" && receipt.declaredTotalCount !== receipt.itemCount);
    const invalidSourceDigest =
      !Array.isArray(receipt.sourceRecords) ||
      canonicalSha256(receipt.sourceRecords) !== receipt.sourceSha256;
    const invalidAuthenticatedViewer =
      receipt.queryId === "authenticated-viewer" &&
      (receipt.pageCount !== 1 ||
        receipt.itemCount !== 1 ||
        receipt.declaredTotalCount !== 1 ||
        receipt.firstCursor !== null ||
        receipt.finalCursor !== null ||
        receipt.terminalHasNextPage !== false ||
        receipt.termination !== "exhausted");
    receiptIds.add(receipt.queryId);
    if (
      traversalError !== null ||
      invalidCounts ||
      invalidIdentity ||
      invalidQuery ||
      invalidRequest ||
      invalidDeclaredTotal ||
      invalidSourceDigest ||
      invalidAuthenticatedViewer ||
      sourceRecordErrors.length > 0 ||
      !SHA256_PATTERN.test(receipt.sourceSha256)
    ) {
      findings.push(
        blocker(
          "COLLECTION_RECEIPT_INCOMPLETE",
          `Collection receipt ${receipt.queryId} does not prove complete source traversal${sourceRecordErrors.length > 0 || traversalError ? `: ${[traversalError, ...sourceRecordErrors].filter(Boolean).join("; ")}` : "."}`,
          "Recollect that connection through its terminal page or an allowed time-window cutoff.",
        ),
      );
    }
  }
  const expectedReceiptIds = requiredReceiptQueryIds(snapshot);
  const actualReceiptIds = receipts.map((receipt) => receipt.queryId);
  if (
    canonicalJson(actualReceiptIds) !== canonicalJson(expectedReceiptIds) ||
    !SHA256_PATTERN.test(snapshot.collection.receiptsSha256) ||
    canonicalSha256(receipts) !== snapshot.collection.receiptsSha256
  ) {
    findings.push(
      blocker(
        "COLLECTION_RECEIPT_SET_INVALID",
        "The GitHub source snapshot does not contain the exact ordered receipt set for its eligible milestones and included Epics.",
        "Recollect the snapshot and retain every repository-owned query receipt and the ordered receipt-set digest.",
      ),
    );
  }
  findings.push(...receiptSourceFindings(snapshot, receipts, presentation));
  return findings;
}

export function buildSlideModel(options: {
  snapshot: SourceSnapshot;
  docs: DocumentationEvidence;
  presentation: PresentationMap;
  claims: ClaimLedger;
  narrative: NarrativeInput;
  templateFingerprint: string;
}): Record<string, unknown> {
  if (!isDocumentationEvidenceVerified(options.docs)) {
    throw new Error(
      "Documentation evidence must be verified from immutable official Git objects before model construction",
    );
  }
  verifyDigest(options.snapshot as unknown as Record<string, unknown>, "snapshotSha256");
  verifyDigest(options.docs as unknown as Record<string, unknown>, "evidenceSha256");
  if (!SHA256_PATTERN.test(options.templateFingerprint)) {
    throw new Error("templateFingerprint must be a canonical SHA-256");
  }
  if (options.snapshot.repository.nameWithOwner !== "NVIDIA/NemoClaw") {
    throw new Error("Snapshot repository must be NVIDIA/NemoClaw");
  }
  if (options.docs.commitSha !== options.snapshot.repository.commitSha) {
    throw new Error("Documentation and GitHub evidence must bind to the same commit");
  }
  if (
    options.docs.repository !== "NVIDIA/NemoClaw" ||
    !GIT_SHA_PATTERN.test(options.docs.commitSha) ||
    Number.isNaN(Date.parse(options.docs.collectedAt))
  ) {
    throw new Error("Documentation evidence has an invalid repository, commit, or timestamp");
  }
  if (
    options.narrative.schemaVersion !== 1 ||
    Number.isNaN(Date.parse(options.narrative.observedAt)) ||
    !Array.isArray(options.narrative.milestoneRows) ||
    JSON.stringify(Object.keys(options.narrative).sort()) !==
      JSON.stringify(["milestoneRows", "observedAt", "reportSha256", "schemaVersion"])
  ) {
    throw new Error(
      "Narrative input must contain only schemaVersion 1, observedAt, reportSha256, and milestoneRows",
    );
  }
  verifyDigest(options.narrative as unknown as Record<string, unknown>, "reportSha256");
  const docsByClaim = verifiedDocumentationClaims(options.docs, options.claims);

  const blockers: ValidationFinding[] = [];
  const findings: ValidationFinding[] = [];
  if (!options.snapshot.collection.complete) {
    blockers.push(
      blocker(
        "SNAPSHOT_INCOMPLETE",
        "The GitHub source snapshot is incomplete.",
        "Resolve every collection finding and recollect the snapshot.",
      ),
    );
  }
  if (options.snapshot.collection.readOnly !== true) {
    blockers.push(
      blocker(
        "SNAPSHOT_NOT_READ_ONLY",
        "The GitHub source snapshot does not prove read-only collection.",
        "Recollect the snapshot with authenticated read-only GitHub operations.",
      ),
    );
  }
  if (
    options.snapshot.repository.url !== CANONICAL_REPOSITORY_URL ||
    !GIT_SHA_PATTERN.test(options.snapshot.repository.commitSha) ||
    typeof options.snapshot.repository.nodeId !== "string" ||
    options.snapshot.repository.nodeId.length === 0 ||
    typeof options.snapshot.repository.defaultBranch !== "string" ||
    options.snapshot.repository.defaultBranch.length === 0 ||
    Number.isNaN(Date.parse(options.snapshot.repository.commitDate))
  ) {
    blockers.push(
      blocker(
        "REPOSITORY_IDENTITY_UNBOUND",
        "The snapshot repository URL or frozen default-branch identity is not canonical.",
        "Recollect NVIDIA/NemoClaw and retain the exact repository-summary source record.",
      ),
    );
  }
  const timeBindingError = validateSnapshotTimeBinding(options.snapshot);
  const boundAsOf =
    typeof options.snapshot.collection.startedAt === "string" &&
    !Number.isNaN(Date.parse(options.snapshot.collection.startedAt))
      ? options.snapshot.collection.startedAt
      : options.snapshot.asOf;
  const boundWindow = rollingWindow(boundAsOf);
  if (timeBindingError) {
    blockers.push(
      blocker(
        "SNAPSHOT_TIME_UNBOUND",
        timeBindingError,
        "Recollect once and retain asOf, the exact seven-day window, collection timestamps, and receipt timestamps from that run.",
        "weekly-release",
      ),
    );
  }
  const receipts = options.snapshot.collection.receipts;
  blockers.push(...collectionReceiptFindings(options.snapshot, receipts, options.presentation));
  for (const sourceFinding of options.snapshot.findings) {
    if (sourceFinding.code === "EPIC_MILESTONE_MISSING") {
      const issueNumberMatch = /#([1-9]\d*)/u.exec(sourceFinding.message);
      const issueNumber = issueNumberMatch ? Number(issueNumberMatch[1]) : null;
      const unmilestonedEpic = options.snapshot.epics.find(
        (epic) => epic.issueNumber === issueNumber && epic.milestoneNodeId === null,
      );
      const presentationEntry = options.presentation.epics.find(
        (entry) =>
          entry.issueNumber === issueNumber && entry.epicNodeId === unmilestonedEpic?.nodeId,
      );
      if (
        unmilestonedEpic?.state === "OPEN" &&
        presentationEntry?.presentationMilestoneNodeId &&
        options.snapshot.milestones.some(
          (milestone) => milestone.nodeId === presentationEntry.presentationMilestoneNodeId,
        )
      ) {
        continue;
      }
    }
    if (sourceFinding.code === "OUTCOME_MISSING") findings.push(sourceFinding);
    else blockers.push(sourceFinding);
  }
  if (!options.docs.complete) {
    blockers.push(
      blocker(
        "DOCUMENTATION_EVIDENCE_INCOMPLETE",
        "The documentation evidence set is incomplete.",
        "Resolve the documentation or platform-matrix conflict and recollect evidence.",
        "markitecture",
      ),
    );
  }
  blockers.push(...options.docs.findings);
  if (options.snapshot.milestones.length === 0) {
    blockers.push(
      blocker(
        "MILESTONE_SELECTION_EMPTY",
        "The source snapshot contains no eligible milestone.",
        "Select at least one open milestone with a valid due date on or after asOf, then recollect the snapshot.",
        "roadmap-executive",
      ),
    );
  }
  const asOfDate = new Date(Date.parse(boundAsOf)).toISOString().slice(0, 10);
  for (const milestone of options.snapshot.milestones) {
    const dueDate = isTimestamp(milestone.dueOn) ? milestone.dueOn.slice(0, 10) : null;
    if (milestone.state !== "OPEN" || milestone.closedAt !== null) {
      blockers.push(
        blocker(
          "MILESTONE_SELECTION_INELIGIBLE",
          `Selected milestone #${milestone.number} is not open and was not eligible for the roadmap.`,
          "Recollect with only eligible open milestone windows.",
          "roadmap-executive",
        ),
      );
    } else if (dueDate === null) {
      blockers.push(
        blocker(
          "MILESTONE_DUE_DATE_MISSING",
          `Selected open milestone #${milestone.number} has no valid due date.`,
          "Set a valid due date on or after asOf, then recollect all evidence.",
          "roadmap-executive",
        ),
      );
    } else if (dueDate < asOfDate) {
      blockers.push(
        blocker(
          "MILESTONE_PAST_DUE",
          `Selected open milestone #${milestone.number} was due ${dueDate}, before ${asOfDate}.`,
          "Close the milestone or move every remaining Epic to another eligible milestone, then recollect all evidence.",
          "roadmap-executive",
        ),
      );
    }
  }
  const milestoneIds = new Set(options.snapshot.milestones.map((milestone) => milestone.nodeId));
  const presentationByEpic = mappingIndex(options.presentation, blockers);
  for (const entry of options.presentation.epics) {
    if (
      entry.presentationMilestoneNodeId !== undefined &&
      !milestoneIds.has(entry.presentationMilestoneNodeId)
    ) {
      blockers.push(
        blocker(
          "PRESENTATION_MILESTONE_UNKNOWN",
          `Presentation mapping for Epic #${entry.issueNumber} targets unknown milestone ${entry.presentationMilestoneNodeId}.`,
          "Use one eligible milestone node ID from the frozen snapshot or remove the display assignment.",
          "roadmap-executive",
        ),
      );
    }
  }
  if (milestoneIds.size !== options.snapshot.milestones.length) {
    blockers.push(
      blocker(
        "MILESTONE_DUPLICATE",
        "The source snapshot contains a duplicate eligible milestone.",
        "Recollect the explicitly ordered milestone selection without duplicate native identities.",
      ),
    );
  }
  const epicNodeIds = new Set<string>();
  const epicNumbers = new Set<number>();
  const displayMilestoneByEpic = new Map<string, string>();
  for (const epic of options.snapshot.epics) {
    if (epicNodeIds.has(epic.nodeId) || epicNumbers.has(epic.issueNumber)) {
      blockers.push(
        blocker(
          "EPIC_DUPLICATE",
          `The source snapshot duplicates Epic ${epic.nodeId} or issue #${epic.issueNumber}.`,
          "Recollect unique native Epic identities from the eligible milestones.",
          "roadmap-executive",
        ),
      );
    }
    epicNodeIds.add(epic.nodeId);
    epicNumbers.add(epic.issueNumber);
    const epicLifecycleValid =
      (epic.state === "OPEN" && epic.closedAt === null) ||
      (epic.state === "CLOSED" && isTimestamp(epic.closedAt));
    if (!epicLifecycleValid) {
      blockers.push(
        blocker(
          "EPIC_LIFECYCLE_INVALID",
          `Epic #${epic.issueNumber} does not carry lifecycle evidence consistent with its state.`,
          "Recollect the exact Epic state and closedAt timestamp from GitHub.",
          "roadmap-executive",
        ),
      );
    }
    if (epic.nativeIssueType?.name !== "Epic" || !epic.nativeIssueType.id) {
      blockers.push(
        blocker(
          "NATIVE_ISSUE_TYPE_INVALID",
          `Issue #${epic.issueNumber} is not bound to an exact native Epic issue type.`,
          "Stop; have an authorized owner restore the native Epic issue type through its owning GitHub workflow, then recollect all evidence.",
          "roadmap-executive",
        ),
      );
    }
    const presentationEntry = presentationByEpic.get(epic.nodeId);
    if (epic.milestoneNodeId !== null && milestoneIds.has(epic.milestoneNodeId)) {
      displayMilestoneByEpic.set(epic.nodeId, epic.milestoneNodeId);
    } else if (
      epic.milestoneNodeId === null &&
      epic.state === "OPEN" &&
      presentationEntry?.presentationMilestoneNodeId &&
      milestoneIds.has(presentationEntry.presentationMilestoneNodeId)
    ) {
      displayMilestoneByEpic.set(epic.nodeId, presentationEntry.presentationMilestoneNodeId);
    } else if (epic.milestoneNodeId !== null || epic.state !== "OPEN") {
      blockers.push(
        blocker(
          "EPIC_MILESTONE_UNRESOLVED",
          `Epic #${epic.issueNumber} has neither an eligible native milestone nor a valid presentation milestone assignment.`,
          "Assign the open Epic to an eligible native milestone, or map an unmilestoned Epic to one selected milestone node ID.",
          "roadmap-executive",
        ),
      );
    }
  }

  const selectedEpics = options.snapshot.epics.filter((epic) =>
    displayMilestoneByEpic.has(epic.nodeId),
  );
  const collectedEpicKeys = new Set(
    options.snapshot.epics.map((epic) => `${epic.nodeId}\u0000${epic.issueNumber}`),
  );
  for (const entry of options.presentation.epics) {
    if (!collectedEpicKeys.has(`${entry.epicNodeId}\u0000${entry.issueNumber}`)) {
      blockers.push(
        blocker(
          "PRESENTATION_MAPPING_UNSELECTED_EPIC",
          `Presentation mapping row ${entry.epicNodeId} / #${entry.issueNumber} is not one of the included native Epics.`,
          "Remove the unselected row from the owner-only runtime presentation map, then rebuild the model.",
          "roadmap-capability",
        ),
      );
    }
  }
  const orderedEpics = [...selectedEpics].sort((left, right) => {
    const leftOrder = presentationByEpic.get(left.nodeId)?.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder =
      presentationByEpic.get(right.nodeId)?.displayOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.issueNumber - right.issueNumber;
  });
  const resolvedPresentationByEpic = new Map<string, ResolvedPresentation>();
  const unclassified: Array<Record<string, unknown>> = [];
  for (const epic of orderedEpics) {
    const entry = presentationByEpic.get(epic.nodeId);
    if (!entry) {
      blockers.push(
        blocker(
          "EPIC_PRESENTATION_SUMMARY_MISSING",
          `Epic #${epic.issueNumber} has no reviewed short label and context.`,
          "Add a two-to-four-word label and three-to-ten-word context bound to the Epic body hash recorded in the snapshot, then rebuild the model.",
          "roadmap-executive",
        ),
      );
    }
    const identityMatches = entry?.issueNumber === epic.issueNumber;
    if (entry && !identityMatches) {
      blockers.push(
        blocker(
          "EPIC_MAPPING_IDENTITY_MISMATCH",
          `Mapped node ${epic.nodeId} expects issue #${entry.issueNumber}, but GitHub returned #${epic.issueNumber}.`,
          "Verify the immutable GitHub identity and correct the owner-only runtime presentation map, then rebuild the model.",
          "roadmap-capability",
        ),
      );
    }
    const bodyMatches = entry?.boundBodySha256 === epic.bodySha256;
    if (entry && !bodyMatches) {
      blockers.push(
        blocker(
          "SHORTENED_OUTCOME_STALE",
          `The reviewed short label and context for Epic #${epic.issueNumber} are not bound to its body recorded in the snapshot.`,
          "Review the Epic body recorded in the snapshot, or recollect before updating the short label, context, and body hash.",
          "roadmap-executive",
        ),
      );
    }
    const summaryFormatValid = entry
      ? presentationSummaryIsValid(entry, epic.state === "CLOSED")
      : false;
    if (entry && !summaryFormatValid) {
      blockers.push(
        blocker(
          "EPIC_PRESENTATION_SUMMARY_INVALID",
          `Epic #${epic.issueNumber} does not have a two-to-four-word label and three-to-ten-word context within the ${ROADMAP_EXECUTIVE_ROW_MAX_CHARACTERS}-character row limit.`,
          "Review the Epic body recorded in the snapshot and replace its presentation summary without truncation or source-text fallback.",
          "roadmap-executive",
        ),
      );
    }
    const summaryApproved = Boolean(entry && identityMatches && bodyMatches && summaryFormatValid);
    const displayTitle = summaryApproved && entry ? entry.displayTitle : MISSING_SUMMARY_TITLE;
    const shortenedOutcome =
      summaryApproved && entry ? entry.shortenedOutcome : MISSING_SUMMARY_CONTEXT;
    const roadmapArea =
      summaryApproved && ROADMAP_AREAS.includes(entry?.roadmapArea as never)
        ? entry?.roadmapArea
        : undefined;
    resolvedPresentationByEpic.set(epic.nodeId, {
      displayTitle,
      shortenedOutcome,
      ...(roadmapArea ? { roadmapArea } : {}),
    });
    if (!roadmapArea) {
      if (!entry?.roadmapArea || !ROADMAP_AREAS.includes(entry.roadmapArea as never)) {
        blockers.push(
          blocker(
            "EPIC_NEEDS_CLASSIFICATION",
            `Epic #${epic.issueNumber} has no approved roadmap-area mapping.`,
            "Add one reviewed roadmap area to the owner-only runtime presentation map, then rebuild the model.",
            "roadmap-capability",
          ),
        );
      }
      unclassified.push({
        contentId: `unclassified.${epic.issueNumber}`,
        milestoneNodeId: displayMilestoneByEpic.get(epic.nodeId) ?? "",
        issueNumber: epic.issueNumber,
        title: displayTitle,
        url: epic.url,
        state: epic.state,
        closedAt: epic.closedAt,
      });
    }
  }

  const epicSources = orderedEpics.map((epic) =>
    githubSource(`github.epic.${epic.issueNumber}`, epic.url, epic.bodySha256),
  );
  const milestoneSources = options.snapshot.milestones.map((milestone) =>
    githubSource(
      `github.milestone.${milestone.number}`,
      milestone.url,
      options.snapshot.snapshotSha256,
    ),
  );
  const roadmapSources = uniqueSources([...milestoneSources, ...epicSources]);
  const executiveMilestones = options.snapshot.milestones.map((milestone) => {
    const milestoneEpics = orderedEpics.filter(
      (epic) => displayMilestoneByEpic.get(epic.nodeId) === milestone.nodeId,
    );
    const focus = milestoneFocusLabel(
      milestoneEpics,
      resolvedPresentationByEpic,
      options.presentation.roadmapAreas,
    );
    return {
      contentId: `milestone.${milestone.number}`,
      milestoneNodeId: milestone.nodeId,
      title: milestoneDisplayTitle(options.presentation, milestone),
      url: milestone.url,
      dueOn: milestone.dueOn,
      focus,
      status: milestoneStatus(milestone, boundAsOf),
      outcomes: milestoneEpics.map((epic) => {
        const presentation = resolvedPresentationByEpic.get(epic.nodeId);
        if (!presentation) throw new Error(`Epic #${epic.issueNumber} lacks presentation state`);
        return {
          contentId: `epic.${epic.issueNumber}`,
          epicNodeId: epic.nodeId,
          issueNumber: epic.issueNumber,
          featureTitle: presentation.displayTitle,
          text: presentation.shortenedOutcome,
          url: epic.url,
          state: epic.state,
          closedAt: epic.closedAt,
          progress: epic.progress,
        };
      }),
    };
  });

  const matrixColumns = executiveMilestones.map((milestone) => ({
    milestoneNodeId: milestone.milestoneNodeId,
    title: milestone.title,
    dueOn: milestone.dueOn,
    focus: milestone.focus,
    status: milestone.status,
  }));
  const matrixCells = ROADMAP_AREAS.flatMap((roadmapArea) =>
    options.snapshot.milestones.map((milestone) => {
      const items = orderedEpics
        .filter(
          (epic) =>
            displayMilestoneByEpic.get(epic.nodeId) === milestone.nodeId &&
            resolvedPresentationByEpic.get(epic.nodeId)?.roadmapArea === roadmapArea,
        )
        .map((epic) => ({
          contentId: `matrix.epic.${epic.issueNumber}`,
          issueNumber: epic.issueNumber,
          title: resolvedPresentationByEpic.get(epic.nodeId)?.displayTitle ?? MISSING_SUMMARY_TITLE,
          url: epic.url,
          state: epic.state,
          closedAt: epic.closedAt,
        }));
      if (items.length > 3) {
        blockers.push(
          blocker(
            "MATRIX_CELL_OVER_BUDGET",
            `${roadmapArea} / ${milestone.displayTitle ?? milestone.title} contains ${items.length} titles; the native cell limit is three.`,
            "Select a milestone set whose cells each contain no more than three Epics; retain every Epic in each selected milestone, and do not move or omit one to satisfy the limit.",
            "roadmap-capability",
          ),
        );
      }
      return {
        contentId: `matrix.${slug(roadmapArea)}.${milestone.number}`,
        milestoneNodeId: milestone.nodeId,
        roadmapArea,
        items,
      };
    }),
  );
  const mappingSource: SourceRecord = {
    sourceId: "mapping.roadmap-presentation",
    kind: "mapping",
    path: "runtime/presentation-map.json",
    digest: canonicalSha256(options.presentation),
  };

  const claimRecords = options.claims.claims.map((claim) => {
    const evidence = docsByClaim.get(claim.claimId);
    if (
      !evidence ||
      evidence.text !== claim.text ||
      evidence.path !== claim.path ||
      evidence.heading !== claim.heading ||
      JSON.stringify(evidence.evidenceAnchors) !== JSON.stringify(claim.evidenceAnchors)
    ) {
      blockers.push(
        blocker(
          "MARKITECTURE_CLAIM_UNBOUND",
          `Visible claim ${claim.claimId} does not match collected documentation evidence.`,
          "Stop; have an authorized maintainer reconcile the claim ledger through repository review with documentation from the snapshot's recorded Git commit, then recollect documentation evidence.",
          "markitecture",
        ),
      );
    }
    return {
      ...claim,
      commitSha: evidence?.commitSha ?? options.docs.commitSha,
      sectionSha256: evidence?.sectionSha256 ?? "0".repeat(64),
    };
  });
  const claimSources = uniqueSources(
    claimRecords.map((claim) => ({
      sourceId: `claim.${slug(claim.claimId)}`,
      kind: "claim" as const,
      path: claim.path,
      heading: claim.heading,
      commitSha: claim.commitSha,
      digest: claim.sectionSha256,
    })),
  );

  const reportSource: SourceRecord = {
    sourceId: "mapping.weekly-milestone-report",
    kind: "mapping",
    path: "runtime/narrative-input.json",
    digest: options.narrative.reportSha256,
  };
  const roadmapSourceById = new Map(roadmapSources.map((source) => [source.sourceId, source]));
  const executiveMilestoneById = new Map(
    executiveMilestones.map((milestone) => [milestone.milestoneNodeId, milestone]),
  );
  const milestoneIndexById = new Map(
    executiveMilestones.map((milestone, index) => [milestone.milestoneNodeId, index]),
  );
  const snapshotMilestoneById = new Map(
    options.snapshot.milestones.map((milestone) => [milestone.nodeId, milestone]),
  );
  const epicByNodeId = new Map(orderedEpics.map((epic) => [epic.nodeId, epic]));
  const weeklyMilestoneRows: Array<Record<string, unknown>> = [];
  const weeklyEvidenceSources: SourceRecord[] = [reportSource];
  const weeklyMilestoneIds = new Set<string>();
  const weeklyMilestoneIndexes: number[] = [];
  if (options.narrative.milestoneRows.length === 0) {
    blockers.push(
      blocker(
        "WEEKLY_MILESTONE_ROWS_EMPTY",
        "The reviewed weekly milestone report contains no milestone row.",
        "Review and include one to three eligible milestone rows.",
        "weekly-release",
      ),
    );
  }
  if (options.narrative.milestoneRows.length > 3) {
    blockers.push(
      blocker(
        "WEEKLY_MILESTONE_DENSITY_EXCEEDED",
        `${options.narrative.milestoneRows.length} milestone rows exceed the three-row weekly scorecard.`,
        "Select one to three weekly milestone rows without changing roadmap pagination.",
        "weekly-release",
      ),
    );
  }
  for (const [rowIndex, reportRow] of options.narrative.milestoneRows.entries()) {
    const milestoneNodeId = reportRow.milestoneNodeId;
    if (
      !hasExactKeys(reportRow as unknown as JsonRecord, ["milestoneNodeId", "risks", "updates"]) ||
      !isNonemptyString(milestoneNodeId) ||
      !Array.isArray(reportRow.updates) ||
      !Array.isArray(reportRow.risks)
    ) {
      blockers.push(
        blocker(
          "WEEKLY_MILESTONE_ROW_INVALID",
          `Weekly report row ${rowIndex + 1} does not use the exact milestone row contract.`,
          "Provide milestoneNodeId plus update and risk arrays only.",
          "weekly-release",
        ),
      );
      continue;
    }
    if (weeklyMilestoneIds.has(milestoneNodeId)) {
      blockers.push(
        blocker(
          "WEEKLY_MILESTONE_DUPLICATE",
          `Weekly milestone ${milestoneNodeId} appears more than once.`,
          "Include each selected milestone row exactly once.",
          "weekly-release",
        ),
      );
    }
    weeklyMilestoneIds.add(milestoneNodeId);
    const milestone = executiveMilestoneById.get(milestoneNodeId);
    const snapshotMilestone = snapshotMilestoneById.get(milestoneNodeId);
    const milestoneIndex = milestoneIndexById.get(milestoneNodeId);
    if (!milestone || !snapshotMilestone || milestoneIndex === undefined) {
      blockers.push(
        blocker(
          "WEEKLY_MILESTONE_UNKNOWN",
          `Weekly milestone ${milestoneNodeId} is not an eligible roadmap milestone.`,
          "Select the row from the exact eligible milestone identities in the frozen snapshot.",
          "weekly-release",
        ),
      );
      continue;
    }
    weeklyMilestoneIndexes.push(milestoneIndex);
    const milestoneSource = roadmapSourceById.get(`github.milestone.${snapshotMilestone.number}`);
    if (milestoneSource) weeklyEvidenceSources.push(milestoneSource);

    const expectedOutcomeByEpicId = new Map(
      milestone.outcomes.map((outcome) => [outcome.epicNodeId, outcome]),
    );
    const seenUpdateEpicIds = new Set<string>();
    const updates = reportRow.updates.map((update, updateIndex) => {
      const validShape = hasExactKeys(update as unknown as JsonRecord, [
        "epicBodySha256",
        "epicNodeId",
        "label",
        "text",
      ]);
      const epic = epicByNodeId.get(update.epicNodeId);
      const outcome = expectedOutcomeByEpicId.get(update.epicNodeId);
      const epicSource = epic
        ? roadmapSourceById.get(`github.epic.${epic.issueNumber}`)
        : undefined;
      const duplicate = seenUpdateEpicIds.has(update.epicNodeId);
      seenUpdateEpicIds.add(update.epicNodeId);
      const validText =
        conciseEvidenceText(update.label) === update.label &&
        conciseEvidenceText(update.text) === update.text &&
        update.label.length > 0 &&
        update.text.length > 0;
      const validBinding =
        validShape &&
        validText &&
        !duplicate &&
        epic !== undefined &&
        outcome !== undefined &&
        displayMilestoneByEpic.get(epic.nodeId) === milestoneNodeId &&
        update.epicBodySha256 === epic.bodySha256 &&
        update.label === outcome.featureTitle &&
        epicSource?.url === epic.url &&
        epicSource.digest === epic.bodySha256;
      if (!validBinding) {
        blockers.push(
          blocker(
            "WEEKLY_UPDATE_EVIDENCE_INVALID",
            `Weekly update ${updateIndex + 1} for ${milestone.title} does not match one Epic identity, its body SHA-256 from the frozen snapshot evidence, and reviewed short label.`,
            "Bind the report update to one Epic in that milestone, use its exact body SHA-256 from the frozen snapshot evidence, and retain its reviewed short label.",
            "weekly-release",
          ),
        );
      }
      if (epicSource) weeklyEvidenceSources.push(epicSource);
      return {
        contentId: `weekly.milestone.${snapshotMilestone.number}.update.${updateIndex + 1}`,
        epicNodeId: update.epicNodeId,
        epicBodySha256: update.epicBodySha256,
        label: update.label,
        text: update.text,
        sourceId: reportSource.sourceId,
        sourceDigest: reportSource.digest,
      };
    });
    const expectedEpicIds = [...expectedOutcomeByEpicId.keys()].sort();
    const actualEpicIds = [...seenUpdateEpicIds].sort();
    if (!sameJsonValue(actualEpicIds, expectedEpicIds)) {
      blockers.push(
        blocker(
          "WEEKLY_UPDATE_COVERAGE_INVALID",
          `Weekly milestone ${milestone.title} does not report every included Epic exactly once.`,
          "Add one source-bound update for every Epic in the selected milestone and remove duplicates.",
          "weekly-release",
        ),
      );
    }

    const risks = reportRow.risks.map((risk, riskIndex) => {
      const validRisk =
        hasExactKeys(risk as unknown as JsonRecord, ["label", "text"]) &&
        conciseEvidenceText(risk.label) === risk.label &&
        conciseEvidenceText(risk.text) === risk.text &&
        risk.label.length > 0 &&
        risk.text.length > 0;
      if (!validRisk) {
        blockers.push(
          blocker(
            "WEEKLY_RISK_REPORT_INVALID",
            `Weekly risk ${riskIndex + 1} for ${milestone.title} must contain exactly the non-empty label and text fields with normalized whitespace.`,
            "Provide exactly the label and text fields, make both non-empty, and normalize their whitespace.",
            "weekly-release",
          ),
        );
      }
      return {
        contentId: `weekly.milestone.${snapshotMilestone.number}.risk.${riskIndex + 1}`,
        label: risk.label,
        text: risk.text,
        sourceId: reportSource.sourceId,
        sourceDigest: reportSource.digest,
      };
    });
    weeklyMilestoneRows.push({
      contentId: `weekly.milestone.${snapshotMilestone.number}`,
      milestoneNodeId,
      title: milestone.title,
      url: milestone.url,
      updates,
      risks,
    });
  }
  if (
    weeklyMilestoneIndexes.some(
      (milestoneIndex, index) => index > 0 && milestoneIndex <= weeklyMilestoneIndexes[index - 1],
    )
  ) {
    blockers.push(
      blocker(
        "WEEKLY_MILESTONE_ORDER_INVALID",
        "Weekly milestone rows do not preserve the frozen roadmap milestone order.",
        "Keep the selected weekly rows in the same relative order as the roadmap.",
        "weekly-release",
      ),
    );
  }

  const releaseTags = new Set<string>();
  for (const release of options.snapshot.releases) {
    if (releaseTags.has(release.tag)) {
      blockers.push(
        blocker(
          "STABLE_TAG_DUPLICATE",
          `The source snapshot duplicates stable tag ${release.tag}.`,
          "Recollect unique final semver tag refs.",
          "weekly-release",
        ),
      );
    }
    releaseTags.add(release.tag);
    if (release.defaultBranchAncestor !== true) {
      blockers.push(
        blocker(
          "TAG_NOT_ON_DEFAULT_BRANCH",
          `Stable tag ${release.tag} is not proven to be on the frozen default-branch history.`,
          "Stop; have an authorized release owner correct the tag through its owning release workflow, then recollect all evidence.",
          "weekly-release",
        ),
      );
    }
    if (release.announcementMatchCount !== 1 || !release.announcement) {
      blockers.push(
        blocker(
          "ANNOUNCEMENT_MATCH_INVALID",
          `${release.tag} has ${release.announcementMatchCount} exact Announcement matches in the source snapshot.`,
          "Stop; have an authorized release owner create or correct one official Announcement through its owning GitHub workflow, then recollect all evidence.",
          "weekly-release",
        ),
      );
    }
  }
  const releaseSources: SourceRecord[] = [];
  let validatedWindowReleaseCount = 0;
  for (const release of options.snapshot.releases.filter((candidate) => candidate.inWindow)) {
    if (!release.announcement) continue;
    const discussionNumber = githubDiscussionNumber(release.announcement.url);
    if (discussionNumber === null) {
      blockers.push(
        blocker(
          "ANNOUNCEMENT_EVIDENCE_LINK_INVALID",
          `${release.tag} does not have an exact canonical GitHub Discussion URL for its Announcement evidence.`,
          "Recollect the exact NVIDIA/NemoClaw Announcement Discussion before rebuilding the release slide.",
          "weekly-release",
        ),
      );
    }
    if (release.announcementMatchCount === 1 && discussionNumber !== null) {
      validatedWindowReleaseCount += 1;
    }
    releaseSources.push(
      githubSource(
        `github.announcement.${slug(release.tag)}`,
        release.announcement.url,
        release.announcement.bodySha256,
      ),
    );
  }

  const metrics = options.snapshot.metrics;
  let receiptMetrics: ReceiptMetricValues | null = null;
  try {
    receiptMetrics = deriveReceiptMetricValues(options.snapshot, receipts);
  } catch (error) {
    blockers.push(
      blocker(
        "METRIC_RECEIPT_MISMATCH",
        `Weekly metrics cannot be recomputed from their owning receipts: ${error instanceof Error ? error.message : String(error)}.`,
        "Recollect the repository summary and every weekly metric query with retained source records and declared totals.",
        "weekly-release",
      ),
    );
  }
  const safeReceiptMetrics: ReceiptMetricValues = receiptMetrics ?? {
    stars: { total: 0, retainedAdditions: 0 },
    forks: { total: 0, retainedAdditions: 0 },
    mergedPullRequests: { total: 0, inWindow: 0 },
    validationIssues: { opened: 0, closed: 0 },
  };
  let expectedMetrics: Record<string, unknown> = {
    mode: "retained_additions",
    ...safeReceiptMetrics,
  };
  let starsDetail = safeReceiptMetrics.stars.retainedAdditions;
  let forksDetail = safeReceiptMetrics.forks.retainedAdditions;
  let detailLabel = "7-day additions";
  if (metrics.mode === "net_change") {
    detailLabel = "7-day net change";
    starsDetail = 0;
    forksDetail = 0;
    try {
      const evidenceRecord = asRecord(metrics.baselineEvidence);
      const baselineRecord = asRecord(evidenceRecord?.snapshot);
      const approval = asRecord(evidenceRecord?.approval);
      if (
        !evidenceRecord ||
        !baselineRecord ||
        !approval ||
        canonicalJson(Object.keys(evidenceRecord).sort()) !==
          canonicalJson(["approval", "snapshot"])
      ) {
        throw new Error("net_change lacks the exact embedded baseline snapshot and approval");
      }
      const evidence = {
        snapshot: baselineRecord as unknown as SourceSnapshot,
        approval,
      };
      const baselineTotals = approvedBaselineMetricValues(options.snapshot, evidence);
      starsDetail = safeReceiptMetrics.stars.total - baselineTotals.starsTotal;
      forksDetail = safeReceiptMetrics.forks.total - baselineTotals.forksTotal;
      expectedMetrics = {
        mode: "net_change",
        stars: {
          total: safeReceiptMetrics.stars.total,
          netChange: starsDetail,
        },
        forks: {
          total: safeReceiptMetrics.forks.total,
          netChange: forksDetail,
        },
        mergedPullRequests: safeReceiptMetrics.mergedPullRequests,
        validationIssues: safeReceiptMetrics.validationIssues,
        baselineSnapshotSha256: evidence.snapshot.snapshotSha256,
        baselineApproval: {
          approvalSha256: approval.approvalSha256,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
        },
        baselineEvidence: evidenceRecord,
      };
    } catch (error) {
      blockers.push(
        blocker(
          "NET_CHANGE_BASELINE_INVALID",
          `Net-change metrics lack an exact approved baseline: ${error instanceof Error ? error.message : String(error)}.`,
          "Embed the complete read-only baseline snapshot at the window start and its exact hash-bound maintainer approval.",
          "weekly-release",
        ),
      );
      expectedMetrics = {
        mode: "net_change",
        stars: { total: safeReceiptMetrics.stars.total, netChange: 0 },
        forks: { total: safeReceiptMetrics.forks.total, netChange: 0 },
        mergedPullRequests: safeReceiptMetrics.mergedPullRequests,
        validationIssues: safeReceiptMetrics.validationIssues,
      };
    }
  } else if (metrics.mode !== "retained_additions") {
    blockers.push(
      blocker(
        "METRIC_MODE_INVALID",
        `Unknown weekly metric mode: ${String(metrics.mode)}.`,
        "Use retained_additions or provide a complete approved net_change baseline.",
        "weekly-release",
      ),
    );
  }
  if (!sameJsonValue(metrics, expectedMetrics)) {
    blockers.push(
      blocker(
        "METRIC_RECEIPT_MISMATCH",
        "Weekly metric values do not exactly match their owning receipt records, declared totals, and approved baseline.",
        "Rebuild the snapshot from the retained repository and weekly metric evidence.",
        "weekly-release",
      ),
    );
  }
  const latestRelease = options.snapshot.releases[0];
  if (!latestRelease) throw new Error("Snapshot has no selected stable release");
  const metricModels = [
    {
      contentId: "metric.stars",
      label: "Stars",
      value: safeReceiptMetrics.stars.total,
      detailLabel,
      detailValue: starsDetail,
    },
    {
      contentId: "metric.forks",
      label: "Forks",
      value: safeReceiptMetrics.forks.total,
      detailLabel,
      detailValue: forksDetail,
    },
    {
      contentId: "metric.merged-prs",
      label: "Merged PRs",
      value: safeReceiptMetrics.mergedPullRequests.total,
      detailLabel: "7-day merged",
      detailValue: safeReceiptMetrics.mergedPullRequests.inWindow,
    },
    {
      contentId: "metric.vdr-uat",
      label: "VDR/UAT issues",
      value: `Opened ${String(safeReceiptMetrics.validationIssues.opened)}`,
      detailLabel: "7-day closed",
      detailValue: safeReceiptMetrics.validationIssues.closed,
    },
    {
      contentId: "metric.latest-release",
      label: "Latest stable release",
      value: latestRelease.tag,
    },
  ];

  const slideSources = {
    markitecture: claimSources,
    weekly: uniqueSources([
      githubSource(
        "github.snapshot.weekly",
        CANONICAL_REPOSITORY_URL,
        options.snapshot.snapshotSha256,
      ),
      ...weeklyEvidenceSources,
      ...releaseSources,
    ]),
  };
  const sourceReleaseCount = options.snapshot.releases.filter((release) => release.inWindow).length;
  const releaseContext =
    sourceReleaseCount === 0
      ? `No stable release this window. Latest: ${latestRelease.tag}.`
      : validatedWindowReleaseCount === sourceReleaseCount
        ? `${sourceReleaseCount} stable ${sourceReleaseCount === 1 ? "release" : "releases"} this window.`
        : `${sourceReleaseCount} stable; ${validatedWindowReleaseCount} validated Announcements.`;
  const roadmapPages = chunkRoadmapMilestones(executiveMilestones);
  const roadmapPageCount = roadmapPages.length;
  const roadmapSlides = roadmapPages.flatMap((milestones, pageOffset) => {
    const pageIndex = pageOffset + 1;
    const pageMilestoneIds = new Set(milestones.map((milestone) => milestone.milestoneNodeId));
    const pageEpicNumbers = new Set(
      milestones.flatMap((milestone) =>
        milestone.outcomes.map((outcome) => Number(outcome.issueNumber)),
      ),
    );
    const pageSources = roadmapSources.filter((source) => {
      const milestoneMatch = /^github\.milestone\.([1-9]\d*)$/u.exec(source.sourceId);
      if (milestoneMatch) {
        const milestone = options.snapshot.milestones.find(
          (candidate) => candidate.number === Number(milestoneMatch[1]),
        );
        return milestone ? pageMilestoneIds.has(milestone.nodeId) : false;
      }
      const epicMatch = /^github\.epic\.([1-9]\d*)$/u.exec(source.sourceId);
      return epicMatch ? pageEpicNumbers.has(Number(epicMatch[1])) : false;
    });
    const presentedEpicCount = milestones.reduce(
      (count, milestone) => count + milestone.outcomes.length,
      0,
    );
    const summary = `${presentedEpicCount} native GitHub ${presentedEpicCount === 1 ? "Epic" : "Epics"} shown across ${milestones.length} eligible milestone delivery ${milestones.length === 1 ? "window" : "windows"}.`;
    const pageSummary =
      roadmapPageCount === 1 ? summary : `${summary} Page ${pageIndex} of ${roadmapPageCount}.`;
    return [
      {
        role: "roadmap-executive",
        instanceId: `roadmap-executive.${pageIndex}`,
        pageIndex,
        pageCount: roadmapPageCount,
        title: "NemoClaw Feature Roadmap",
        summary: pageSummary,
        milestones,
        managedNotes: "pending",
        sources: pageSources,
      },
      {
        role: "roadmap-capability",
        instanceId: `roadmap-capability.${pageIndex}`,
        pageIndex,
        pageCount: roadmapPageCount,
        title: "NemoClaw Feature Roadmap",
        columns: matrixColumns.filter((column) => pageMilestoneIds.has(column.milestoneNodeId)),
        rows: [...ROADMAP_AREAS],
        cells: matrixCells.filter((cell) => pageMilestoneIds.has(cell.milestoneNodeId)),
        unclassified: unclassified.filter((item) =>
          pageMilestoneIds.has(String(item.milestoneNodeId)),
        ),
        managedNotes: "pending",
        sources: uniqueSources([...pageSources, mappingSource]),
      },
    ];
  });
  const slides: Array<Record<string, unknown>> = [
    ...roadmapSlides,
    {
      role: "markitecture",
      title: "NemoClaw system flow",
      nodes: options.claims.nodes,
      connectors: options.claims.connectors,
      claims: claimRecords,
      managedNotes: "pending",
      sources: slideSources.markitecture,
    },
    {
      role: "weekly-release",
      title: weeklyScorecardTitle(boundWindow),
      window: boundWindow,
      reportObservedAt: options.narrative.observedAt,
      releaseContext,
      metrics: metricModels,
      milestoneRows: weeklyMilestoneRows,
      managedNotes: "pending",
      sources: slideSources.weekly,
    },
  ];
  const publicationBlockers = uniqueFindings(blockers);
  const publicationFindings = uniqueFindings(findings);
  const modelWithoutHash: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "nemoclaw-product-slides",
    repository: {
      nameWithOwner: CANONICAL_REPOSITORY,
      commitSha: options.snapshot.repository.commitSha,
      url: CANONICAL_REPOSITORY_URL,
    },
    asOf: boundAsOf,
    snapshotSha256: options.snapshot.snapshotSha256,
    templateFingerprint: options.templateFingerprint,
    metricMode: options.snapshot.metrics.mode,
    publication: {
      eligible: publicationBlockers.length === 0,
      blockers: publicationBlockers,
      findings: publicationFindings,
    },
    slides,
  };
  const modelSha256 = calculateModelSha256({
    ...modelWithoutHash,
    modelSha256: "0".repeat(64),
  });
  const model = { ...modelWithoutHash, modelSha256 };
  for (const slide of slides) {
    const role = String(slide.role);
    const claims = role === "markitecture" ? claimRecords : undefined;
    slide.managedNotes = managedNotes({
      role,
      instanceId: typeof slide.instanceId === "string" ? slide.instanceId : undefined,
      pageIndex: typeof slide.pageIndex === "number" ? slide.pageIndex : undefined,
      pageCount: typeof slide.pageCount === "number" ? slide.pageCount : undefined,
      modelSha256,
      snapshotSha256: options.snapshot.snapshotSha256,
      sources: slide.sources as SourceRecord[],
      metadata:
        role === "weekly-release"
          ? [
              `snapshot_as_of=${boundAsOf}`,
              `window_start=${boundWindow.start}`,
              `window_end=${boundWindow.end}`,
              `milestone_report_observed_at=${options.narrative.observedAt}`,
              `milestone_report_sha256=${options.narrative.reportSha256}`,
              `milestone_rows=${weeklyMilestoneRows.map((row) => String(row.title)).join(" | ")}`,
            ]
          : undefined,
      claims,
    });
  }
  if (calculateModelSha256(model) !== modelSha256) {
    throw new Error("Model hash changed after adding derived speaker notes");
  }
  return model;
}

type CliOptions = {
  repoRoot?: string;
  snapshot?: string;
  docs?: string;
  presentationMap?: string;
  claims?: string;
  narrativeInput?: string;
  templateFingerprint?: string;
  output?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (!next && argument !== "--help" && argument !== "-h")
      throw new Error(`Missing value for ${argument}`);
    if (argument === "--repo-root") options.repoRoot = next;
    else if (argument === "--snapshot") options.snapshot = next;
    else if (argument === "--docs") options.docs = next;
    else if (argument === "--presentation-map") options.presentationMap = next;
    else if (argument === "--claims") options.claims = next;
    else if (argument === "--narrative-input") options.narrativeInput = next;
    else if (argument === "--template-fingerprint") options.templateFingerprint = next;
    else if (argument === "--output") options.output = next;
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node --import tsx build-slide-model.mts --repo-root PATH --snapshot PATH --docs PATH --presentation-map PATH --claims PATH --narrative-input PATH --template-fingerprint SHA256 --output PATH",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (
    !options.repoRoot ||
    !options.snapshot ||
    !options.docs ||
    !options.presentationMap ||
    !options.claims ||
    !options.narrativeInput ||
    !options.templateFingerprint ||
    !options.output
  ) {
    throw new Error("All build-slide-model arguments are required");
  }
  const outputPath = assertProtectedOutputAbsent(options.output, "Slide model");
  const docs = readJson<DocumentationEvidence>(options.docs);
  const claims = readJson<ClaimLedger>(options.claims);
  verifyDocumentationEvidence({
    repoRoot: options.repoRoot,
    evidence: docs,
    claims,
  });
  const model = buildSlideModel({
    snapshot: readJson<SourceSnapshot>(options.snapshot),
    docs,
    presentation: readJson<PresentationMap>(options.presentationMap),
    claims,
    narrative: readJson<NarrativeInput>(options.narrativeInput),
    templateFingerprint: options.templateFingerprint,
  });
  writeProtectedOutput(outputPath, canonicalJson(model), { artifactName: "Slide model" });
  console.log(`Slide model written: ${quoteProtectedOutputPath(outputPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`build-slide-model: error: ${protectedOutputDiagnostic(error)}`);
    process.exitCode = 1;
  }
}
