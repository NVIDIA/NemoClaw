#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliTestTimingHints } from "./cli-test-timing-hints.mts";

type VitestFileResult = {
  name?: unknown;
  startTime?: unknown;
  endTime?: unknown;
};

type VitestReport = {
  testResults?: unknown;
};

export type TimingDrift = {
  file: string;
  hintMs?: number;
  kind: "faster" | "slower" | "unprofiled";
  observedMs: number;
};

const MINIMUM_DELTA_MS = 10_000;
const HINT_RATIO = 2;
const UNPROFILED_RATIO = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReportPath(name: string, repoRoot: string): string | undefined {
  const absoluteName = path.isAbsolute(name) ? path.resolve(name) : path.resolve(repoRoot, name);
  const relativeName = path.relative(repoRoot, absoluteName).split(path.sep).join("/");
  if (relativeName === "" || relativeName === ".." || relativeName.startsWith("../")) {
    return undefined;
  }
  return relativeName;
}

function parseFileResults(value: VitestReport, repoRoot: string): Map<string, number> {
  if (!Array.isArray(value.testResults)) {
    throw new Error("Invalid Vitest timing report");
  }

  const durations = new Map<string, number>();
  for (const candidate of value.testResults) {
    if (!isRecord(candidate)) continue;
    const { name, startTime, endTime } = candidate as VitestFileResult;
    if (
      typeof name !== "string" ||
      typeof startTime !== "number" ||
      !Number.isFinite(startTime) ||
      typeof endTime !== "number" ||
      !Number.isFinite(endTime) ||
      endTime < startTime
    ) {
      continue;
    }
    const file = normalizeReportPath(name, repoRoot);
    if (!file) continue;
    durations.set(file, Math.max(durations.get(file) ?? 0, Math.round(endTime - startTime)));
  }
  return durations;
}

export function findCliTestTimingDrift(
  reportValue: VitestReport,
  hintsValue: unknown,
  repoRoot: string,
): TimingDrift[] {
  const hints = parseCliTestTimingHints(hintsValue);
  const durations = parseFileResults(reportValue, path.resolve(repoRoot));
  const drift: TimingDrift[] = [];

  for (const [file, observedMs] of durations) {
    const hintMs = hints.files[file];
    if (hintMs === undefined) {
      if (observedMs >= hints.defaultDurationMs * UNPROFILED_RATIO) {
        drift.push({ file, kind: "unprofiled", observedMs });
      }
      continue;
    }

    const deltaMs = Math.abs(observedMs - hintMs);
    if (deltaMs < MINIMUM_DELTA_MS) continue;
    if (observedMs >= hintMs * HINT_RATIO) {
      drift.push({ file, hintMs, kind: "slower", observedMs });
    } else if (hintMs >= observedMs * HINT_RATIO) {
      drift.push({ file, hintMs, kind: "faster", observedMs });
    }
  }

  return drift.sort(
    (left, right) => right.observedMs - left.observedMs || left.file.localeCompare(right.file),
  );
}

function escapeWorkflowCommand(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function driftMessage(item: TimingDrift): string {
  if (item.kind === "unprofiled") {
    return `Unprofiled test file took ${formatDuration(item.observedMs)}; refresh CLI timing hints`;
  }
  return `Test file ran ${item.kind} than its timing hint: observed ${formatDuration(item.observedMs)}, hint ${formatDuration(item.hintMs!)}`;
}

export function formatCliTestTimingDriftSummary(drift: readonly TimingDrift[]): string {
  if (drift.length === 0) {
    return "### CLI test timing drift\n\nNo material timing-hint drift detected.\n";
  }
  const rows = drift
    .slice(0, 20)
    .map(
      (item) =>
        `| \`${item.file}\` | ${item.kind} | ${formatDuration(item.observedMs)} | ${item.hintMs === undefined ? "—" : formatDuration(item.hintMs)} |`,
    )
    .join("\n");
  return `### CLI test timing drift\n\n${drift.length} file(s) need a timing-hint refresh. This report is advisory.\n\n| File | Drift | Observed | Hint |\n| --- | --- | ---: | ---: |\n${rows}\n`;
}

function loadJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(path.resolve(file), "utf8"));
  } catch (cause) {
    throw new Error(`Failed to load ${file}`, { cause });
  }
}

function main(): void {
  const [reportFile, hintsFile] = process.argv.slice(2);
  if (!reportFile || !hintsFile) {
    throw new Error(
      "Usage: report-cli-test-timing-drift.mts <vitest-results.json> <cli-test-timing-hints.json>",
    );
  }

  const drift = findCliTestTimingDrift(
    loadJson(reportFile) as VitestReport,
    loadJson(hintsFile),
    process.cwd(),
  );
  const summary = formatCliTestTimingDriftSummary(drift);
  process.stdout.write(summary);
  for (const item of drift) {
    process.stdout.write(
      `::warning file=${escapeWorkflowCommand(item.file)},title=CLI test timing drift::${escapeWorkflowCommand(driftMessage(item))}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}
