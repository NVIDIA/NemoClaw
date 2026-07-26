// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidGithubRequestId } from "../advisors/github.mts";

const RETRYABLE_FAILURE_MARKER_PREFIX = "<!-- nemoclaw-pr-e2e-retry:v1:";
const RETRYABLE_FAILURE_MARKER_SUFFIX = " -->";
const DISPATCH_RECEIPT_MARKER_PREFIX = "<!-- nemoclaw-pr-e2e-dispatch:v1:";
const DISPATCH_RECEIPT_MARKER_SUFFIX = " -->";
const MAX_DISPATCH_RECEIPT_BYTES = 1024;
export const MAX_DISPATCH_RECONCILIATION_WINDOW_MS = 120_000;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RETRYABLE_FAILURE_REASONS = new Set([
  "prerequisite-ci",
  "child-cancelled",
  "evidence-download",
  "dispatch-not-observed",
] as const);
const DISPATCH_FAILURE_KINDS = new Set(["http", "decode", "transport", "validation"] as const);
const NEVER_RETRY_FAILURE_TITLES = new Set([
  "Authorized E2E run requires reconciliation",
  "PR base changed",
  "Controller stopped early",
  "Run could not start",
]);

export type RetryableFailureReason =
  | "prerequisite-ci"
  | "child-cancelled"
  | "evidence-download"
  | "dispatch-not-observed";

export type DispatchFailureKind = "http" | "decode" | "transport" | "validation";

export type DispatchNotObservedReceipt = {
  correlationId: string;
  workflowSha: string;
  sentAtMs: number;
  deadlineAtMs: number;
  result: "not-observed";
  failureKind: DispatchFailureKind;
  status?: number;
  requestId?: string;
};

type RetryableCheck = {
  status?: string;
  conclusion?: string | null;
  output?: { title?: string | null; summary?: string | null };
};

function canonicalReceipt(receipt: DispatchNotObservedReceipt): DispatchNotObservedReceipt {
  return {
    correlationId: receipt.correlationId,
    workflowSha: receipt.workflowSha,
    sentAtMs: receipt.sentAtMs,
    deadlineAtMs: receipt.deadlineAtMs,
    result: "not-observed",
    failureKind: receipt.failureKind,
    ...(receipt.status === undefined ? {} : { status: receipt.status }),
    ...(receipt.requestId === undefined ? {} : { requestId: receipt.requestId }),
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateDispatchReceipt(value: unknown): DispatchNotObservedReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatch receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "correlationId",
    "workflowSha",
    "sentAtMs",
    "deadlineAtMs",
    "result",
    "failureKind",
    "status",
    "requestId",
  ]);
  if (Object.keys(receipt).some((key) => !allowedKeys.has(key))) {
    throw new Error("dispatch receipt contains an unexpected field");
  }
  if (
    typeof receipt.correlationId !== "string" ||
    !CORRELATION_PATTERN.test(receipt.correlationId) ||
    typeof receipt.workflowSha !== "string" ||
    !SHA_PATTERN.test(receipt.workflowSha) ||
    !isPositiveSafeInteger(receipt.sentAtMs) ||
    !isPositiveSafeInteger(receipt.deadlineAtMs) ||
    receipt.deadlineAtMs <= receipt.sentAtMs ||
    receipt.deadlineAtMs - receipt.sentAtMs > MAX_DISPATCH_RECONCILIATION_WINDOW_MS ||
    receipt.result !== "not-observed" ||
    typeof receipt.failureKind !== "string" ||
    !DISPATCH_FAILURE_KINDS.has(receipt.failureKind as DispatchFailureKind) ||
    (receipt.status !== undefined &&
      (!Number.isSafeInteger(receipt.status) ||
        (receipt.status as number) < 100 ||
        (receipt.status as number) > 599)) ||
    (receipt.requestId !== undefined && !isValidGithubRequestId(receipt.requestId))
  ) {
    throw new Error("dispatch receipt fields are invalid");
  }
  return canonicalReceipt(receipt as DispatchNotObservedReceipt);
}

export function retryableFailureMarker(reason: RetryableFailureReason): string {
  return `${RETRYABLE_FAILURE_MARKER_PREFIX}${reason}${RETRYABLE_FAILURE_MARKER_SUFFIX}`;
}

export function dispatchNotObservedReceiptMarker(receipt: DispatchNotObservedReceipt): string {
  const validated = validateDispatchReceipt(receipt);
  const encoded = Buffer.from(JSON.stringify(validated), "utf8").toString("base64url");
  return `${DISPATCH_RECEIPT_MARKER_PREFIX}${encoded}${DISPATCH_RECEIPT_MARKER_SUFFIX}`;
}

export function dispatchNotObservedReceiptFromSummary(
  summary: string,
): DispatchNotObservedReceipt | undefined {
  const retryMarker = `\n\n${retryableFailureMarker("dispatch-not-observed")}`;
  if (!summary.endsWith(retryMarker)) return undefined;
  const body = summary.slice(0, -retryMarker.length);
  const receiptBoundary = `\n\n${DISPATCH_RECEIPT_MARKER_PREFIX}`;
  const receiptStart = body.lastIndexOf(receiptBoundary);
  if (receiptStart < 0) return undefined;
  const marker = body.slice(receiptStart + 2);
  if (
    !marker.startsWith(DISPATCH_RECEIPT_MARKER_PREFIX) ||
    !marker.endsWith(DISPATCH_RECEIPT_MARKER_SUFFIX)
  ) {
    return undefined;
  }
  const encoded = marker.slice(
    DISPATCH_RECEIPT_MARKER_PREFIX.length,
    -DISPATCH_RECEIPT_MARKER_SUFFIX.length,
  );
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > MAX_DISPATCH_RECEIPT_BYTES) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const receipt = validateDispatchReceipt(JSON.parse(decoded));
    return marker === dispatchNotObservedReceiptMarker(receipt) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

export function retryableFailureReason(check: RetryableCheck): RetryableFailureReason | undefined {
  if (check.status !== "completed" || check.conclusion !== "failure") return undefined;
  if (NEVER_RETRY_FAILURE_TITLES.has(check.output?.title ?? "")) return undefined;
  const summary = check.output?.summary;
  if (typeof summary !== "string") return undefined;
  const markerBoundary = `\n\n${RETRYABLE_FAILURE_MARKER_PREFIX}`;
  const markerStart = summary.lastIndexOf(markerBoundary);
  if (markerStart < 0) return undefined;
  const marker = summary.slice(markerStart + 2);
  if (!marker.endsWith(RETRYABLE_FAILURE_MARKER_SUFFIX)) return undefined;
  const reason = marker.slice(
    RETRYABLE_FAILURE_MARKER_PREFIX.length,
    -RETRYABLE_FAILURE_MARKER_SUFFIX.length,
  );
  if (!RETRYABLE_FAILURE_REASONS.has(reason as RetryableFailureReason)) return undefined;
  if (marker !== retryableFailureMarker(reason as RetryableFailureReason)) return undefined;
  if (
    reason === "dispatch-not-observed" &&
    dispatchNotObservedReceiptFromSummary(summary) === undefined
  ) {
    return undefined;
  }
  return reason as RetryableFailureReason;
}
