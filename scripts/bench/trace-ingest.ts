// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFull } from "../../src/lib/security/redact";

import type { BenchMetric, BenchMetricContext, LatencyStats, MetricId } from "./lib";

// Span names emitted by src/lib/onboard/tracing.ts into the nemoclaw.trace_timing
// artifact. The benchmark reads canonical emitted spans rather than adding
// parallel instrumentation to onboarding.
export const SANDBOX_PHASE_SPAN = "nemoclaw.onboard.phase.sandbox";
export const SANDBOX_READINESS_SPAN = "nemoclaw.sandbox.readiness_wait";
export const POLICY_APPLICATION_SPAN = "nemoclaw.policy.application";

interface TraceLikeSpan {
  trace_id?: unknown;
  span_id?: unknown;
  parent_span_id?: unknown;
  name?: unknown;
  duration_ms?: unknown;
  status?: unknown;
  attributes?: unknown;
}

interface ValidTrace {
  rootSpanId: string;
  rootDurationMs: number;
  rootAttributes: Record<string, unknown>;
  spans: TraceLikeSpan[];
}

type TraceMetricId = Extract<MetricId, "sandbox-cold-start" | "policy-shield-overhead">;
type TraceInspection = { ok: true; trace: ValidTrace } | { ok: false; reason: string };
type MetricSpan =
  | {
      kind: "ok";
      durationMs: number;
      spanId: string;
      parentSpanId?: string;
      attributes: Record<string, unknown>;
    }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

const TRACE_SCOPE_NAME = "nemoclaw.onboard";
const TRACE_ROOT_SPAN = "nemoclaw.onboard";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function inspectTraceArtifact(artifact: unknown): TraceInspection {
  const artifactRecord = asRecord(artifact);
  const summary = asRecord(artifactRecord?.summary);
  const traceId = summary?.trace_id;
  if (typeof traceId !== "string" || traceId.length === 0) {
    return { ok: false, reason: "trace summary is missing trace_id" };
  }

  const resourceSpans = artifactRecord?.resource_spans;
  if (!Array.isArray(resourceSpans)) {
    return { ok: false, reason: "trace artifact is missing resource_spans" };
  }

  const spans: TraceLikeSpan[] = [];
  let matchedScope = false;
  for (const resourceSpan of resourceSpans) {
    const scopeSpans = asRecord(resourceSpan)?.scope_spans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scopeSpan of scopeSpans) {
      const scopeSpanRecord = asRecord(scopeSpan);
      const scope = asRecord(scopeSpanRecord?.scope);
      if (scope?.name !== TRACE_SCOPE_NAME) continue;
      matchedScope = true;
      const inner = scopeSpanRecord?.spans;
      if (!Array.isArray(inner) || inner.some((span) => asRecord(span) === null)) {
        return { ok: false, reason: "onboard trace scope contains malformed spans" };
      }
      spans.push(...(inner as TraceLikeSpan[]));
    }
  }

  if (!matchedScope) {
    return { ok: false, reason: `trace artifact is missing the ${TRACE_SCOPE_NAME} scope` };
  }
  const roots = spans.filter((span) => span.name === TRACE_ROOT_SPAN);
  if (roots.length !== 1) {
    return { ok: false, reason: "trace artifact must contain exactly one onboard root span" };
  }
  if (spans.some((span) => span.trace_id !== traceId)) {
    return { ok: false, reason: "trace spans do not match the summary trace_id" };
  }

  const root = roots[0];
  if (typeof root.span_id !== "string" || root.span_id.length === 0) {
    return { ok: false, reason: "onboard root span is missing span_id" };
  }
  const rootStatus = asRecord(root.status)?.code;
  if (rootStatus !== "OK") {
    return { ok: false, reason: "onboard root span status is missing or not OK" };
  }
  if (!isValidDuration(root.duration_ms)) {
    return { ok: false, reason: "onboard root span has an invalid duration" };
  }
  return {
    ok: true,
    trace: {
      rootSpanId: root.span_id,
      rootDurationMs: root.duration_ms,
      rootAttributes: asRecord(root.attributes) ?? {},
      spans,
    },
  };
}

function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readMetricSpan(trace: ValidTrace, name: string): MetricSpan {
  const matches = trace.spans.filter((span) => span.name === name);
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) {
    return { kind: "error", reason: `trace contains multiple ${name} spans` };
  }
  const span = matches[0];
  if (typeof span.span_id !== "string" || span.span_id.length === 0) {
    return { kind: "error", reason: `${name} span is missing span_id` };
  }
  const status = asRecord(span.status)?.code;
  if (status !== "OK") {
    return { kind: "error", reason: `${name} span status is missing or not OK` };
  }
  if (!isValidDuration(span.duration_ms)) {
    return { kind: "error", reason: `${name} span has an invalid duration` };
  }
  return {
    kind: "ok",
    durationMs: round3(span.duration_ms),
    spanId: span.span_id,
    attributes: asRecord(span.attributes) ?? {},
    ...(typeof span.parent_span_id === "string" ? { parentSpanId: span.parent_span_id } : {}),
  };
}

function safeContextString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return redactFull(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, 160);
}

