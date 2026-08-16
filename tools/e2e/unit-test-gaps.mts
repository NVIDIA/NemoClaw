// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildUnitGapReport,
  extractJobSignatures,
  type E2ERunRecord,
  formatUnitGapReport,
  type RunLogEvidence,
} from "./unit-test-gaps-core.mts";

const execFileAsync = promisify(execFile);
const NEMOCLAW_REPOSITORY = "NVIDIA/NemoClaw";
const DEFAULT_WORKFLOWS = ["e2e.yaml", "portable-profile-e2e.yaml"];
const MAX_GH_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_RUNS_PER_WORKFLOW = 1000;
const MAX_CACHE_FILE_BYTES = 1024 * 1024;
const MAX_FAILED_LOG_READS = 50;
const DEFAULT_CONCURRENCY = 2;
const CACHE_VERSION = 1;

type GhRunner = (args: readonly string[]) => Promise<string>;

interface CachedFailureEvidence {
  attempt: number;
  runId: number;
  signatures: Array<{ job: string; signature: string }>;
  version: typeof CACHE_VERSION;
}

export interface EvidenceCollectionPlan {
  cachedRuns: number;
  deferredRuns: number;
  failedLogReads: number;
}

export class EvidenceBatchIncompleteError extends Error {
  constructor(readonly deferredRuns: number) {
    super(
      `${String(deferredRuns)} failed runs remain after this 50-log batch. Rerun the command with the same cache directory.`,
    );
    this.name = "EvidenceBatchIncompleteError";
  }
}

export class GitHubEvidenceReadError extends Error {
  constructor(
    readonly kind: "access" | "rate-limit",
    readonly runId: number | null,
  ) {
    const resource = runId === null ? "the workflow run list" : `logs for run ${String(runId)}`;
    super(
      kind === "rate-limit"
        ? `GitHub rate limit prevented reading ${resource}. Wait for the quota to reset, then reuse the same cache directory.`
        : `GitHub denied access to ${resource}. Correct gh authentication or authorization before retrying with the same cache directory.`,
    );
    this.name = "GitHubEvidenceReadError";
  }
}

interface Options {
  cacheDir?: string;
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
    "usage: unit-test-gaps.mts [--days 7 | --since YYYY-MM-DD] --output REPORT.md --json-output REPORT.json (--cache-dir DIR [--workflow FILE] | --runs-file RUNS.json --logs-dir DIR)",
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
    } else if (flag === "--cache-dir" && value !== undefined) {
      options.cacheDir = value;
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
  if (options.runsFile === undefined && options.cacheDir === undefined) usage();
  if (options.runsFile !== undefined && options.cacheDir !== undefined) usage();
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
  runGh: GhRunner,
): Promise<E2ERunRecord[]> {
  const records: E2ERunRecord[][] = [];
  for (const workflow of workflows) {
    let output: string;
    try {
      output = await runGh(listRunsArgs(workflow, range));
    } catch (error) {
      const kind = classifyGitHubEvidenceReadError(error);
      if (kind !== null) throw new GitHubEvidenceReadError(kind, null);
      throw error;
    }
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`GitHub returned malformed runs for ${workflow}`);
    requireCompleteRunSelection(workflow, parsed.length);
    records.push(parsed.map(normalizeRun));
  }
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

function signaturesToLog(
  signatures: ReadonlyArray<{ job: string; signature: string }>,
): string {
  if (signatures.length === 0) return "";
  return `${signatures.map(({ job, signature }) => `${job}\tstep\t${signature}`).join("\n")}\n`;
}

function cacheFile(cacheDir: string, run: E2ERunRecord): string {
  return path.join(cacheDir, `${String(run.databaseId)}-attempt-${String(run.attempt)}.json`);
}

function ensurePrivateDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("The evidence cache path must be a directory, not a symbolic link.");
    }
  } else {
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  fs.chmodSync(directory, 0o700);
}

function parseCachedEvidence(contents: string, run: E2ERunRecord): CachedFailureEvidence {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cached evidence for run ${String(run.databaseId)} is not a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  const signatures = record.signatures;
  if (
    record.version !== CACHE_VERSION ||
    record.runId !== run.databaseId ||
    record.attempt !== run.attempt ||
    !Array.isArray(signatures) ||
    signatures.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).job !== "string" ||
        typeof (entry as Record<string, unknown>).signature !== "string" ||
        ((entry as Record<string, unknown>).job as string).length === 0 ||
        ((entry as Record<string, unknown>).signature as string).length === 0 ||
        ((entry as Record<string, unknown>).job as string).length > 512 ||
        ((entry as Record<string, unknown>).signature as string).length > 240 ||
        /[\r\n\t]/u.test((entry as Record<string, unknown>).job as string) ||
        /[\r\n\t]/u.test((entry as Record<string, unknown>).signature as string),
    )
  ) {
    throw new Error(`Cached evidence for run ${String(run.databaseId)} does not match the run.`);
  }
  return parsed as CachedFailureEvidence;
}

