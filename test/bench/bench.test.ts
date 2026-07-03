// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BENCH_SCHEMA_VERSION,
  type BenchReport,
  buildBenchTarget,
  buildChatCompletionsUrl,
  computeStats,
  hasBlockingError,
  ingestPolicyOverhead,
  ingestSandboxColdStart,
  POLICY_APPLICATION_SPAN,
  redactBaseUrl,
  renderMarkdownReport,
  runInferenceRoundTrip,
  SANDBOX_PHASE_SPAN,
  SANDBOX_READINESS_SPAN,
  unsupportedTraceMetric,
} from "../../scripts/bench/lib";
import {
  finishOnboardTrace,
  startOnboardTrace,
  withSandboxPhaseTrace,
} from "../../src/lib/onboard/tracing";
import type { TraceArtifact, TraceSpan } from "../../src/lib/trace";
import { resetTraceForTests } from "../../src/lib/trace";

function queueClock(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function fakeFetch(status: number, body: string): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as Response) as unknown as typeof fetch;
}

const inferenceOptionsBase = {
  baseUrl: "https://inference.local/v1",
  apiKey: "nvapi-test-key",
  model: "test-model",
  warmup: 0,
  prompt: "ping",
  maxTokens: 4,
  timeoutMs: 1000,
};

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "0123456789abcdef";
let spanSequence = 1;

function traceSpan(
  name: string,
  durationMs: number,
  overrides: Partial<TraceSpan> = {},
): TraceSpan {
  return {
    trace_id: TRACE_ID,
    span_id: (spanSequence++).toString(16).padStart(16, "0"),
    parent_span_id: ROOT_SPAN_ID,
    name,
    kind: "INTERNAL",
    start_time_unix_nano: "1000000",
    end_time_unix_nano: "2000000",
    duration_ms: durationMs,
    status: { code: "OK" },
    attributes: {},
    events: [],
    ...overrides,
  };
}

function traceArtifact(
  spans: TraceSpan[],
  options: {
    rootStatus?: TraceSpan["status"];
    rootDurationMs?: number;
    summaryTraceId?: string;
    scopeName?: string;
  } = {},
): TraceArtifact {
  const root = traceSpan("nemoclaw.onboard", options.rootDurationMs ?? 3000, {
    span_id: ROOT_SPAN_ID,
    parent_span_id: undefined,
    status: options.rootStatus ?? { code: "OK" },
  });
  return {
    resource_spans: [
      {
        resource: { attributes: { "service.name": "nemoclaw" } },
        scope_spans: [
          {
            scope: { name: options.scopeName ?? "nemoclaw.onboard", version: "1.0.0" },
            spans: [root, ...spans],
          },
        ],
      },
    ],
    summary: {
      trace_id: options.summaryTraceId ?? TRACE_ID,
      generated_at: "2026-07-03T00:00:00.000Z",
      total_duration_ms: 3000,
      slowest_spans: [],
      output_path: ".e2e/traces/test.json",
    },
  };
}

describe("computeStats", () => {
  it.each([
    { input: [10], expected: { min: 10, median: 10, p95: 10, mean: 10, max: 10 } },
    { input: [10, 30], expected: { min: 10, median: 10, p95: 30, mean: 20, max: 30 } },
    {
      input: [50, 10, 20, 40, 30],
      expected: { min: 10, median: 30, p95: 50, mean: 30, max: 50 },
    },
  ])("summarizes $input", ({ input, expected }) => {
    const stats = computeStats(input);
    expect(stats.min_ms).toBe(expected.min);
    expect(stats.median_ms).toBe(expected.median);
    expect(stats.p95_ms).toBe(expected.p95);
    expect(stats.mean_ms).toBe(expected.mean);
    expect(stats.max_ms).toBe(expected.max);
  });

  it("returns zeros for an empty sample set", () => {
    expect(computeStats([])).toEqual({
      min_ms: 0,
      median_ms: 0,
      p95_ms: 0,
      mean_ms: 0,
      max_ms: 0,
    });
  });
});

describe("buildChatCompletionsUrl", () => {
  it.each([
    "https://inference.local/v1",
    "https://inference.local/v1/",
    "https://inference.local/v1///",
  ])("normalizes trailing slashes for %s", (base) => {
    expect(buildChatCompletionsUrl(base)).toBe("https://inference.local/v1/chat/completions");
  });
});

