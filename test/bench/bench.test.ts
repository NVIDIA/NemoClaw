// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BENCH_SCHEMA_VERSION,
  type BenchReport,
  buildChatCompletionsUrl,
  computeStats,
  hasBlockingError,
  ingestPolicyOverhead,
  ingestSandboxColdStart,
  redactBaseUrl,
  renderMarkdownReport,
  runInferenceRoundTrip,
  unsupportedTraceMetric,
} from "../../scripts/bench/lib";

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

function traceArtifact(spans: Array<{ name: string; duration_ms: number }>): unknown {
  return {
    resource_spans: [{ resource: { attributes: {} }, scope_spans: [{ scope: {}, spans }] }],
    summary: {},
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
});

describe("trace ingestion", () => {
  it("reads sandbox cold-start spans into a breakdown", () => {
    const metric = ingestSandboxColdStart(
      traceArtifact([
        { name: "nemoclaw.sandbox.create_stream", duration_ms: 1200 },
        { name: "nemoclaw.sandbox.readiness_wait", duration_ms: 800 },
      ]),
    );
    expect(metric.status).toBe("ok");
    expect(metric.breakdown).toEqual({ create_stream_ms: 1200, readiness_wait_ms: 800 });
    expect(metric.stats?.median_ms).toBe(2000);
  });

  it("marks sandbox cold-start unsupported when spans are absent", () => {
    const metric = ingestSandboxColdStart(traceArtifact([]));
    expect(metric.status).toBe("unsupported");
    expect(metric.source).toBe("none");
    expect(metric.reason).toContain("trace");
  });

  it("reads the policy.application span", () => {
    const metric = ingestPolicyOverhead(
      traceArtifact([{ name: "nemoclaw.policy.application", duration_ms: 42 }]),
    );
    expect(metric.status).toBe("ok");
    expect(metric.stats?.median_ms).toBe(42);
  });

  it("marks policy overhead unsupported when the span is absent", () => {
    const metric = ingestPolicyOverhead(traceArtifact([]));
    expect(metric.status).toBe("unsupported");
  });

  it("tolerates a malformed artifact without throwing", () => {
    expect(ingestSandboxColdStart(null).status).toBe("unsupported");
    expect(ingestPolicyOverhead({ resource_spans: "nope" }).status).toBe("unsupported");
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
