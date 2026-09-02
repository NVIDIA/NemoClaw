// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Inspect existing staging Launchable evidence without changing GitHub state. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REPOSITORY = "NVIDIA/NemoClaw";
const SENTINEL = "NEMOCLAW_FULL_E2E_PASSED";
const WORKFLOW = ".github/workflows/e2e.yaml";
const JOB = "Exact staging Brev Launchable";
type JsonRecord = Record<string, unknown>;

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  html_url: string;
  created_at: string;
}
export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}
export interface ArtifactFiles {
  "workspace-recovery.json"?: string;
  "launchable-e2e.json"?: string;
  "full-e2e.log"?: string;
  "cleanup.json"?: string;
}
export interface EvidenceReader {
  listRuns(candidate: string): WorkflowRun[];
  listJobs(runId: number, attempt: number): WorkflowJob[];
  readArtifact(runId: number, name: string): ArtifactFiles;
}
export interface Options {
  candidate: string;
}
export interface Selection {
  run: WorkflowRun;
  job: WorkflowJob;
}
export interface Receipt {
  version: 1;
  candidate: { sha: string };
  run: { id: number; attempt: number; url: string };
  job: { id: number; url: string };
  artifact: { name: string };
  producer: { runId: number; status: "success"; url: string };
  boot: {
    bootImage: string;
    schemaVersion: 1;
    sourceRepository: "NVIDIA/NemoClaw";
    sourcePath: "/opt/nemoclaw-image/NemoClaw";
    repoSha: string;
    provisionSha: string;
    imageRepositorySha: string;
    repoClean: true;
    runtimeOverrides: false;
  };
  workspace: { name: string; id: string };
  fullE2e: { status: "passed"; sentinel: typeof SENTINEL };
  cleanup: { status: "ABSENT"; verifiedAt: string };
}
function fail(message: string): never {
  throw new Error(message.slice(0, 500));
}
function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as JsonRecord;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}
function utcTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!UTC.test(value) || Number.isNaN(milliseconds))
    fail(`${label} must be an ISO 8601 UTC timestamp`);
  const canonical = new Date(milliseconds).toISOString().replace(/\.000Z$/u, "Z"),
    normalized = value.replace(/\.000Z$/u, "Z");
  if (canonical !== normalized) fail(`${label} must be a valid ISO 8601 UTC timestamp`);
  return value;
}
function integer(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0)
    fail(`${label} must be a positive integer`);
  return parsed as number;
}

