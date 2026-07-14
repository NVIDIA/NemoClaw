// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateColdOnboardPerformance,
  maximumOutputSilenceMs,
  ONBOARD_PHASE_NAMES,
  readColdOnboardPerformanceBudget,
  readOnboardTraceWindow,
} from "../fixtures/onboard-performance.ts";
import { extractOpenClawAgentPayloadText } from "../live/agent-turn-latency-helpers.ts";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const FOREIGN_TRACE_ID = "fedcba9876543210fedcba9876543210";
const ROOT_SPAN_ID = "0000000000000001";
const ROOT_START_MS = 1_000;
const ROOT_END_MS = 6_000;

function timestampNs(milliseconds: number): string {
  return String(milliseconds * 1_000_000);
}

function phaseSpan(
  name: (typeof ONBOARD_PHASE_NAMES)[number],
  spanId: string,
  startMs: number,
  durationMs: number,
): Record<string, unknown> {
  return {
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: ROOT_SPAN_ID,
    name,
    start_time_unix_nano: timestampNs(startMs),
    end_time_unix_nano: timestampNs(startMs + durationMs),
    duration_ms: durationMs,
    status: { code: "OK" },
  };
}

const PHASE_SPANS: Array<Record<string, unknown>> = [
  phaseSpan(ONBOARD_PHASE_NAMES[0], "0000000000000002", 1_100, 250),
  phaseSpan(ONBOARD_PHASE_NAMES[1], "0000000000000003", 1_400, 500),
  phaseSpan(ONBOARD_PHASE_NAMES[2], "0000000000000004", 2_000, 750),
  phaseSpan(ONBOARD_PHASE_NAMES[3], "0000000000000005", 2_800, 1_000),
  phaseSpan(ONBOARD_PHASE_NAMES[4], "0000000000000006", 4_000, 1_250),
];

function traceArtifact(
  rootOverrides: Partial<Record<string, unknown>> = {},
  phaseSpans = PHASE_SPANS,
  summaryOverrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    resource_spans: [
      {
        scope_spans: [
          {
            scope: { name: "nemoclaw.onboard" },
            spans: [
              {
                trace_id: TRACE_ID,
                span_id: ROOT_SPAN_ID,
                name: "nemoclaw.onboard",
                start_time_unix_nano: timestampNs(ROOT_START_MS),
                end_time_unix_nano: timestampNs(ROOT_END_MS),
                duration_ms: ROOT_END_MS - ROOT_START_MS,
                status: { code: "OK" },
                ...rootOverrides,
              },
              ...phaseSpans,
            ],
          },
        ],
      },
    ],
    summary: { trace_id: TRACE_ID, ...summaryOverrides },
  };
}

function replacePhase(index: number, overrides: Record<string, unknown>) {
  return PHASE_SPANS.map((span, phaseIndex) =>
    phaseIndex === index ? { ...span, ...overrides } : span,
  );
}

function completePhaseBudgets(value = 1_500) {
  return Object.fromEntries(ONBOARD_PHASE_NAMES.map((name) => [name, value]));
}

