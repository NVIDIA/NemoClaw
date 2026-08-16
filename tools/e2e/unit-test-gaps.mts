// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  buildUnitGapReport,
  type E2ERunRecord,
  formatUnitGapReport,
  type RunLogEvidence,
} from "./unit-test-gaps-core.mts";

const execFileAsync = promisify(execFile);
const NEMOCLAW_REPOSITORY = "NVIDIA/NemoClaw";
const DEFAULT_WORKFLOWS = ["e2e.yaml", "portable-profile-e2e.yaml"];
const MAX_GH_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_RUNS_PER_WORKFLOW = 1000;
const DEFAULT_CONCURRENCY = 6;

interface Options {
  days: number;
  jsonOutput: string;
  logsDir?: string;
  output: string;
  runsFile?: string;
  since?: string;
  workflows: string[];
}

function usage(): never {
  throw new Error(
    "usage: unit-test-gaps.mts [--days 7 | --since YYYY-MM-DD] --output REPORT.md --json-output REPORT.json [--workflow FILE] [--runs-file RUNS.json --logs-dir DIR]",
  );
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 90) {
    throw new Error(`${flag} must be an integer from 1 through 90`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { days: 7, jsonOutput: "", output: "", workflows: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--days" && value !== undefined) {
      options.days = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--since" && value !== undefined) {
      options.since = value;
      index += 1;
    } else if (flag === "--output" && value !== undefined) {
      options.output = value;
      index += 1;
    } else if (flag === "--json-output" && value !== undefined) {
      options.jsonOutput = value;
      index += 1;
    } else if (flag === "--workflow" && value !== undefined) {
      options.workflows.push(value);
      index += 1;
    } else if (flag === "--runs-file" && value !== undefined) {
      options.runsFile = value;
      index += 1;
    } else if (flag === "--logs-dir" && value !== undefined) {
      options.logsDir = value;
      index += 1;
    } else {
      usage();
    }
  }
  if (options.output.length === 0 || options.jsonOutput.length === 0) usage();
  if ((options.runsFile === undefined) !== (options.logsDir === undefined)) usage();
  if (options.workflows.length === 0) options.workflows = [...DEFAULT_WORKFLOWS];
  return options;
}

export function rollingRange(days: number, now = new Date()): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
  };
}

function rangeFromOptions(options: Options, now = new Date()): { from: string; to: string } {
  if (options.since === undefined) return rollingRange(options.days, now);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(options.since) ||
    Number.isNaN(Date.parse(`${options.since}T00:00:00Z`))
  ) {
    throw new Error("--since must use YYYY-MM-DD");
  }
  return { from: `${options.since}T00:00:00.000Z`, to: now.toISOString() };
}

function normalizeRun(value: unknown): E2ERunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned a malformed run record");
  }
  const run = value as Record<string, unknown>;
  const requiredStrings = [
    "conclusion",
    "createdAt",
    "event",
    "headBranch",
    "headSha",
    "name",
    "status",
    "url",
  ] as const;
  if (
    !Number.isSafeInteger(run.attempt) ||
    !Number.isSafeInteger(run.databaseId) ||
    (run.databaseId as number) < 1 ||
    requiredStrings.some((key) => typeof run[key] !== "string")
  ) {
    throw new Error("GitHub returned a malformed run record");
  }
  return run as unknown as E2ERunRecord;
}

async function gh(args: readonly string[]): Promise<string> {
  const result = await execFileAsync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: MAX_GH_BUFFER_BYTES,
    timeout: 10 * 60_000,
  });
  return result.stdout;
}

export function requireCompleteRunSelection(workflow: string, runCount: number): void {
  if (runCount < MAX_RUNS_PER_WORKFLOW) return;
  throw new Error(
    `${workflow} reached the ${String(MAX_RUNS_PER_WORKFLOW)}-run collection limit, so the selected range may be incomplete. Narrow --since or --days and retry.`,
  );
}

export function listRunsArgs(workflow: string, range: { from: string; to: string }): string[] {
  return [
    "run",
    "list",
    "--repo",
    NEMOCLAW_REPOSITORY,
    "--workflow",
    workflow,
    "--branch",
    "main",
    "--event",
    "push",
    "--created",
    `${range.from}..${range.to}`,
    "--limit",
    String(MAX_RUNS_PER_WORKFLOW),
    "--json",
    "attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,name,status,url",
  ];
}

export function failedRunLogArgs(databaseId: number): string[] {
  return ["run", "view", String(databaseId), "--repo", NEMOCLAW_REPOSITORY, "--log-failed"];
}

async function collectRuns(
  workflows: readonly string[],
  range: { from: string; to: string },
): Promise<E2ERunRecord[]> {
  const records = await Promise.all(
    workflows.map(async (workflow) => {
      const output = await gh(listRunsArgs(workflow, range));
      const parsed = JSON.parse(output) as unknown;
      if (!Array.isArray(parsed)) throw new Error(`GitHub returned malformed runs for ${workflow}`);
      requireCompleteRunSelection(workflow, parsed.length);
      return parsed.map(normalizeRun);
    }),
  );
  const byId = new Map<number, E2ERunRecord>();
  for (const run of records.flat()) byId.set(run.databaseId, run);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function parallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await action(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function collectEvidence(runs: readonly E2ERunRecord[]): Promise<RunLogEvidence[]> {
  const failures = runs.filter((run) => run.status === "completed" && run.conclusion === "failure");
  const logs = new Map<number, RunLogEvidence>();
  await parallelMap(failures, DEFAULT_CONCURRENCY, async (run) => {
    try {
      const log = await gh(failedRunLogArgs(run.databaseId));
      logs.set(run.databaseId, { log, run });
    } catch (error) {
      logs.set(run.databaseId, {
        error: error instanceof Error ? error.message : "failed log unavailable",
        run,
      });
    }
  });
  return runs.map((run) => logs.get(run.databaseId) ?? { run });
}

function readOfflineEvidence(runsFile: string, logsDir: string): RunLogEvidence[] {
  const parsed = JSON.parse(fs.readFileSync(runsFile, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("--runs-file must contain a JSON array");
  return parsed.map(normalizeRun).map((run) => {
    if (run.conclusion !== "failure") return { run };
    const logPath = path.join(logsDir, `${run.databaseId}.log`);
    const errorPath = path.join(logsDir, `${run.databaseId}.error`);
    const error = fs.existsSync(errorPath) ? fs.readFileSync(errorPath, "utf8").trim() : "";
    return {
      ...(error.length > 0 ? { error } : {}),
      ...(fs.existsSync(logPath) ? { log: fs.readFileSync(logPath, "utf8") } : {}),
      run,
    };
  });
}

function writePrivate(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { mode: 0o700, recursive: true });
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const range = rangeFromOptions(options);
  const evidence =
    options.runsFile !== undefined && options.logsDir !== undefined
      ? readOfflineEvidence(options.runsFile, options.logsDir)
      : await collectEvidence(await collectRuns(options.workflows, range));
  const report = buildUnitGapReport(evidence, range);
  writePrivate(options.output, formatUnitGapReport(report));
  writePrivate(options.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${String(report.groups.length)} cause candidates from ${String(evidence.length)} runs; ${String(report.incompleteRuns.length)} selected runs need more evidence.\n`,
  );
  if (report.incompleteRuns.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
