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
  RUNNER_COMPARISON_SUMMARY_FILE,
  renderRunnerComparisonSample,
  renderRunnerComparisonSummary,
  summarizeRunnerComparison,
} from "./runner-comparison-core.mts";

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

export function initializeRunnerComparison(): void {
  const paths = comparisonPaths();
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const sample = collectRunnerComparisonSample(comparisonIdentity(), WORKSPACE_ROOT);
  createPrivateRegularFile(paths.ledger, `${renderRunnerComparisonSample(sample)}\n`);
  console.log(`Initialized runner comparison telemetry for ${sample.target}`);
}

export function finalizeRunnerComparison(): void {
  const paths = comparisonPaths();
  const contents = readPrivateRegularFile(paths.ledger, {
    maxBytes: RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  });
  if (contents === null) throw new Error("runner comparison ledger could not be read");
  const initialSamples = parseRunnerComparisonLedger(contents);
  if (initialSamples.length !== 1) {
    throw new Error("runner comparison finalization requires exactly one initial sample");
  }
  const finalSample = collectRunnerComparisonSample(comparisonIdentity(), WORKSPACE_ROOT);
  const finalLine = `${renderRunnerComparisonSample(finalSample)}\n`;
  const samples = parseRunnerComparisonLedger(`${contents}${finalLine}`);
  const summary = summarizeRunnerComparison(samples);
  appendPrivateRegularFile(paths.ledger, finalLine, {
    maxBytes: RUNNER_COMPARISON_LEDGER_MAX_BYTES,
  });
  createPrivateRegularFile(paths.summary, renderRunnerComparisonSummary(summary));
  console.log(
    `Finalized runner comparison telemetry for ${summary.target} (${summary.durationMs} ms)`,
  );
}

function main(): number {
  const [mode] = process.argv.slice(2);
  if (mode === "initialize") {
    initializeRunnerComparison();
    return 0;
  }
  if (mode === "finalize") {
    finalizeRunnerComparison();
    return 0;
  }
  console.error("usage: runner-comparison.mts <initialize|finalize>");
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