describe("onboard performance evidence", () => {
  it("reads one successful, root-bound onboard trace with consistent timing", () => {
    expect(readOnboardTraceWindow(traceArtifact())).toEqual({
      durationMs: 5_000,
      finishedAtMs: 6_000,
      phaseDurationsMs: {
        "nemoclaw.onboard.phase.preflight": 250,
        "nemoclaw.onboard.phase.gateway": 500,
        "nemoclaw.onboard.phase.provider_selection": 750,
        "nemoclaw.onboard.phase.inference": 1_000,
        "nemoclaw.onboard.phase.sandbox": 1_250,
      },
      startedAtMs: 1_000,
    });
  });

  it.each([
    ["missing root", { name: "not-onboard" }, {}, "exactly one onboard root"],
    ["failed root", { status: { code: "ERROR" } }, {}, "status is missing or not OK"],
    ["root parent", { parent_span_id: "0000000000000099" }, {}, "must not have a parent"],
    ["malformed timestamp", { start_time_unix_nano: "yesterday" }, {}, "start time"],
    [
      "reversed timestamps",
      { end_time_unix_nano: timestampNs(ROOT_START_MS - 1) },
      {},
      "ends before it starts",
    ],
    ["inconsistent duration", { duration_ms: 4_999 }, {}, "does not match its timestamps"],
    ["foreign summary", {}, { trace_id: FOREIGN_TRACE_ID }, "exactly one onboard root"],
  ])("rejects a %s trace", (_label, rootOverrides, summaryOverrides, message) => {
    expect(() =>
      readOnboardTraceWindow(traceArtifact(rootOverrides, PHASE_SPANS, summaryOverrides)),
    ).toThrow(message);
  });

  it("requires every stable onboarding phase exactly once", () => {
    expect(() => readOnboardTraceWindow(traceArtifact({}, PHASE_SPANS.slice(0, -1)))).toThrow(
      "phase.sandbox",
    );
    expect(() =>
      readOnboardTraceWindow(
        traceArtifact({}, [
          ...PHASE_SPANS,
          phaseSpan(ONBOARD_PHASE_NAMES[4], "0000000000000007", 5_300, 1),
        ]),
      ),
    ).toThrow("exactly one");
  });

  it.each([
    ["foreign trace", 0, { trace_id: FOREIGN_TRACE_ID }, "phase.preflight"],
    ["wrong parent", 1, { parent_span_id: "0000000000000099" }, "not a child"],
    ["failed status", 2, { status: { code: "ERROR" } }, "status is missing or not OK"],
    ["malformed span id", 3, { span_id: "short" }, "span_id"],
    [
      "out-of-root window",
      4,
      {
        start_time_unix_nano: timestampNs(5_000),
        end_time_unix_nano: timestampNs(6_250),
      },
      "outside the onboard root window",
    ],
    ["inconsistent duration", 4, { duration_ms: 1_249 }, "does not match its timestamps"],
  ])("rejects a phase with %s", (_label, index, overrides, message) => {
    expect(() =>
      readOnboardTraceWindow(traceArtifact({}, replacePhase(index as number, overrides))),
    ).toThrow(message);
  });

  it("ignores duplicate root and phase names from a different trace", () => {
    const foreignRoot = {
      trace_id: FOREIGN_TRACE_ID,
      span_id: "0000000000000098",
      name: "nemoclaw.onboard",
    };
    const foreignPhase = {
      ...PHASE_SPANS[0],
      trace_id: FOREIGN_TRACE_ID,
      span_id: "0000000000000099",
    };

    expect(
      readOnboardTraceWindow(traceArtifact({}, [...PHASE_SPANS, foreignRoot, foreignPhase])),
    ).toEqual(readOnboardTraceWindow(traceArtifact()));
  });

  it("rejects duplicate IDs and overlapping or reordered phases", () => {
    expect(() =>
      readOnboardTraceWindow(traceArtifact({}, replacePhase(0, { span_id: ROOT_SPAN_ID }))),
    ).toThrow("duplicate span_id");
    expect(() =>
      readOnboardTraceWindow(
        traceArtifact(
          {},
          replacePhase(1, {
            start_time_unix_nano: timestampNs(1_200),
            end_time_unix_nano: timestampNs(1_700),
          }),
        ),
      ),
    ).toThrow("overlaps or precedes");
  });

  it("evaluates root-boundary and configured phase budgets independently", () => {
    const trace = readOnboardTraceWindow(traceArtifact());
    const budget = readColdOnboardPerformanceBudget({
      fullE2eColdPath: {
        rootStartToFirstTurnCompletionBudgetMs: 5_000,
        rootEndToFirstTurnCompletionBudgetMs: 1_000,
        phaseBudgetsMs: completePhaseBudgets(),
      },
    });

    expect(evaluateColdOnboardPerformance(trace, 6_000, budget)).toEqual({
      passed: true,
      rootStartToFirstTurnCompletionMs: 5_000,
      rootEndToFirstTurnCompletionMs: 0,
      violations: [],
    });
    expect(evaluateColdOnboardPerformance(trace, 7_500, budget)).toEqual({
      passed: false,
      rootStartToFirstTurnCompletionMs: 6_500,
      rootEndToFirstTurnCompletionMs: 1_500,
      violations: [
        "root-start-to-first-turn-completion 6500ms exceeds 5000ms",
        "root-end-to-first-turn-completion 1500ms exceeds 1000ms",
      ],
    });

    trace.phaseDurationsMs[ONBOARD_PHASE_NAMES[4]] = 1_501;
    expect(evaluateColdOnboardPerformance(trace, 6_000, budget).violations).toEqual([
      "nemoclaw.onboard.phase.sandbox 1501ms exceeds 1500ms",
    ]);
  });

  it("rejects malformed or incomplete cold-path budget configuration", () => {
    expect(() => readColdOnboardPerformanceBudget({})).toThrow("fullE2eColdPath");
    const fullE2eColdPath = {
      rootStartToFirstTurnCompletionBudgetMs: 1_000,
      rootEndToFirstTurnCompletionBudgetMs: 1_001,
      phaseBudgetsMs: completePhaseBudgets(),
    };
    expect(() => readColdOnboardPerformanceBudget({ fullE2eColdPath })).toThrow();
    const { [ONBOARD_PHASE_NAMES[0]]: _, ...incompletePhases } = completePhaseBudgets();
    expect(() =>
      readColdOnboardPerformanceBudget({
        fullE2eColdPath: {
          ...fullE2eColdPath,
          rootEndToFirstTurnCompletionBudgetMs: 1_000,
          phaseBudgetsMs: incompletePhases,
        },
      }),
    ).toThrow();
    expect(() =>
      readColdOnboardPerformanceBudget({
        fullE2eColdPath: {
          ...fullE2eColdPath,
          rootEndToFirstTurnCompletionBudgetMs: 1_000,
          phaseBudgetsMs: { ...completePhaseBudgets(), unknown: 1 },
        },
      }),
    ).toThrow();
    expect(() =>
      readColdOnboardPerformanceBudget({
        fullE2eColdPath: {
          ...fullE2eColdPath,
          rootEndToFirstTurnCompletionBudgetMs: 1_000,
          unexpected: true,
        },
      }),
    ).toThrow();
  });

  it("rejects impossible first-turn timing boundaries", () => {
    const trace = readOnboardTraceWindow(traceArtifact());
    const budget = readColdOnboardPerformanceBudget({
      fullE2eColdPath: {
        rootStartToFirstTurnCompletionBudgetMs: 5_000,
        rootEndToFirstTurnCompletionBudgetMs: 1_000,
        phaseBudgetsMs: completePhaseBudgets(),
      },
    });
    expect(() => evaluateColdOnboardPerformance(trace, trace.finishedAtMs - 1, budget)).toThrow(
      "timing boundaries",
    );
  });

  it("measures the largest in-window gap after ordering and filtering output events", () => {
    expect(
      maximumOutputSilenceMs({ startedAtMs: 1_000, finishedAtMs: 5_000 }, [
        { atMs: 4_900 },
        { atMs: 1_100 },
        { atMs: 3_000 },
        { atMs: 999 },
        { atMs: 6_000 },
      ]),
    ).toBe(1_900);
  });

  it("treats the entire onboard window as silent when no output arrives", () => {
    expect(maximumOutputSilenceMs({ startedAtMs: 1_000, finishedAtMs: 5_000 }, [])).toBe(4_000);
  });

  it("rejects an output window that ends before it starts", () => {
    expect(() => maximumOutputSilenceMs({ startedAtMs: 5_000, finishedAtMs: 1_000 }, [])).toThrow(
      "onboard output window is invalid",
    );
  });

  it("rejects echoed user messages as first-agent-response evidence", () => {
    expect(
      extractOpenClawAgentPayloadText(
        JSON.stringify({
          messages: [{ role: "user", content: "Reply with exactly: NEMOCLAW_E2E_READY_6002" }],
        }),
      ),
    ).toBe("");
  });

  it("accepts a framed OpenClaw agent-output payload", () => {
    expect(
      extractOpenClawAgentPayloadText(
        `progress\n${JSON.stringify({ result: { payloads: [{ text: "NEMOCLAW_E2E_READY_6002" }] } })}`,
      ),
    ).toBe("NEMOCLAW_E2E_READY_6002");
  });

  it("joins top-level agent-output payload fragments", () => {
    expect(
      extractOpenClawAgentPayloadText(
        JSON.stringify({
          payloads: [{ text: "NEMOCLAW_" }, { text: "E2E_READY_6002" }],
        }),
      ),
    ).toBe("NEMOCLAW_\nE2E_READY_6002");
  });
});
