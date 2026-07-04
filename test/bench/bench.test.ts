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

const VALID_COMPLETION = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "PONG" } }],
});

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
    rootAttributes?: Record<string, unknown>;
  } = {},
): TraceArtifact {
  const root = traceSpan("nemoclaw.onboard", options.rootDurationMs ?? 3000, {
    span_id: ROOT_SPAN_ID,
    parent_span_id: undefined,
    status: options.rootStatus ?? { code: "OK" },
    attributes: {
      fresh: false,
      non_interactive: true,
      agent: "openclaw",
      ...options.rootAttributes,
    },
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

  it("appends the completion path before query parameters and removes fragments", () => {
    expect(buildChatCompletionsUrl("https://host.test/v1?tenant=alpha#ignored")).toBe(
      "https://host.test/v1/chat/completions?tenant=alpha",
    );
  });

  it.each([
    "http://localhost:8000/v1",
    "http://127.0.0.1:8000/v1",
    "http://[::1]:8000/v1",
  ])("allows a plaintext loopback endpoint: %s", (base) => {
    expect(buildChatCompletionsUrl(base)).toContain("/v1/chat/completions");
  });

  it("rejects non-HTTP and credential-bearing endpoints", () => {
    expect(() => buildChatCompletionsUrl("file:///tmp/inference")).toThrow("HTTP or HTTPS");
    expect(() => buildChatCompletionsUrl("http://example.com/v1")).toThrow(
      "must use HTTPS unless the host is loopback",
    );
    expect(() => buildChatCompletionsUrl("http://127.evil/v1")).toThrow(
      "must use HTTPS unless the host is loopback",
    );
    expect(() => buildChatCompletionsUrl("https://user:pass@host.test/v1")).toThrow(
      "must not include username or password",
    );
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
      "https://inference.local/v1?api_key=clear-api-secret&password=clear-password&custom=clear-query-secret",
    );
    expect(redacted).not.toContain("clear-api-secret");
    expect(redacted).not.toContain("clear-password");
    expect(redacted).not.toContain("clear-query-secret");
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
      fetchImpl: fakeFetch(200, VALID_COMPLETION),
      clock: queueClock([0, 10, 100, 130]),
    });
    expect(metric.status).toBe("ok");
    expect(metric.samples).toBe(2);
    expect(metric.stats?.min_ms).toBe(10);
    expect(metric.stats?.max_ms).toBe(30);
    expect(metric.source).toBe("live-request");
  });

  it("returns an error metric on a non-2xx response", async () => {
    const echoedSecret = inferenceOptionsBase.apiKey;
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl: fakeFetch(500, `echoed prompt and credential: ${echoedSecret}`),
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("error");
    expect(metric.reason).toContain("HTTP 500");
    expect(metric.reason).not.toContain(echoedSecret);
    expect(metric.reason).not.toContain("echoed prompt");
  });

  it("rejects an HTTP 2xx body that is not a chat completion", async () => {
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl: fakeFetch(200, "{}"),
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("error");
    expect(metric.reason).toContain("not an OpenAI-compatible chat completion");
  });

  it.each([
    { message: { content: null, reasoning_content: "reasoning output" } },
    { message: { content: "", reasoning: "reasoning output" } },
    { text: "legacy completion output" },
  ])("accepts compatible reasoning or text output: $message $text", async (choice) => {
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl: fakeFetch(200, JSON.stringify({ choices: [choice] })),
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("ok");
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
    expect(metric.reason).toBe("Error: request failed");
  });

  it("rejects remote plaintext before sending the API key", async () => {
    let requestCount = 0;
    const fetchImpl = (async () => {
      requestCount += 1;
      return { ok: true, status: 200, text: async () => VALID_COMPLETION } as Response;
    }) as typeof fetch;
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      baseUrl: "http://example.com/v1",
      samples: 1,
      fetchImpl,
      clock: queueClock([0, 5]),
    });
    expect(metric.status).toBe("error");
    expect(metric.reason).toContain("must use HTTPS unless the host is loopback");
    expect(requestCount).toBe(0);
  });

  it("does not copy a credential-bearing fetch error into the report", async () => {
    const throwingFetch = (async () => {
      throw new TypeError(
        "request to https://user:clear-password@host/v1?secret=clear-query-secret failed",
      );
    }) as unknown as typeof fetch;
    const metric = await runInferenceRoundTrip({
      ...inferenceOptionsBase,
      samples: 1,
      fetchImpl: throwingFetch,
      clock: queueClock([0, 5]),
    });
    expect(metric.reason).toBe("TypeError: request failed");
    expect(metric.reason).not.toContain("clear-password");
    expect(metric.reason).not.toContain("clear-query-secret");
  });

  it("refuses redirects so prompts stay on the configured origin", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestInit = init;
      return { ok: true, status: 200, text: async () => VALID_COMPLETION } as Response;
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
    // This span exists only around createSandbox(); an initial cold creation can
    // have fresh=false because --fresh controls forced recreation.
    expect(metric.context?.fresh).toBe(false);
  });

  it("marks sandbox cold-start unsupported when spans are absent", () => {
    const metric = ingestSandboxColdStart(traceArtifact([]));
    expect(metric.status).toBe("unsupported");
    expect(metric.source).toBe("none");
    expect(metric.reason).toContain("trace");
  });

  it("does not present policy application setup time as request-path overhead", () => {
    const metric = ingestPolicyOverhead(
      traceArtifact([
        traceSpan(POLICY_APPLICATION_SPAN, 42, { attributes: { provider: "nvidia" } }),
      ]),
    );
    expect(metric.status).toBe("unsupported");
    expect(metric.stats).toBeUndefined();
    expect(metric.reason).toContain("not request-path shield overhead");
    expect(metric.context).toMatchObject({
      provider: "nvidia",
      agent: "openclaw",
      non_interactive: true,
      fresh: false,
    });
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

  it("does not echo untrusted root or metric status text into report reasons", () => {
    const leakedStatus = { code: "arbitrary-trace-secret" } as unknown as TraceSpan["status"];
    const metrics = [
      ingestSandboxColdStart(traceArtifact([], { rootStatus: leakedStatus })),
      ingestSandboxColdStart(
        traceArtifact([
          traceSpan(SANDBOX_PHASE_SPAN, 2000, {
            status: leakedStatus,
          }),
        ]),
      ),
    ];
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain("arbitrary-trace-secret");
    expect(metrics[0].reason).toContain("status is missing or not OK");
    expect(metrics[1].reason).toContain("status is missing or not OK");
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

  it("rejects a sandbox phase longer than the onboard root", () => {
    const artifact = traceArtifact([traceSpan(SANDBOX_PHASE_SPAN, 3001)]);
    expect(ingestSandboxColdStart(artifact)).toMatchObject({ status: "error" });
  });

  it("rejects foreign and impossible policy spans", () => {
    const foreign = traceArtifact([
      traceSpan(POLICY_APPLICATION_SPAN, 42, { parent_span_id: "foreign" }),
    ]);
    const tooLong = traceArtifact([traceSpan(POLICY_APPLICATION_SPAN, 3001)]);
    expect(ingestPolicyOverhead(foreign)).toMatchObject({ status: "error" });
    expect(ingestPolicyOverhead(tooLong)).toMatchObject({ status: "error" });
  });

  it("marks interactive policy timing unsupported because it can include human think time", () => {
    const artifact = traceArtifact([traceSpan(POLICY_APPLICATION_SPAN, 42)], {
      rootAttributes: { non_interactive: false },
    });
    const metric = ingestPolicyOverhead(artifact);
    expect(metric).toMatchObject({ status: "unsupported", source: "none" });
    expect(metric.reason).toContain("human think time");
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
