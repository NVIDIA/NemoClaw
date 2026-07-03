// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Core, side-effect-free building blocks for the NemoClaw value benchmark harness
// (issue #5604). The CLI entry point lives in run.ts; everything here is pure or
// dependency-injected so it can be unit tested without a live sandbox or network.

import { isIP } from "node:net";
import os from "node:os";

import { redactFull } from "../../src/lib/security/redact";

export {
  ingestPolicyOverhead,
  ingestSandboxColdStart,
  POLICY_APPLICATION_SPAN,
  SANDBOX_PHASE_SPAN,
  SANDBOX_READINESS_SPAN,
} from "./trace-ingest";

export const BENCH_SCHEMA_VERSION = "nemoclaw.bench.v1" as const;

export type MetricId = "inference-round-trip" | "sandbox-cold-start" | "policy-shield-overhead";
export type MetricStatus = "ok" | "unsupported" | "error";
export type MetricSource = "live-request" | "trace-artifact" | "none";

export interface LatencyStats {
  min_ms: number;
  median_ms: number;
  p95_ms: number;
  mean_ms: number;
  max_ms: number;
}

export interface BenchMetric {
  id: MetricId;
  status: MetricStatus;
  unit: "ms";
  source: MetricSource;
  // Pass/warn/fail interpretation is deliberately advisory until owners approve
  // normative thresholds (issue #5604 / #3776 non-goal).
  interpretation: "advisory-non-normative";
  samples?: number;
  stats?: LatencyStats;
  breakdown?: Record<string, number>;
  context?: BenchMetricContext;
  reason?: string;
}

export interface BenchMetricContext {
  provider?: string;
  model?: string;
  agent?: string;
  non_interactive?: boolean;
  fresh?: boolean;
}

export interface BenchEnvironment {
  os: string;
  arch: string;
  node: string;
  cpus: number;
  cpu_model: string;
  total_mem_gib: number;
}

export interface BenchTarget {
  base_url: string;
  model: string;
  api_key_present: boolean;
}

export interface BenchReport {
  schema_version: typeof BENCH_SCHEMA_VERSION;
  generated_at: string;
  environment: BenchEnvironment;
  target: BenchTarget;
  metrics: BenchMetric[];
}

export function buildBenchTarget(
  baseUrl: string | undefined,
  model: string | undefined,
  apiKeyPresent: boolean,
  knownSecrets: readonly string[] = [],
): BenchTarget {
  return {
    base_url: baseUrl ? redactBaseUrl(baseUrl, knownSecrets) : "(none)",
    model: scrubSecrets(model ?? "(none)", knownSecrets),
    api_key_present: apiKeyPresent,
  };
}

export function computeStats(samplesMs: readonly number[]): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { min_ms: 0, median_ms: 0, p95_ms: 0, mean_ms: 0, max_ms: 0 };
  }
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min_ms: round3(sorted[0]),
    median_ms: round3(percentile(sorted, 50)),
    p95_ms: round3(percentile(sorted, 95)),
    mean_ms: round3(sum / n),
    max_ms: round3(sorted[n - 1]),
  };
}

// Nearest-rank percentile over an already-sorted ascending array.
function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sortedAsc[index];
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function collectEnvironment(): BenchEnvironment {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    cpus: cpus.length,
    cpu_model: cpus[0]?.model?.trim() ?? "unknown",
    total_mem_gib: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
  };
}

// Drop URL userinfo and scrub any secret-shaped substring so the report is safe
// to share. Never let a credential reach JSON/Markdown output.
export function redactBaseUrl(rawUrl: string, knownSecrets: readonly string[] = []): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "(invalid URL)";
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      // Query values are not needed to identify a benchmark target and may use
      // provider-specific names that a key-name allowlist cannot recognize.
      url.searchParams.set(key, "<REDACTED>");
    }
    url.hash = "";
    return scrubSecrets(url.toString(), knownSecrets);
  } catch {
    return "(invalid URL)";
  }
}

export function scrubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let scrubbed = text;
  for (const secret of knownSecrets) {
    if (secret.length > 0) scrubbed = scrubbed.replaceAll(secret, "<REDACTED>");
  }
  return redactFull(scrubbed);
}

export interface InferenceRoundTripOptions {
  fetchImpl: typeof fetch;
  clock: () => number;
  baseUrl: string;
  apiKey: string;
  model: string;
  samples: number;
  warmup: number;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

interface ChatRequestResult {
  ok: boolean;
  status: number;
  detail: string;
}

class InvalidBenchmarkEndpointError extends Error {}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new InvalidBenchmarkEndpointError("base URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidBenchmarkEndpointError("base URL must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new InvalidBenchmarkEndpointError("base URL must use HTTPS unless the host is loopback");
  }
  if (url.username || url.password) {
    throw new InvalidBenchmarkEndpointError("base URL must not include username or password");
  }
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidChatCompletion(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return false;
  }
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice)) return false;
  const message = isRecord(firstChoice.message) ? firstChoice.message : {};
  return [message.content, message.reasoning_content, message.reasoning, firstChoice.text].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request has already failed; body cleanup must not replace that signal.
  }
}