export function parseOptions(args: string[]): Options {
  let candidate = "";
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i],
      value = args[i + 1];
    if (option !== "--candidate") fail(`unknown option: ${option}`);
    if (!value || value.startsWith("--")) fail(`${option} requires a value`);
    candidate = value;
    i += 1;
  }
  if (!SHA.test(candidate)) fail("--candidate must be a lowercase 40-character SHA");
  return { candidate };
}
function candidateRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const eligible = runs.filter(
    (run) =>
      run.path === WORKFLOW &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      run.status === "completed",
  );
  for (const run of eligible) {
    utcTimestamp(run.created_at, "workflow run created_at");
  }
  return eligible.sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
  );
}
function candidateSelections(
  runs: WorkflowRun[],
  jobs: (run: WorkflowRun) => WorkflowJob[],
): Selection[] {
  const selections: Selection[] = [];
  for (const run of candidateRuns(runs)) {
    const job = jobs(run).find((value) => value.name === JOB && value.status === "completed");
    if (job) selections.push({ run, job });
  }
  return selections;
}
function json(value: string | undefined, name: string): JsonRecord {
  if (value === undefined) fail(`artifact is missing ${name}`);
  try {
    return record(JSON.parse(value), name);
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${name} is malformed JSON`);
    throw error;
  }
}
export function validateLaunchableEvidence(
  candidate: string,
  selection: Selection,
  artifactName: string,
  files: ArtifactFiles,
): Receipt {
  if (!SHA.test(candidate)) fail("candidate must be a lowercase 40-character SHA");
  const launchable = json(files["launchable-e2e.json"], "launchable-e2e.json");
  const log = files["full-e2e.log"];
  if (log === undefined) fail("artifact is missing full-e2e.log");
  if (log.length === 0) fail("full-e2e.log is empty");
  if (!log.split(/\r?\n/).includes(SENTINEL))
    fail("full-e2e.log is missing the exact success sentinel line");
  if (launchable.candidateSha !== candidate) fail("launchable candidate does not match candidate");
  const producer = record(launchable.producer, "producer"),
    boot = record(launchable.boot, "boot"),
    workspace = record(launchable.workspace, "workspace");
  const producerRunId = integer(producer.runId, "producer.runId");
  if (producer.status !== "success") fail("producer.status must be success");
  const bootImage = text(boot.bootImage, "boot.bootImage"),
    imageRepositorySha = text(boot.imageRepositorySha, "boot.imageRepositorySha");
  if (
    boot.schemaVersion !== 1 ||
    boot.sourceRepository !== "NVIDIA/NemoClaw" ||
    boot.sourcePath !== "/opt/nemoclaw-image/NemoClaw"
  )
    fail("boot provenance is invalid");
  if (boot.repoSha !== candidate || boot.provisionSha !== candidate)
    fail("boot commit identity does not match candidate");
  if (!SHA.test(imageRepositorySha) || boot.repoClean !== true || boot.runtimeOverrides !== false)
    fail("boot runtime state is invalid");
  if (launchable.fullE2e !== "passed") fail("fullE2e must be passed");
  const name = text(workspace.name, "workspace.name"),
    id = text(workspace.id, "workspace.id"),
    recovery = (reason: string, status = "<missing>", checkedAt = "<missing>"): never =>
      fail(
        `cleanup ${reason}: run=${selection.run.id} attempt=${selection.run.run_attempt} job=${selection.job.id} artifact=${artifactName} workspace=${name} id=${id} status=${status} checkedAt=${checkedAt}`,
      );
  let cleanup: JsonRecord;
  try {
    cleanup = json(files["cleanup.json"], "cleanup.json");
  } catch {
    return recovery("record is missing or malformed");
  }
  const cleanupStatus =
      typeof cleanup.status === "string" && cleanup.status.length > 0
        ? cleanup.status
        : "<missing>",
    checkedAt =
      typeof cleanup.checkedAt === "string" && cleanup.checkedAt.length > 0
        ? cleanup.checkedAt
        : "<missing>";
  if (cleanup.workspaceName !== name || cleanup.workspaceId !== id)
    return recovery("workspace mismatch", cleanupStatus, checkedAt);
  if (cleanupStatus !== "ABSENT") return recovery("incomplete", cleanupStatus, checkedAt);
  let verifiedAt: string;
  try {
    verifiedAt = text(cleanup.verifiedAt, "cleanup.verifiedAt");
  } catch {
    return recovery("verifiedAt is missing", cleanupStatus, checkedAt);
  }
  try {
    utcTimestamp(verifiedAt, "cleanup.verifiedAt");
  } catch {
    return recovery("verifiedAt is invalid", cleanupStatus, checkedAt);
  }
  return {
    version: 1,
    candidate: { sha: candidate },
    run: { id: selection.run.id, attempt: selection.run.run_attempt, url: selection.run.html_url },
    job: { id: selection.job.id, url: selection.job.html_url },
    artifact: { name: artifactName },
    producer: {
      runId: producerRunId,
      status: "success",
      url: `https://github.com/brevdev/nemoclaw-image/actions/runs/${producerRunId}`,
    },
    boot: {
      bootImage,
      schemaVersion: 1,
      sourceRepository: "NVIDIA/NemoClaw",
      sourcePath: "/opt/nemoclaw-image/NemoClaw",
      repoSha: candidate,
      provisionSha: candidate,
      imageRepositorySha,
      repoClean: true,
      runtimeOverrides: false,
    },
    workspace: { name, id },
    fullE2e: { status: "passed", sentinel: SENTINEL },
    cleanup: { status: "ABSENT", verifiedAt },
  };
}
function earlyRecovery(
  candidate: string,
  selection: Selection,
  artifactName: string,
  files: ArtifactFiles,
): never {
  const recovery = json(files["workspace-recovery.json"], "workspace-recovery.json"),
    workspace = record(recovery.workspace, "workspace-recovery.workspace"),
    name = text(workspace.name, "workspace-recovery.workspace.name"),
    id = typeof workspace.id === "string" ? workspace.id : "";
  if (
    recovery.schemaVersion !== 1 ||
    recovery.candidateSha !== candidate ||
    recovery.runId !== String(selection.run.id) ||
    recovery.runAttempt !== String(selection.run.run_attempt) ||
    name !== `nclaw-e2e-${selection.run.id}-${selection.run.run_attempt}`
  )
    fail("workspace recovery receipt does not match the selected candidate run attempt");
  if (id === "")
    fail(
      `workspace creation pending before full evidence: run=${selection.run.id} attempt=${selection.run.run_attempt} job=${selection.job.id} artifact=${artifactName} workspace=${name} id=<pending>; resolve exactly one matching inventory row before deletion`,
    );
  let cleanup: JsonRecord;
  try {
    cleanup = json(files["cleanup.json"], "cleanup.json");
  } catch {
    fail(
      `cleanup record missing before full evidence: run=${selection.run.id} attempt=${selection.run.run_attempt} job=${selection.job.id} artifact=${artifactName} workspace=${name} id=${id} status=<missing> checkedAt=<missing>`,
    );
  }
  const status =
      typeof cleanup.status === "string" && cleanup.status.length > 0
        ? cleanup.status
        : "<missing>",
    checkedAt =
      typeof cleanup.checkedAt === "string" && cleanup.checkedAt.length > 0
        ? cleanup.checkedAt
        : "<missing>";
  if (cleanup.workspaceName !== name || cleanup.workspaceId !== id)
    fail("workspace recovery cleanup identity does not match the early receipt");
  fail(
    `cleanup incomplete before full evidence: run=${selection.run.id} attempt=${selection.run.run_attempt} job=${selection.job.id} artifact=${artifactName} workspace=${name} id=${id} status=${status} checkedAt=${checkedAt}`,
  );
}

