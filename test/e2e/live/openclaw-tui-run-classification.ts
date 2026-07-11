// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface Issue2603AttemptOutcome {
  captureFailure: boolean;
  productRegression: boolean;
  error?: string;
}

export type Issue2603RunClassification =
  | "passed"
  | "recovered_infrastructure_capture"
  | "infrastructure_capture_failure"
  | "infrastructure_setup_failure"
  | "product_regression";

export type Issue2603TraceEnvelope<SentRun, Event, HistoryMessage> = {
  sentRuns: SentRun[];
  events: Event[];
  historyMessages: HistoryMessage[];
  error?: string;
};

export function normalizeIssue2603Trace<SentRun, Event, HistoryMessage>(
  value: Partial<Issue2603TraceEnvelope<SentRun, Event, HistoryMessage>>,
): Issue2603TraceEnvelope<SentRun, Event, HistoryMessage> {
  return {
    sentRuns: Array.isArray(value.sentRuns) ? value.sentRuns : [],
    events: Array.isArray(value.events) ? value.events : [],
    historyMessages: Array.isArray(value.historyMessages) ? value.historyMessages : [],
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

export function classifyIssue2603Run(
  attempts: readonly Issue2603AttemptOutcome[],
): Issue2603RunClassification {
  if (attempts.length === 0) {
    throw new Error("Issue #2603 run classification requires at least one attempt");
  }

  const finalAttempt = attempts.at(-1)!;
  if (finalAttempt.error) return "infrastructure_setup_failure";
  if (finalAttempt.captureFailure) return "infrastructure_capture_failure";
  if (finalAttempt.productRegression) return "product_regression";
  if (attempts.slice(0, -1).some((attempt) => attempt.captureFailure)) {
    return "recovered_infrastructure_capture";
  }
  return "passed";
}