async function postChatCompletion(options: InferenceRoundTripOptions): Promise<ChatRequestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(buildChatCompletionsUrl(options.baseUrl), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: options.prompt }],
        max_tokens: options.maxTokens,
        stream: false,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Never copy a remote error body into a shareable report. Providers may
      // echo the prompt, model, Authorization header, or endpoint credentials.
      await discardResponseBody(response);
      return { ok: false, status: response.status, detail: "remote error body omitted" };
    }

    // Drain and validate the body so the timing reflects a real OpenAI-compatible
    // completion rather than headers or an arbitrary HTTP 2xx response.
    const bodyText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return { ok: false, status: response.status, detail: "response was not valid JSON" };
    }
    if (!isValidChatCompletion(payload)) {
      return {
        ok: false,
        status: response.status,
        detail: "response was not an OpenAI-compatible chat completion",
      };
    }
    return {
      ok: true,
      status: response.status,
      detail: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runInferenceRoundTrip(
  options: InferenceRoundTripOptions,
): Promise<BenchMetric> {
  const base: BenchMetric = {
    id: "inference-round-trip",
    status: "ok",
    unit: "ms",
    source: "live-request",
    interpretation: "advisory-non-normative",
  };

  try {
    for (let i = 0; i < options.warmup; i += 1) {
      const result = await postChatCompletion(options);
      if (!result.ok) {
        return {
          ...base,
          status: "error",
          reason: `warm-up request ${i + 1} failed (HTTP ${result.status}): ${result.detail}`,
        };
      }
    }

    const samplesMs: number[] = [];
    for (let i = 0; i < options.samples; i += 1) {
      const startedAt = options.clock();
      const result = await postChatCompletion(options);
      const elapsed = options.clock() - startedAt;
      if (!result.ok) {
        return {
          ...base,
          status: "error",
          reason: `request ${i + 1} failed (HTTP ${result.status}): ${result.detail}`,
        };
      }
      samplesMs.push(elapsed);
    }

    return { ...base, samples: samplesMs.length, stats: computeStats(samplesMs) };
  } catch (error) {
    return { ...base, status: "error", reason: describeRequestError(error, options.timeoutMs) };
  }
}

function describeRequestError(error: unknown, timeoutMs: number): string {
  if (error instanceof InvalidBenchmarkEndpointError) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return `request timed out after ${timeoutMs} ms`;
  }
  return error instanceof Error ? `${error.name}: request failed` : "request failed";
}

export function unsupportedTraceMetric(id: MetricId): BenchMetric {
  return {
    id,
    status: "unsupported",
    unit: "ms",
    source: "none",
    interpretation: "advisory-non-normative",
    reason:
      "no onboard trace provided; set NEMOCLAW_TRACE=1 during `nemoclaw onboard`, then pass --trace <file>",
  };
}

// --- Reporting ---

export function renderMarkdownReport(report: BenchReport): string {
  const env = report.environment;
  const lines: string[] = [
    "# NemoClaw value benchmark",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Environment",
    "",
    `- OS: ${env.os} (${env.arch})`,
    `- Node: ${env.node}`,
    `- CPU: ${env.cpu_model} x${env.cpus}`,
    `- Memory: ${env.total_mem_gib} GiB`,
    "",
    "## Inference target",
    "",
    `- Endpoint: ${report.target.base_url}`,
    `- Model: ${report.target.model}`,
    `- API key present: ${report.target.api_key_present ? "yes" : "no"}`,
    "",
    "## Metrics",
    "",
    "| Metric | Status | Source | min | median | p95 | mean | max |",
    "|--------|--------|--------|-----|--------|-----|------|-----|",
  ];

  for (const metric of report.metrics) {
    lines.push(renderMetricRow(metric));
  }

  lines.push("");
  for (const metric of report.metrics) {
    const note = metricNote(metric);
    if (note) lines.push(note);
  }

  lines.push(
    "",
    "> Interpretation is **advisory and non-normative**: these timings describe this",
    "> machine and provider only. NemoClaw does not ship owner-approved pass/warn/fail",
    "> thresholds yet (see issue #3776), so use the numbers to compare runs, not to gate.",
    "",
    "## Troubleshooting",
    "",
    "- High inference latency: check `nemoclaw <name> status` for the active provider and",
    "  the `Inference` line; for local Ollama/vLLM confirm the backend is reachable.",
    "- Missing sandbox/policy timings: re-run onboarding with `NEMOCLAW_TRACE=1` and pass",
    "  the written trace file with `--trace`.",
    "- See docs/inference/use-local-inference and docs/reference/troubleshooting.",
    "",
  );

  return scrubSecrets(`${lines.join("\n")}`);
}

function renderMetricRow(metric: BenchMetric): string {
  const stats = metric.stats;
  const cells = stats
    ? [stats.min_ms, stats.median_ms, stats.p95_ms, stats.mean_ms, stats.max_ms].map(fmtMs)
    : ["-", "-", "-", "-", "-"];
  return `| ${metric.id} | ${metric.status} | ${metric.source} | ${cells.join(" | ")} |`;
}

function metricNote(metric: BenchMetric): string {
  const parts: string[] = [];
  if (metric.reason) parts.push(`- **${metric.id}**: ${metric.reason}`);
  if (metric.breakdown) {
    const detail = Object.entries(metric.breakdown)
      .map(([key, value]) => `${key}=${fmtMs(value)}`)
      .join(", ");
    parts.push(`- **${metric.id}** breakdown: ${detail}`);
  }
  if (metric.context) {
    const detail = Object.entries(metric.context)
      .map(([key, value]) => `${key}=${inlineMarkdownValue(String(value))}`)
      .join(", ");
    parts.push(`- **${metric.id}** context: ${detail}`);
  }
  return parts.join("\n");
}

function inlineMarkdownValue(value: string): string {
  return value.replace(/[\r\n|]+/g, " ").trim();
}

function fmtMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

export function hasBlockingError(report: BenchReport): boolean {
  return report.metrics.some((metric) => metric.status === "error");
}