function readCachedEvidence(cacheDir: string, run: E2ERunRecord): CachedFailureEvidence | null {
  const file = cacheFile(cacheDir, run);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("O_NOFOLLOW is required for the evidence cache.");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow | fs.constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error(
        `Cached evidence for run ${String(run.databaseId)} is not a bounded regular file.`,
      );
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) {
      throw new Error(
        `Cached evidence for run ${String(run.databaseId)} is not a bounded regular file.`,
      );
    }
    fs.fchmodSync(descriptor, 0o600);
    return parseCachedEvidence(fs.readFileSync(descriptor, "utf8"), run);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeCachedEvidence(
  cacheDir: string,
  run: E2ERunRecord,
  signatures: CachedFailureEvidence["signatures"],
): void {
  const destination = cacheFile(cacheDir, run);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify(
        { attempt: run.attempt, runId: run.databaseId, signatures, version: CACHE_VERSION },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function commandErrorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

export function classifyGitHubEvidenceReadError(error: unknown): "access" | "rate-limit" | null {
  const message = commandErrorText(error);
  if (/API rate limit exceeded|secondary rate limit|abuse detection|HTTP\s+429/iu.test(message)) {
    return "rate-limit";
  }
  if (
    /HTTP\s+(?:401|403)|authentication|authorization|resource not accessible|single sign-on|\bSSO\b|credential|permission denied/iu.test(
      message,
    )
  ) {
    return "access";
  }
  return null;
}

export async function collectEvidence(
  runs: readonly E2ERunRecord[],
  cacheDir: string,
  runGh: GhRunner = gh,
  concurrency = DEFAULT_CONCURRENCY,
  reportPlan: (plan: EvidenceCollectionPlan) => void = () => undefined,
): Promise<RunLogEvidence[]> {
  ensurePrivateDirectory(cacheDir);
  const failures = runs.filter((run) => run.status === "completed" && run.conclusion === "failure");
  const logs = new Map<number, RunLogEvidence>();
  const missing: E2ERunRecord[] = [];
  for (const run of failures) {
    const cached = readCachedEvidence(cacheDir, run);
    if (cached === null) {
      missing.push(run);
    } else {
      logs.set(run.databaseId, { log: signaturesToLog(cached.signatures), run });
    }
  }
  const scheduled = missing.slice(0, MAX_FAILED_LOG_READS);
  const deferredRuns = missing.length - scheduled.length;
  reportPlan({
    cachedRuns: failures.length - missing.length,
    deferredRuns,
    failedLogReads: scheduled.length,
  });

  let fatalError: GitHubEvidenceReadError | null = null;
  await parallelMap(scheduled, concurrency, async (run) => {
    if (fatalError !== null) return;
    try {
      const rawLog = await runGh(failedRunLogArgs(run.databaseId));
      const signatures = extractJobSignatures(rawLog);
      writeCachedEvidence(cacheDir, run, signatures);
      logs.set(run.databaseId, { log: signaturesToLog(signatures), run });
    } catch (error) {
      const kind = classifyGitHubEvidenceReadError(error);
      if (kind !== null) {
        fatalError ??= new GitHubEvidenceReadError(kind, run.databaseId);
      } else {
        logs.set(run.databaseId, { error: "failed log unavailable", run });
      }
    }
  });
  if (fatalError !== null) throw fatalError;
  if (deferredRuns > 0) throw new EvidenceBatchIncompleteError(deferredRuns);
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
      ...(fs.existsSync(logPath)
        ? { log: signaturesToLog(extractJobSignatures(fs.readFileSync(logPath, "utf8"))) }
        : {}),
      run,
    };
  });
}

function writePrivate(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { mode: 0o700, recursive: true });
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: { now?: Date; runGh?: GhRunner } = {},
): Promise<void> {
  const options = parseArgs(argv);
  const range = rangeFromOptions(options, dependencies.now);
  const runGh = dependencies.runGh ?? gh;
  if (options.cacheDir !== undefined) ensurePrivateDirectory(options.cacheDir);
  const evidence =
    options.runsFile !== undefined && options.logsDir !== undefined
      ? readOfflineEvidence(options.runsFile, options.logsDir)
      : await collectEvidence(
          await collectRuns(options.workflows, range, runGh),
          options.cacheDir!,
          runGh,
          DEFAULT_CONCURRENCY,
          ({ cachedRuns, deferredRuns, failedLogReads }) => {
            process.stdout.write(
              `Reusing ${String(cachedRuns)} cached failed runs; reading ${String(failedLogReads)} failed logs; deferring ${String(deferredRuns)} runs.\n`,
            );
          },
        );
  const report = buildUnitGapReport(evidence, range);
  writePrivate(options.output, formatUnitGapReport(report));
  writePrivate(options.jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${String(report.groups.length)} cause candidates from ${String(evidence.length)} runs; ${String(report.incompleteRuns.length)} selected runs need more evidence.\n`,
  );
  if (report.incompleteRuns.length > 0) process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main();
}