export function inspectLaunchableEvidence(options: Options, reader: EvidenceReader): Receipt {
  const runs = reader.listRuns(options.candidate),
    jobs = (run: WorkflowRun): WorkflowJob[] => reader.listJobs(run.id, run.run_attempt);
  let selected: { selection: Selection; artifactName: string; files: ArtifactFiles } | undefined;
  for (const selection of candidateSelections(runs, jobs)) {
    const artifactName = `staging-brev-launchable-${options.candidate}-${selection.run.id}-${selection.run.run_attempt}`,
      files = reader.readArtifact(selection.run.id, artifactName);
    if (Object.values(files).some((value) => value !== undefined)) {
      selected = { selection, artifactName, files };
      break;
    }
  }
  if (!selected) fail("no staging Brev Launchable artifact is bound to the candidate");
  const { selection, artifactName, files } = selected;
  if (
    files["workspace-recovery.json"] !== undefined &&
    (files["launchable-e2e.json"] === undefined ||
      files["full-e2e.log"] === undefined ||
      files["cleanup.json"] === undefined)
  )
    return earlyRecovery(options.candidate, selection, artifactName, files);
  let receipt: Receipt;
  try {
    receipt = validateLaunchableEvidence(options.candidate, selection, artifactName, files);
  } catch (error) {
    if (files["workspace-recovery.json"] !== undefined)
      return earlyRecovery(options.candidate, selection, artifactName, files);
    throw error;
  }
  if (selection.job.conclusion !== "success")
    fail(
      `staging Brev Launchable job conclusion ${selection.job.conclusion ?? "<missing>"} cannot provide release evidence: run=${selection.run.id} attempt=${selection.run.run_attempt} job=${selection.job.id} artifact=${artifactName}`,
    );
  return receipt;
}
function gh(args: string[]): unknown {
  return JSON.parse(
    execFileSync("gh", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }),
  );
}
export function artifactDownloadArgs(runId: number, name: string, directory: string): string[] {
  return [
    "run",
    "download",
    String(runId),
    "--name",
    name,
    "--dir",
    directory,
    "--repo",
    `github.com/${REPOSITORY}`,
  ];
}

function pageItems<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) fail(`${field} response must contain pages`);
  return value.flatMap((page, index) => {
    const response = record(page, `${field} response page ${index + 1}`),
      items = response[field];
    return Array.isArray(items) ? (items as T[]) : [];
  });
}

export const workflowRunsFromPages = (value: unknown): WorkflowRun[] =>
  pageItems<WorkflowRun>(value, "workflow_runs");
export const workflowJobsFromPages = (value: unknown): WorkflowJob[] =>
  pageItems<WorkflowJob>(value, "jobs");

export function workflowRunsApiArgs(candidate: string): string[] {
  if (!SHA.test(candidate)) fail("candidate must be a lowercase 40-character SHA");
  return [
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    `repos/${REPOSITORY}/actions/workflows/e2e.yaml/runs?per_page=100`,
  ];
}

export function workflowJobsApiArgs(runId: number, attempt: number): string[] {
  return [
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    `repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
  ];
}

export function createGitHubReader(): EvidenceReader {
  return {
    listRuns(candidate) {
      const pages = gh(workflowRunsApiArgs(candidate));
      return workflowRunsFromPages(pages);
    },
    listJobs(runId, attempt) {
      return workflowJobsFromPages(gh(workflowJobsApiArgs(runId, attempt)));
    },
    readArtifact(runId, name) {
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-launchable-evidence-"));
      try {
        execFileSync("gh", artifactDownloadArgs(runId, name, directory), {
          timeout: 120_000,
        });
        const result: ArtifactFiles = {};
        for (const file of [
          "workspace-recovery.json",
          "launchable-e2e.json",
          "full-e2e.log",
          "cleanup.json",
        ] as const) {
          try {
            result[file] = readFileSync(path.join(directory, file), "utf8");
          } catch {}
        }
        return result;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
export function runCli(args: string[], reader: EvidenceReader = createGitHubReader()): number {
  try {
    process.stdout.write(
      `${JSON.stringify(inspectLaunchableEvidence(parseOptions(args), reader), null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Launchable evidence invalid: ${message.slice(0, 500)}\n`);
    return 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = runCli(process.argv.slice(2));
