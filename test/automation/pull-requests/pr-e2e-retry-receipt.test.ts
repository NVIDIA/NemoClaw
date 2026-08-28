// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type DispatchNotObservedReceipt,
  dispatchNotObservedReceiptFromSummary,
  dispatchNotObservedReceiptMarker,
  retryableFailureMarker,
  retryableFailureReason,
} from "../../../tools/e2e/pr-e2e-retry-receipt.mts";

const RECEIPT: DispatchNotObservedReceipt = {
  correlationId: "123e4567-e89b-42d3-a456-426614174000",
  workflowSha: "d".repeat(40),
  sentAtMs: 1_785_050_400_000,
  deadlineAtMs: 1_785_050_445_000,
  result: "not-observed",
  failureKind: "http",
  status: 500,
  requestId: "ABCD:1234:EFGH",
};

function completedFailure(summary: string, title = "Workflow dispatch was not observed") {
  return {
    status: "completed",
    conclusion: "failure",
    output: { title, summary },
  };
}

function unvalidatedReceiptMarker(receipt: DispatchNotObservedReceipt): string {
  const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  return `<!-- nemoclaw-pr-e2e-dispatch:v1:${encoded} -->`;
}

describe("PR E2E dispatch retry receipts", () => {
  it("validates a canonical dispatch-not-observed receipt", () => {
    const summary = [
      "GitHub did not expose a correlated child run.",
      dispatchNotObservedReceiptMarker(RECEIPT),
      retryableFailureMarker("dispatch-not-observed"),
    ].join("\n\n");

    expect(dispatchNotObservedReceiptFromSummary(summary)).toEqual(RECEIPT);
    expect(retryableFailureReason(completedFailure(summary))).toBe("dispatch-not-observed");
  });

  it.each([
    {
      label: "missing its structured receipt",
      summary: `No run was found.\n\n${retryableFailureMarker("dispatch-not-observed")}`,
    },
    {
      label: "placing text after its structured receipt",
      summary: [
        dispatchNotObservedReceiptMarker(RECEIPT),
        "untrusted text",
        retryableFailureMarker("dispatch-not-observed"),
      ].join("\n\n"),
    },
    {
      label: "changing its encoded receipt",
      summary: [
        `${dispatchNotObservedReceiptMarker(RECEIPT).slice(0, -4)}AAAA -->`,
        retryableFailureMarker("dispatch-not-observed"),
      ].join("\n\n"),
    },
    {
      label: "without a positive reconciliation window",
      summary: [
        unvalidatedReceiptMarker({
          ...RECEIPT,
          deadlineAtMs: RECEIPT.sentAtMs,
        }),
        retryableFailureMarker("dispatch-not-observed"),
      ].join("\n\n"),
    },
  ])("rejects a dispatch marker $label", ({ summary }) => {
    expect(dispatchNotObservedReceiptFromSummary(summary)).toBeUndefined();
    expect(retryableFailureReason(completedFailure(summary))).toBeUndefined();
  });

  it("preserves existing retry reasons without requiring a dispatch receipt", () => {
    const summary = `The child lost its runner.\n\n${retryableFailureMarker("child-cancelled")}`;

    expect(retryableFailureReason(completedFailure(summary, "Selected E2E did not pass"))).toBe(
      "child-cancelled",
    );
  });

  it("keeps reserved non-retryable titles terminal", () => {
    const summary = [
      dispatchNotObservedReceiptMarker(RECEIPT),
      retryableFailureMarker("dispatch-not-observed"),
    ].join("\n\n");

    expect(
      retryableFailureReason(completedFailure(summary, "Run could not start")),
    ).toBeUndefined();
  });
});
