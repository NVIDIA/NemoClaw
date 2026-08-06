// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { readFreeStandingJobsInventory } from "../../../../tools/e2e/workflow-boundary.mts";
import {
  buildE2eWorkflowPlan,
  type E2eWorkflowPlan,
} from "../../../../tools/e2e/workflow-plan.mts";

type JsonRecord = Record<string, unknown>;
type ExecutionGroup = "default";

export type ReleaseE2eExecution = {
  id: string;
  jobId: string;
  expectedName: string;
  group: ExecutionGroup;
};

export type ReleaseE2ePreflight = {
  candidateSha: string;
  dispatches: {
    completeRun: {
      includeStagingBrevLaunchable: true;
      jobs: "";
      mode: "full";
      targets: "";
    };
  };
  exceptionsRequired: string[];
  executions: ReleaseE2eExecution[];
  launchableE2eJobId: string;
  requiredExecutionCount: number;
};

export type ReleaseE2eRunEvidence = {
  dispatch: unknown;
  jobs: unknown;
  run: unknown;
};

export type ReleaseE2eLedgerEntry = ReleaseE2eExecution & {
  attempts: Array<{
    attempt: number;
    conclusion: string;
    status: string;
    jobUrl: string;
    runUrl: string;
  }>;
  successfulEvidence?: {
    attempt: number;
    jobUrl: string;
    runUrl: string;
  };
  status: "missing" | "successful";
};

export type ReleaseE2eLedger = {
  candidateSha: string;
  entries: ReleaseE2eLedgerEntry[];
  successfulCount: number;
  missingCount: number;
  requiredCount: number;
};

type ReleaseEvidenceManifest = {
  candidateSha: string;
  runs: Array<{
    dispatchJson: string;
    jobsJson: string;
    runJson: string;
  }>;
};

type CliOptions = {
  candidateSha?: string;
  manifest?: string;
  workflowPath: string;
};

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DEFAULT_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_REPO_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/u;
const MATRIX_EXPRESSION_PATTERN = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/gu;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, field: string, label: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return result;
}

function numberField(value: JsonRecord, field: string, label: string): number {
  const result = value[field];
  if (!Number.isInteger(result) || (result as number) < 1) {
    throw new Error(`${label}.${field} must be a positive integer`);
  }
  return result as number;
}

function booleanField(value: JsonRecord, field: string, label: string): boolean {
  const result = value[field];
  if (typeof result !== "boolean") {
    throw new Error(`${label}.${field} must be a boolean`);
  }
  return result;
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function matrixRows(rawMatrix: unknown, jobId: string): JsonRecord[] {
  const matrix = record(rawMatrix, `${jobId}.strategy.matrix`);
  if (typeof matrix.include === "string") {
    throw new Error(`${jobId} has a dynamic matrix that needs a planner-specific expansion`);
  }

  const axes = Object.entries(matrix).filter(
    ([key]) =>
      key !== "exclude" && key !== "include" && key !== "fail-fast" && key !== "max-parallel",
  );
  let rows: JsonRecord[] = [{}];
  for (const [key, rawValues] of axes) {
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      throw new Error(`${jobId} matrix axis ${key} must be a non-empty array`);
    }
    rows = rows.flatMap((row) =>
      rawValues.map((value) => {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new Error(`${jobId} matrix axis ${key} contains an unsupported value`);
        }
        return { ...row, [key]: value };
      }),
    );
  }

  const excludes = Array.isArray(matrix.exclude)
    ? matrix.exclude.map((row) => record(row, "exclude"))
    : [];
  rows = rows.filter(
    (row) =>
      !excludes.some((excluded) =>
        Object.entries(excluded).every(([key, value]) => row[key] === value),
      ),
  );

  if (Array.isArray(matrix.include)) {
    if (axes.length > 0) {
      throw new Error(
        `${jobId} combines matrix axes and include rows; add explicit expansion support`,
      );
    }
    rows = matrix.include.map((row) => record(row, `${jobId}.strategy.matrix.include`));
  }
  return rows;
}

function renderMatrixJobName(jobId: string, rawJob: JsonRecord, row: JsonRecord): string {
  const configuredName = rawJob.name;
  if (configuredName !== undefined && typeof configuredName !== "string") {
    throw new Error(`${jobId}.name must be a string when set`);
  }
  if (configuredName) {
    const rendered = configuredName.replace(MATRIX_EXPRESSION_PATTERN, (_match, key: string) => {
      if (!Object.hasOwn(row, key)) {
        throw new Error(`${jobId}.name references missing matrix dimension ${key}`);
      }
      return String(row[key]);
    });
    if (rendered.includes("${{ matrix.")) {
      throw new Error(`${jobId}.name contains an unsupported matrix expression`);
    }
    return rendered;
  }
  return `${jobId} (${Object.values(row)
    .map((value) => String(value))
    .join(", ")})`;
}

