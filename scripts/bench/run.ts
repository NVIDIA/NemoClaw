// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// NemoClaw value benchmark harness (issue #5604).
//
// Measures core "is NemoClaw fast enough on this machine" signals and emits a
// machine-readable JSON document plus a Markdown value report. It only contacts
// the inference endpoint you configure and never posts results anywhere.
//
//   tsx scripts/bench/run.ts --base-url <url> --model <model> [--json out.json]
//   tsx scripts/bench/run.ts --trace .e2e/traces/onboard.json --base-url ... --model ...
//
// The API key is read from an environment variable (default OPENAI_API_KEY or
// NVIDIA_INFERENCE_API_KEY), never from a command-line flag.

import fs from "node:fs";

import {
  BENCH_SCHEMA_VERSION,
  type BenchMetric,
  type BenchReport,
  buildBenchTarget,
  collectEnvironment,
  hasBlockingError,
  ingestPolicyOverhead,
  ingestSandboxColdStart,
  renderMarkdownReport,
  runInferenceRoundTrip,
  unsupportedTraceMetric,
} from "./lib";

interface CliOptions {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  samples: number;
  warmup: number;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  tracePath?: string;
  jsonPath?: string;
  reportPath?: string;
  runInference: boolean;
}

const USAGE = `NemoClaw value benchmark (issue #5604)

Usage:
  tsx scripts/bench/run.ts --base-url <url> --model <model> [options]

Options:
  --base-url <url>      OpenAI-compatible base URL (or env OPENAI_BASE_URL / NEMOCLAW_BENCH_BASE_URL)
  --model <name>        Model id to send (or env OPENAI_MODEL / NEMOCLAW_BENCH_MODEL)
  --api-key-env <NAME>  API key env: OPENAI_API_KEY or NVIDIA_INFERENCE_API_KEY (checked in that order by default)
  --samples <n>         Timed inference requests (default 5)
  --warmup <n>          Untimed warm-up requests (default 1)
  --prompt <text>       Prompt to send (default: a tiny deterministic prompt)
  --max-tokens <n>      max_tokens per request (default 16)
  --timeout-ms <n>      Per-request timeout in ms (default 60000)
  --trace <file>        Onboard trace artifact for sandbox cold-start + policy overhead
  --no-inference        Skip the live inference round-trip metric
  --json <file>         Write machine-readable JSON to <file> ('-' for stdout)
  --report <file>       Also write the Markdown report to <file>
  -h, --help            Show this help

The harness sends requests only to the configured endpoint and never uploads results.`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: process.env.OPENAI_BASE_URL ?? process.env.NEMOCLAW_BENCH_BASE_URL,
    model: process.env.OPENAI_MODEL ?? process.env.NEMOCLAW_BENCH_MODEL,
    samples: 5,
    warmup: 1,
    prompt: "Reply with exactly one word: PONG",
    maxTokens: 16,
    timeoutMs: 60_000,
    runInference: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      return takeValue(argv, i, arg);
    };
    switch (arg) {
      case "--base-url":
        options.baseUrl = value();
        break;
      case "--model":
        options.model = value();
        break;
      case "--api-key-env":
        options.apiKeyEnv = value();
        break;
      case "--samples":
        options.samples = toPositiveInt(value(), arg);
        break;
      case "--warmup":
        options.warmup = toNonNegativeInt(value(), arg);
        break;
      case "--prompt":
        options.prompt = value();
        break;
      case "--max-tokens":
        options.maxTokens = toPositiveInt(value(), arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = toPositiveInt(value(), arg);
        break;
      case "--trace":
        options.tracePath = value();
        break;
      case "--json":
        options.jsonPath = value();
        break;
      case "--report":
        options.reportPath = value();
        break;
      case "--no-inference":
        options.runInference = false;
        break;
      case "-h":
      case "--help":
        fs.writeSync(1, `${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return options;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || (value.startsWith("--") && value.length > 2)) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function toPositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function toNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

function resolveApiKey(envName?: string): { name: string; value: string | undefined } {
  const allowedNames = ["OPENAI_API_KEY", "NVIDIA_INFERENCE_API_KEY"] as const;
  if (envName && !allowedNames.includes(envName as (typeof allowedNames)[number])) {
    throw new Error("--api-key-env must be OPENAI_API_KEY or NVIDIA_INFERENCE_API_KEY");
  }
  const candidates = envName ? [envName] : [...allowedNames];
  for (const name of candidates) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return { name: candidates[0], value: undefined };
}

function readTraceArtifact(tracePath: string): unknown {
  const raw = fs.readFileSync(tracePath, "utf8");
  return JSON.parse(raw);
}

async function buildReport(options: CliOptions): Promise<BenchReport> {
  const metrics: BenchMetric[] = [];
  const apiKey = resolveApiKey(options.apiKeyEnv);

  if (options.runInference) {
    metrics.push(
      await runInferenceRoundTrip({
        fetchImpl: fetch,
        clock: () => performance.now(),
        baseUrl: options.baseUrl as string,
        apiKey: apiKey.value as string,
        model: options.model as string,
        samples: options.samples,
        warmup: options.warmup,
        prompt: options.prompt,
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs,
      }),
    );
  }

  if (options.tracePath) {
    const artifact = readTraceArtifact(options.tracePath);
    metrics.push(ingestSandboxColdStart(artifact));
    metrics.push(ingestPolicyOverhead(artifact));
  } else {
    metrics.push(unsupportedTraceMetric("sandbox-cold-start"));
    metrics.push(unsupportedTraceMetric("policy-shield-overhead"));
  }

  return {
    schema_version: BENCH_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    environment: collectEnvironment(),
    target: buildBenchTarget(
      options.baseUrl,
      options.model,
      apiKey.value !== undefined,
      apiKey.value ? [apiKey.value] : [],
    ),
    metrics,
  };
}

function preflight(options: CliOptions): void {
  const missing: string[] = [];
  if (options.runInference) {
    const apiKey = resolveApiKey(options.apiKeyEnv);
    if (!options.baseUrl) missing.push("--base-url (or OPENAI_BASE_URL / NEMOCLAW_BENCH_BASE_URL)");
    if (!options.model) missing.push("--model (or OPENAI_MODEL / NEMOCLAW_BENCH_MODEL)");
    if (!apiKey.value) missing.push(`API key in env ${apiKey.name}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Cannot run the inference benchmark, missing:\n  - ${missing.join("\n  - ")}\n\n` +
        `Provide them, or pass --no-inference to run only trace-based metrics.\n\n${USAGE}`,
    );
  }
  if (!options.runInference && !options.tracePath) {
    throw new Error(
      `Nothing to benchmark: pass an inference target or --trace <file>.\n\n${USAGE}`,
    );
  }
}

function writeOutputs(report: BenchReport, options: CliOptions): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdownReport(report);

  if (options.jsonPath === "-") {
    process.stdout.write(json);
  } else if (options.jsonPath) {
    fs.writeFileSync(options.jsonPath, json);
    process.stderr.write(`Wrote JSON to ${options.jsonPath}\n`);
  }

  if (options.reportPath) {
    fs.writeFileSync(options.reportPath, `${markdown}\n`);
    process.stderr.write(`Wrote Markdown report to ${options.reportPath}\n`);
  }

  if (options.jsonPath !== "-") {
    process.stdout.write(`${markdown}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  preflight(options);
  const report = await buildReport(options);
  writeOutputs(report, options);
  process.exitCode = hasBlockingError(report) ? 1 : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