function traceMetricContext(
  trace: ValidTrace,
  metricAttributes: Record<string, unknown>,
): BenchMetricContext {
  const sandboxAttributes =
    asRecord(trace.spans.find((span) => span.name === SANDBOX_PHASE_SPAN)?.attributes) ?? {};
  const provider = safeContextString(metricAttributes.provider ?? sandboxAttributes.provider);
  const model = safeContextString(sandboxAttributes.model);
  const agent = safeContextString(trace.rootAttributes.agent ?? sandboxAttributes.agent);
  const nonInteractive = trace.rootAttributes.non_interactive;
  const fresh = trace.rootAttributes.fresh;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(typeof nonInteractive === "boolean" ? { non_interactive: nonInteractive } : {}),
    ...(typeof fresh === "boolean" ? { fresh } : {}),
  };
}

function traceMetricBase(id: TraceMetricId): BenchMetric {
  return {
    id,
    status: "ok",
    unit: "ms",
    source: "trace-artifact",
    interpretation: "advisory-non-normative",
  };
}

function invalidTraceMetric(id: TraceMetricId, reason: string): BenchMetric {
  return { ...traceMetricBase(id), status: "error", reason: `invalid onboard trace: ${reason}` };
}

export function ingestSandboxColdStart(artifact: unknown): BenchMetric {
  const inspected = inspectTraceArtifact(artifact);
  if (!inspected.ok) return invalidTraceMetric("sandbox-cold-start", inspected.reason);
  const phase = readMetricSpan(inspected.trace, SANDBOX_PHASE_SPAN);
  const base = traceMetricBase("sandbox-cold-start");
  if (phase.kind === "error") return invalidTraceMetric("sandbox-cold-start", phase.reason);
  if (phase.kind === "missing") {
    return {
      ...base,
      status: "unsupported",
      source: "none",
      reason: `no ${SANDBOX_PHASE_SPAN} span in the trace artifact (re-run \`nemoclaw onboard\` with NEMOCLAW_TRACE=1, then pass --trace <file>)`,
    };
  }
  if (phase.parentSpanId !== inspected.trace.rootSpanId) {
    return invalidTraceMetric(
      "sandbox-cold-start",
      `${SANDBOX_PHASE_SPAN} is not a child of the onboard root`,
    );
  }
  if (phase.durationMs > inspected.trace.rootDurationMs) {
    return invalidTraceMetric(
      "sandbox-cold-start",
      `${SANDBOX_PHASE_SPAN} duration exceeds the onboard root`,
    );
  }

  const breakdown: Record<string, number> = { sandbox_phase_ms: phase.durationMs };
  const readiness = readMetricSpan(inspected.trace, SANDBOX_READINESS_SPAN);
  if (readiness.kind === "error") {
    return invalidTraceMetric("sandbox-cold-start", readiness.reason);
  }
  if (readiness.kind === "ok") {
    if (readiness.parentSpanId !== phase.spanId) {
      return invalidTraceMetric(
        "sandbox-cold-start",
        `${SANDBOX_READINESS_SPAN} is not nested under the sandbox phase`,
      );
    }
    if (readiness.durationMs > phase.durationMs) {
      return invalidTraceMetric(
        "sandbox-cold-start",
        `${SANDBOX_READINESS_SPAN} duration exceeds its enclosing sandbox phase`,
      );
    }
    breakdown.readiness_wait_ms = readiness.durationMs;
  }
  return {
    ...base,
    breakdown,
    context: traceMetricContext(inspected.trace, phase.attributes),
    stats: singleValueStats(phase.durationMs),
  };
}

export function ingestPolicyOverhead(artifact: unknown): BenchMetric {
  const inspected = inspectTraceArtifact(artifact);
  if (!inspected.ok) return invalidTraceMetric("policy-shield-overhead", inspected.reason);
  const policy = readMetricSpan(inspected.trace, POLICY_APPLICATION_SPAN);
  const base = traceMetricBase("policy-shield-overhead");
  if (policy.kind === "error") return invalidTraceMetric("policy-shield-overhead", policy.reason);
  if (policy.kind === "missing") {
    return {
      ...base,
      status: "unsupported",
      source: "none",
      reason:
        "no policy.application span in the trace artifact (re-run `nemoclaw onboard` with NEMOCLAW_TRACE=1, then pass --trace <file>)",
    };
  }
  if (policy.parentSpanId !== inspected.trace.rootSpanId) {
    return invalidTraceMetric(
      "policy-shield-overhead",
      `${POLICY_APPLICATION_SPAN} is not a child of the onboard root`,
    );
  }
  if (policy.durationMs > inspected.trace.rootDurationMs) {
    return invalidTraceMetric(
      "policy-shield-overhead",
      `${POLICY_APPLICATION_SPAN} duration exceeds the onboard root`,
    );
  }
  const context = traceMetricContext(inspected.trace, policy.attributes);
  if (inspected.trace.rootAttributes.non_interactive !== true) {
    return {
      ...base,
      status: "unsupported",
      source: "none",
      context,
      reason:
        "interactive policy selection can include human think time; collect the trace with `nemoclaw onboard --non-interactive`",
    };
  }
  return {
    ...base,
    status: "unsupported",
    source: "none",
    context,
    reason:
      "the onboard trace records policy application setup time, not request-path shield overhead; dedicated request-path timing is not available",
  };
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function singleValueStats(value: number): LatencyStats {
  return { min_ms: value, median_ms: value, p95_ms: value, mean_ms: value, max_ms: value };
}