describe("redactBaseUrl", () => {
  it("strips URL userinfo so credentials never reach the report", () => {
    const redacted = redactBaseUrl("https://user:s3cr3t-token@host:8000/v1");
    expect(redacted).not.toContain("s3cr3t-token");
    expect(redacted).not.toContain("user:");
    expect(redacted).toContain("host:8000");
  });

  it("passes through a clean URL host and path", () => {
    expect(redactBaseUrl("https://inference.local/v1")).toContain("inference.local/v1");
  });

  it("redacts credential-bearing query parameters", () => {
    const redacted = redactBaseUrl(
      "https://inference.local/v1?api_key=clear-api-secret&password=clear-password&key=clear-key&authorization=clear-auth",
    );
    expect(redacted).not.toContain("clear-api-secret");
    expect(redacted).not.toContain("clear-password");
    expect(redacted).not.toContain("clear-key");
    expect(redacted).not.toContain("clear-auth");
  });

  it("does not echo malformed or unsupported endpoint URLs", () => {
    expect(redactBaseUrl("https//user:clear-password@host")).toBe("(invalid URL)");
    expect(redactBaseUrl("file:///tmp/clear-secret")).toBe("(invalid URL)");
  });

  it("builds a shareable target without URL or model secrets", () => {
    const target = buildBenchTarget(
      "https://inference.local/v1?api_key=clear-api-secret",
      "model api_key=clear-model-secret",
      true,
    );
    const serialized = JSON.stringify(target);
    expect(serialized).not.toContain("clear-api-secret");
    expect(serialized).not.toContain("clear-model-secret");
    expect(target.api_key_present).toBe(true);
  });
});

describe("runInferenceRoundTrip", () => {
  it("produces ok stats from timed samples", async () => {
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 2,
      fetchImpl: fakeFetch(200, "{}"),
      clock: queueClock([0, 10, 100, 130]),
    });
    expect(metric.status).toBe("ok");
    expect(metric.samples).toBe(2);
    expect(metric.stats?.min_ms).toBe(10);
    expect(metric.stats?.max_ms).toBe(30);
    expect(metric.source).toBe("live-request");
  });

  it("returns an error metric on a non-2xx response", async () => {
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl: fakeFetch(500, "upstream boom"),
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("error");
    expect(metric.reason).toContain("HTTP 500");
  });

  it("returns an error metric when the request throws", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl: throwingFetch,
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("error");
    expect(metric.reason).toContain("ECONNREFUSED");
  });

  it("refuses redirects so prompts stay on the configured origin", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestInit = init;
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    };
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl,
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("ok");
    expect(requestInit?.redirect).toBe("error");
  });
});