function executionId(jobId: string, row: JsonRecord): string {
  if (typeof row.id === "string" && row.id.length > 0) return `${jobId}[id=${row.id}]`;
  const dimensions = Object.entries(row)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",");
  return `${jobId}[${dimensions}]`;
}

function jobExecutions(
  jobId: string,
  rawJob: JsonRecord,
  group: ExecutionGroup,
  plan: E2eWorkflowPlan,
): ReleaseE2eExecution[] {
  let rows: JsonRecord[] = [];
  if (jobId === "live") rows = plan.matrix as unknown as JsonRecord[];
  else if (jobId === "shared-e2e") rows = plan.testMatrix as unknown as JsonRecord[];
  else {
    const strategy = record(rawJob.strategy ?? {}, `${jobId}.strategy`);
    if (strategy.matrix !== undefined) rows = matrixRows(strategy.matrix, jobId);
  }

  if (rows.length === 0) {
    const configuredName = rawJob.name;
    return [
      {
        expectedName: typeof configuredName === "string" ? configuredName : jobId,
        group,
        id: jobId,
        jobId,
      },
    ];
  }
  return rows.map((row) => ({
    expectedName: renderMatrixJobName(jobId, rawJob, row),
    group,
    id: executionId(jobId, row),
    jobId,
  }));
}

function workflowJobs(workflowPath: string): JsonRecord {
  const workflow = record(YAML.parse(readFileSync(workflowPath, "utf8")), "workflow");
  return record(workflow.jobs, "workflow.jobs");
}

function isLaunchableE2eJob(jobId: string, job: JsonRecord): boolean {
  const condition = job.if;
  return (
    jobId === "staging-brev-launchable" &&
    typeof condition === "string" &&
    condition.includes("inputs.include_staging_brev_launchable")
  );
}

function requiresConfirmedJetsonRunner(job: JsonRecord): boolean {
  const runsOn = job["runs-on"];
  return typeof runsOn === "string" && runsOn.includes("inputs.allow_jetson_runner_queue");
}

function releaseActivationPath(job: JsonRecord, jobId: string): string | undefined {
  const rawEnvironment = job.env;
  if (rawEnvironment === undefined) return undefined;
  const environment = record(rawEnvironment, `workflow.jobs.${jobId}.env`);
  const activationPath = environment.RELEASE_E2E_ACTIVATION_PATH;
  if (activationPath === undefined) return undefined;
  if (
    typeof activationPath !== "string" ||
    activationPath.length === 0 ||
    !SAFE_REPO_PATH_PATTERN.test(activationPath)
  ) {
    throw new Error(
      `${jobId}.env.RELEASE_E2E_ACTIVATION_PATH must be a nonempty relative repository path without backslashes or parent-directory segments`,
    );
  }
  return activationPath;
}

function candidatePathExists(candidateSha: string, candidatePath: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["ls-tree", "--name-only", candidateSha, "--", candidatePath],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output.trim() === candidatePath;
  } catch (error) {
    throw new Error(
      `could not inspect release E2E activation path ${candidatePath} at candidate ${candidateSha}`,
      { cause: error },
    );
  }
}

export function buildReleaseE2ePreflight(input: {
  candidateSha: string;
  candidatePathExists?: (candidateSha: string, candidatePath: string) => boolean;
  plan?: E2eWorkflowPlan;
  workflowPath?: string;
}): ReleaseE2ePreflight {
  if (!SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("candidateSha must be a lowercase 40-character commit SHA");
  }
  const workflowPath = input.workflowPath ?? DEFAULT_WORKFLOW_PATH;
  const jobs = workflowJobs(workflowPath);
  const inventory = readFreeStandingJobsInventory(workflowPath);
  const plan = input.plan ?? buildE2eWorkflowPlan();
  const pathExists = input.candidatePathExists ?? candidatePathExists;
  const defaultJobIds = inventory.workflowJobs.filter((jobId) => jobId !== "shared-e2e");
  for (const jobId of defaultJobIds) {
    const activationPath = releaseActivationPath(
      record(jobs[jobId], `workflow.jobs.${jobId}`),
      jobId,
    );
    if (activationPath !== undefined && !pathExists(input.candidateSha, activationPath)) {
      throw new Error(
        `candidate commit is missing required E2E activation path ${activationPath} for ${jobId}`,
      );
    }
  }
  const launchableE2eJobs = defaultJobIds.filter((jobId) =>
    isLaunchableE2eJob(jobId, record(jobs[jobId], `workflow.jobs.${jobId}`)),
  );
  if (launchableE2eJobs.length !== 1) {
    throw new Error(`expected exactly one Launchable E2E job, found ${launchableE2eJobs.length}`);
  }
  const launchableE2eJobId = launchableE2eJobs[0]!;
  const executions = [
    ...defaultJobIds.flatMap((jobId) =>
      jobExecutions(jobId, record(jobs[jobId], `workflow.jobs.${jobId}`), "default", plan),
    ),
    ...jobExecutions("live", record(jobs.live, "workflow.jobs.live"), "default", plan),
    ...jobExecutions(
      "shared-e2e",
      record(jobs["shared-e2e"], "workflow.jobs.shared-e2e"),
      "default",
      plan,
    ),
  ];
  const duplicateIds = executions
    .map((execution) => execution.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`release E2E execution identifiers are not unique: ${duplicateIds.join(",")}`);
  }

  const exceptionsRequired: string[] = [];

  return {
    candidateSha: input.candidateSha,
    dispatches: {
      completeRun: {
        includeStagingBrevLaunchable: true,
        jobs: "",
        mode: "full",
        targets: "",
      },
    },
    exceptionsRequired,
    executions,
    launchableE2eJobId,
    requiredExecutionCount: executions.length,
  };
}

