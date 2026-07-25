// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendPrivateRegularFile,
  createPrivateRegularFile,
  readPrivateRegularFile,
} from "./private-file.mts";
import {
  collectRunnerComparisonSample,
  parseRunnerComparisonLedger,
  RUNNER_COMPARISON_LEDGER_FILE,
  RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  RUNNER_COMPARISON_MAX_SAMPLES,
  RUNNER_COMPARISON_SAMPLE_LINE_PREFIX,
  RUNNER_COMPARISON_SUMMARY_FILE,
  type RunnerComparisonSample,
  type RunnerComparisonSampleKind,
  renderRunnerComparisonSample,
  renderRunnerComparisonSummary,
  summarizeRunnerComparison,
} from "./runner-comparison-core.mts";
import { collectResourceSnapshot, type ResourceSnapshotProfile } from "./runner-pressure.mts";
import type { ResourceSnapshot } from "./runner-pressure-core.mts";

const WORKSPACE_ROOT = path.resolve(process.cwd());

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function artifactDirectory(): string {
  const resolved = path.resolve(WORKSPACE_ROOT, requiredEnvironment("E2E_ARTIFACT_DIR"));
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) {
    throw new Error("E2E_ARTIFACT_DIR must stay inside the checked-out workspace");
  }
  return resolved;
}

function comparisonIdentity(): { target: string; shard: string | null } {
  return {
    target: requiredEnvironment("E2E_TARGET_ID"),
    shard: process.env.NEMOCLAW_E2E_SHARD || null,
  };
}

function comparisonPaths(): { ledger: string; summary: string; directory: string } {
  const directory = artifactDirectory();
  return {
    directory,
    ledger: path.join(directory, RUNNER_COMPARISON_LEDGER_FILE),
    summary: path.join(directory, RUNNER_COMPARISON_SUMMARY_FILE),
  };
}

type SnapshotCollector = (phase: string, profile: ResourceSnapshotProfile) => ResourceSnapshot;

function collectComparisonSample(
  sequence: number,
  kind: RunnerComparisonSampleKind,
  phase: string | null,
  collect: SnapshotCollector,
) {
  const profile: ResourceSnapshotProfile =
    kind === "initialize" || kind === "finalize"
      ? "comparison-endpoint"
      : kind === "periodic"
        ? "comparison-periodic"
        : "comparison-phase";
  const snapshot = collect(phase ?? kind, profile);
  return collectRunnerComparisonSample(comparisonIdentity(), { sequence, kind, phase }, snapshot);
}

function logSample(line: string): void {
  console.log(`${RUNNER_COMPARISON_SAMPLE_LINE_PREFIX}${line}`);
}

export function initializeRunnerComparison(
  collect: SnapshotCollector = collectResourceSnapshot,
): void {
  const paths = comparisonPaths();
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const sample = collectComparisonSample(0, "initialize", null, collect);
  const line = renderRunnerComparisonSample(sample);
  createPrivateRegularFile(paths.ledger, `${line}\n`);
  logSample(line);
  console.log(`Initialized runner comparison telemetry for ${sample.target}`);
}

/**
 * Append one diagnostic sample. Missing, historical, finalized, or full
 * ledgers disable further best-effort sampling without creating a new ledger.
 */
export function appendRunnerComparisonSample(
  phase: string,
  kind: Extract<RunnerComparisonSampleKind, "periodic" | "scenario-start" | "phase">,
  collect: SnapshotCollector = collectResourceSnapshot,
): boolean {
  const paths = comparisonPaths();
  const contents = readPrivateRegularFile(paths.ledger, {
    allowMissing: true,
    maxBytes: RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  });
  if (contents === null) return false;
  const samples = parseRunnerComparisonLedger(contents);
  const current = samples[0]?.v === 2 ? (samples as RunnerComparisonSample[]) : null;
  if (
    current === null ||
    current.at(-1)?.kind === "finalize" ||
    samples.length >= RUNNER_COMPARISON_MAX_SAMPLES - 1
  ) {
    return false;
  }
  const sample = collectComparisonSample(samples.length, kind, phase, collect);
  const line = renderRunnerComparisonSample(sample);
  parseRunnerComparisonLedger(`${contents}${line}\n`);
  appendPrivateRegularFile(paths.ledger, `${line}\n`, {
    maxBytes: RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  });
  logSample(line);
  return true;
}

export function finalizeRunnerComparison(
  collect: SnapshotCollector = collectResourceSnapshot,
): void {
  const paths = comparisonPaths();
  const contents = readPrivateRegularFile(paths.ledger, {
    maxBytes: RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  });
  if (contents === null) throw new Error("runner comparison ledger could not be read");
  const initialSamples = parseRunnerComparisonLedger(contents);
  if (initialSamples[0]?.v !== 2) {
    throw new Error("runner comparison v1 ledgers are read-only and cannot be extended");
  }
  const current = initialSamples as RunnerComparisonSample[];
  if (
    current.at(-1)?.kind === "finalize" ||
    initialSamples.length >= RUNNER_COMPARISON_MAX_SAMPLES
  ) {
    throw new Error("runner comparison ledger cannot accept a final sample");
  }
  const finalSample = collectComparisonSample(initialSamples.length, "finalize", null, collect);
  const renderedFinalSample = renderRunnerComparisonSample(finalSample);
  const finalLine = `${renderedFinalSample}\n`;
  const samples = parseRunnerComparisonLedger(`${contents}${finalLine}`);
  const summary = summarizeRunnerComparison(samples);
  appendPrivateRegularFile(paths.ledger, finalLine, {
    maxBytes: RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  });
  createPrivateRegularFile(paths.summary, renderRunnerComparisonSummary(summary));
  logSample(renderedFinalSample);
  console.log(
    `Finalized runner comparison telemetry for ${summary.target} (${summary.durationMs} ms)`,
  );
}

function main(): number {
  const [mode, kind, phase] = process.argv.slice(2);
  if (mode === "initialize") {
    initializeRunnerComparison();
    return 0;
  }
  if (mode === "finalize") {
    finalizeRunnerComparison();
    return 0;
  }
  if (
    mode === "sample" &&
    (kind === "periodic" || kind === "scenario-start" || kind === "phase") &&
    phase
  ) {
    return appendRunnerComparisonSample(phase, kind) ? 0 : 1;
  }
  console.error(
    "usage: runner-comparison.mts <initialize|finalize|sample <periodic|scenario-start|phase> <phase>>",
  );
  return 2;
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