describe("trace ingestion", () => {
  it("ingests the canonical sandbox phase emitted by onboarding", () => {
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bench-trace-"));
    const tracePath = path.join(traceDir, "onboard.json");
    const previousTraceFile = process.env.NEMOCLAW_TRACE_FILE;
    process.env.NEMOCLAW_TRACE_FILE = tracePath;
    resetTraceForTests();
    try {
      const handle = startOnboardTrace({ agent: "openclaw" }, process.env);
      withSandboxPhaseTrace("bench", "openai", "test-model", "openclaw", () => undefined);
      finishOnboardTrace(handle, true);
      const artifact = JSON.parse(fs.readFileSync(tracePath, "utf8")) as unknown;
      expect(ingestSandboxColdStart(artifact)).toMatchObject({
        status: "ok",
        breakdown: { sandbox_phase_ms: expect.any(Number) },
      });
    } finally {
      resetTraceForTests();
      delete process.env.NEMOCLAW_TRACE_FILE;
      Object.assign(
        process.env,
        previousTraceFile === undefined ? {} : { NEMOCLAW_TRACE_FILE: previousTraceFile },
      );
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("uses the enclosing sandbox phase as cold-start total without double-counting readiness", () => {
    const phase = traceSpan(SANDBOX_PHASE_SPAN, 2000);
    const readiness = traceSpan(SANDBOX_READINESS_SPAN, 800, {
      parent_span_id: phase.span_id,
    });
    const metric = ingestSandboxColdStart(traceArtifact([phase, readiness]));
    expect(metric.status).toBe("ok");
    expect(metric.breakdown).toEqual({ sandbox_phase_ms: 2000, readiness_wait_ms: 800 });
    expect(metric.stats?.median_ms).toBe(2000);
  });

  it("marks sandbox cold-start unsupported when spans are absent", () => {
    const metric = ingestSandboxColdStart(traceArtifact([]));
    expect(metric.status).toBe("unsupported");
    expect(metric.source).toBe("none");
    expect(metric.reason).toContain("trace");
  });

  it("reads the policy.application span", () => {
    const metric = ingestPolicyOverhead(traceArtifact([traceSpan(POLICY_APPLICATION_SPAN, 42)]));
    expect(metric.status).toBe("ok");
    expect(metric.stats?.median_ms).toBe(42);
  });

  it("marks policy overhead unsupported when the span is absent", () => {
    const metric = ingestPolicyOverhead(traceArtifact([]));
    expect(metric.status).toBe("unsupported");
  });

  it("reports malformed supplied traces as errors", () => {
    expect(ingestSandboxColdStart(null)).toMatchObject({ status: "error" });
    expect(ingestPolicyOverhead({ resource_spans: "nope" })).toMatchObject({
      status: "error",
    });
  });

  it("rejects artifacts from a foreign trace scope", () => {
    const artifact = traceArtifact([], { scopeName: "other.tool" });
    expect(ingestSandboxColdStart(artifact)).toMatchObject({ status: "error" });
  });

  it("rejects a failed onboard root", () => {
    const artifact = traceArtifact([traceSpan(SANDBOX_PHASE_SPAN, 2000)], {
      rootStatus: { code: "ERROR", message: "onboard failed" },
    });
    expect(ingestSandboxColdStart(artifact).status).toBe("error");
    expect(ingestPolicyOverhead(artifact).status).toBe("error");
  });

  it("rejects failed and invalid metric spans", () => {
    const failed = traceArtifact([
      traceSpan(SANDBOX_PHASE_SPAN, 2000, { status: { code: "ERROR" } }),
    ]);
    const negative = traceArtifact([traceSpan(POLICY_APPLICATION_SPAN, -25)]);
    const nonFinite = traceArtifact([traceSpan(POLICY_APPLICATION_SPAN, Number.POSITIVE_INFINITY)]);
    expect(ingestSandboxColdStart(failed)).toMatchObject({ status: "error" });
    expect(ingestPolicyOverhead(negative)).toMatchObject({ status: "error" });
    expect(ingestPolicyOverhead(nonFinite)).toMatchObject({ status: "error" });
  });

  it("rejects spans from a different trace identity", () => {
    const artifact = traceArtifact([
      traceSpan(SANDBOX_PHASE_SPAN, 2000, {
        trace_id: "ffffffffffffffffffffffffffffffff",
      }),
    ]);
    expect(ingestSandboxColdStart(artifact)).toMatchObject({ status: "error" });
  });

  it("rejects readiness durations larger than the enclosing sandbox phase", () => {
    const phase = traceSpan(SANDBOX_PHASE_SPAN, 1000);
    const readiness = traceSpan(SANDBOX_READINESS_SPAN, 1001, {
      parent_span_id: phase.span_id,
    });
    const artifact = traceArtifact([phase, readiness]);
    expect(ingestSandboxColdStart(artifact)).toMatchObject({ status: "error" });
  });

  it("rejects readiness spans outside the sandbox phase", () => {
    const artifact = traceArtifact([
      traceSpan(SANDBOX_PHASE_SPAN, 1000),
      traceSpan(SANDBOX_READINESS_SPAN, 500, { parent_span_id: ROOT_SPAN_ID }),
    ]);
    expect(ingestSandboxColdStart(artifact)).toMatchObject({ status: "error" });
  });
});

describe("unsupportedTraceMetric", () => {
  it.each([
    "sandbox-cold-start",
    "policy-shield-overhead",
  ] as const)("describes %s as unsupported with guidance", (id) => {
    const metric = unsupportedTraceMetric(id);
    expect(metric.id).toBe(id);
    expect(metric.status).toBe("unsupported");
    expect(metric.reason).toContain("NEMOCLAW_TRACE");
  });
});

describe("renderMarkdownReport", () => {
  const report: BenchReport = {
    schema_version: BENCH_SCHEMA_VERSION,
    generated_at: "2026-06-23T00:00:00.000Z",
    environment: {
      os: "Linux 6.0",
      arch: "x64",
      node: "v22.16.0",
      cpus: 8,
      cpu_model: "Test CPU",
      total_mem_gib: 32,
    },
    target: { base_url: "https://inference.local/v1", model: "test-model", api_key_present: true },
    metrics: [
      {
        id: "inference-round-trip",
        status: "ok",
        unit: "ms",
        source: "live-request",
        interpretation: "advisory-non-normative",
        samples: 3,
        stats: { min_ms: 10, median_ms: 20, p95_ms: 30, mean_ms: 20, max_ms: 30 },
      },
      unsupportedTraceMetric("sandbox-cold-start"),
    ],
  };

  it("includes environment, target, metrics, and the advisory disclaimer", () => {
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("# NemoClaw value benchmark");
    expect(markdown).toContain("test-model");
    expect(markdown).toContain("inference-round-trip");
    expect(markdown).toContain("advisory and non-normative");
    expect(markdown).toContain("Troubleshooting");
  });
});

describe("hasBlockingError", () => {
  it.each([
    { status: "ok" as const, expected: false },
    { status: "unsupported" as const, expected: false },
    { status: "error" as const, expected: true },
  ])("returns $expected for a $status metric", ({ status, expected }) => {
    const report: BenchReport = {
      schema_version: BENCH_SCHEMA_VERSION,
      generated_at: "2026-06-23T00:00:00.000Z",
      environment: {
        os: "Linux",
        arch: "x64",
        node: "v22.16.0",
        cpus: 1,
        cpu_model: "x",
        total_mem_gib: 1,
      },
      target: { base_url: "x", model: "x", api_key_present: false },
      metrics: [
        {
          id: "inference-round-trip",
          status,
          unit: "ms",
          source: "live-request",
          interpretation: "advisory-non-normative",
        },
      ],
    };
    expect(hasBlockingError(report)).toBe(expected);
  });
});