function flattenJobs(value: unknown): JsonRecord[] {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page, pageIndex) => {
    const jobs = record(page, `jobs page ${pageIndex}`).jobs;
    if (!Array.isArray(jobs)) throw new Error(`jobs page ${pageIndex}.jobs must be an array`);
    return jobs.map((job, jobIndex) => record(job, `jobs page ${pageIndex}.jobs[${jobIndex}]`));
  });
}

function matchesExpectedName(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (!actual.endsWith("...")) return false;
  return expected.startsWith(actual.slice(0, -3));
}

export function buildReleaseE2eLedger(
  preflight: ReleaseE2ePreflight,
  runs: readonly ReleaseE2eRunEvidence[],
): ReleaseE2eLedger {
  if (runs.length !== 1) {
    throw new Error(
      `release E2E evidence requires exactly one workflow run, received ${runs.length}`,
    );
  }
  const attempts = new Map<string, ReleaseE2eLedgerEntry["attempts"]>();

  for (const [runIndex, evidence] of runs.entries()) {
    const label = `runs[${runIndex}]`;
    const run = record(evidence.run, `${label}.run`);
    requireEqual(run.head_sha, preflight.candidateSha, `${label}.run.head_sha`);
    requireEqual(run.head_branch, "main", `${label}.run.head_branch`);
    requireEqual(run.event, "workflow_dispatch", `${label}.run.event`);
    requireEqual(run.path, ".github/workflows/e2e.yaml", `${label}.run.path`);
    requireEqual(run.status, "completed", `${label}.run.status`);
    requireEqual(run.conclusion, "success", `${label}.run.conclusion`);
    const runId = numberField(run, "id", `${label}.run`);
    const runAttempt = numberField(run, "run_attempt", `${label}.run`);
    const runUrl = stringField(run, "html_url", `${label}.run`);

    const dispatch = record(evidence.dispatch, `${label}.dispatch`);
    requireEqual(dispatch.kind, "nemoclaw-e2e-dispatch-v1", `${label}.dispatch.kind`);
    requireEqual(dispatch.candidateSha, preflight.candidateSha, `${label}.dispatch.candidateSha`);
    requireEqual(dispatch.eventName, "workflow_dispatch", `${label}.dispatch.eventName`);
    requireEqual(dispatch.workflowRunId, String(runId), `${label}.dispatch.workflowRunId`);
    const receiptAttempt = numberField(dispatch, "workflowRunAttempt", `${label}.dispatch`);
    if (receiptAttempt > runAttempt) {
      throw new Error(`${label}.dispatch.workflowRunAttempt exceeds the workflow run attempt`);
    }
    const jobsInput = dispatch.jobs;
    const targetsInput = dispatch.targets;
    if (typeof jobsInput !== "string" || typeof targetsInput !== "string") {
      throw new Error(`${label}.dispatch jobs and targets must be strings`);
    }
    requireEqual(jobsInput, "", `${label}.dispatch.jobs`);
    requireEqual(targetsInput, "", `${label}.dispatch.targets`);
    requireEqual(
      booleanField(dispatch, "emptySelectors", `${label}.dispatch`),
      true,
      `${label}.dispatch.emptySelectors`,
    );
    requireEqual(
      booleanField(dispatch, "includeStagingBrevLaunchable", `${label}.dispatch`),
      true,
      `${label}.dispatch.includeStagingBrevLaunchable`,
    );

    const selectedExecutions = preflight.executions;
    for (const job of flattenJobs(evidence.jobs)) {
      const jobRunId = numberField(job, "run_id", `runs[${runIndex}].job`);
      const jobAttempt = numberField(job, "run_attempt", `runs[${runIndex}].job`);
      if (jobRunId !== runId || jobAttempt > runAttempt) continue;
      const name = stringField(job, "name", `runs[${runIndex}].job`);
      const matches = selectedExecutions.filter((execution) =>
        matchesExpectedName(name, execution.expectedName),
      );
      if (matches.length > 1) {
        throw new Error(
          `GitHub job name ${JSON.stringify(name)} ambiguously matches ${matches
            .map((execution) => execution.id)
            .join(",")}`,
        );
      }
      if (matches.length === 0) continue;
      const execution = matches[0]!;
      const values = attempts.get(execution.id) ?? [];
      values.push({
        attempt: jobAttempt,
        conclusion: stringField(job, "conclusion", `runs[${runIndex}].job`),
        status: stringField(job, "status", `runs[${runIndex}].job`),
        jobUrl: stringField(job, "html_url", `runs[${runIndex}].job`),
        runUrl,
      });
      attempts.set(execution.id, values);
    }
  }

  const entries = preflight.executions.map((execution): ReleaseE2eLedgerEntry => {
    const executionAttempts = [...(attempts.get(execution.id) ?? [])].sort(
      (left, right) => right.attempt - left.attempt || right.jobUrl.localeCompare(left.jobUrl),
    );
    const successful = executionAttempts.find(
      (attempt) => attempt.status === "completed" && attempt.conclusion === "success",
    );
    return {
      ...execution,
      attempts: executionAttempts,
      ...(successful
        ? {
            successfulEvidence: {
              attempt: successful.attempt,
              jobUrl: successful.jobUrl,
              runUrl: successful.runUrl,
            },
          }
        : {}),
      status: successful ? "successful" : "missing",
    };
  });
  const successfulCount = entries.filter((entry) => entry.status === "successful").length;
  return {
    candidateSha: preflight.candidateSha,
    entries,
    successfulCount,
    missingCount: entries.length - successfulCount,
    requiredCount: entries.length,
  };
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    workflowPath: DEFAULT_WORKFLOW_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg !== "--candidate-sha" && arg !== "--manifest" && arg !== "--workflow") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--candidate-sha") options.candidateSha = value;
    else if (arg === "--manifest") options.manifest = value;
    else options.workflowPath = value;
    index += 1;
  }
  return options;
}

function readManifest(manifestPath: string): {
  manifest: ReleaseEvidenceManifest;
  runs: ReleaseE2eRunEvidence[];
} {
  const directory = path.dirname(path.resolve(manifestPath));
  const raw = record(JSON.parse(readFileSync(manifestPath, "utf8")), "manifest");
  const manifest = raw as ReleaseEvidenceManifest;
  if (!SHA_PATTERN.test(manifest.candidateSha) || !Array.isArray(manifest.runs)) {
    throw new Error("release E2E evidence manifest has an invalid schema");
  }
  const runs = manifest.runs.map((entry, index) => {
    if (
      typeof entry.dispatchJson !== "string" ||
      typeof entry.jobsJson !== "string" ||
      typeof entry.runJson !== "string"
    ) {
      throw new Error(`manifest.runs[${index}] has an invalid schema`);
    }
    return {
      dispatch: JSON.parse(readFileSync(path.resolve(directory, entry.dispatchJson), "utf8")),
      jobs: JSON.parse(readFileSync(path.resolve(directory, entry.jobsJson), "utf8")),
      run: JSON.parse(readFileSync(path.resolve(directory, entry.runJson), "utf8")),
    };
  });
  return { manifest, runs };
}

function requireCandidateCheckout(candidateSha: string): void {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (headSha !== candidateSha) {
    throw new Error(`checkout HEAD ${headSha} does not match candidate SHA ${candidateSha}`);
  }
}

export function runReleaseE2eEvidenceCli(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  if (options.manifest) {
    const { manifest, runs } = readManifest(options.manifest);
    requireCandidateCheckout(manifest.candidateSha);
    const preflight = buildReleaseE2ePreflight({
      candidateSha: manifest.candidateSha,
      workflowPath: options.workflowPath,
    });
    process.stdout.write(`${JSON.stringify(buildReleaseE2eLedger(preflight, runs), null, 2)}\n`);
    return;
  }
  if (options.candidateSha === undefined) {
    throw new Error("--candidate-sha is required for preflight");
  }
  requireCandidateCheckout(options.candidateSha);
  process.stdout.write(
    `${JSON.stringify(
      buildReleaseE2ePreflight({
        candidateSha: options.candidateSha,
        workflowPath: options.workflowPath,
      }),
      null,
      2,
    )}\n`,
  );
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    runReleaseE2eEvidenceCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
