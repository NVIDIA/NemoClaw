// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const REPOSITORY = "NVIDIA/NemoClaw";
const MAIN_BRANCH = "main";
const WORKFLOW_PATH = ".github/workflows/base-image.yaml";
const WORKFLOW_FILE = "base-image.yaml";
const WORKFLOW_NAME = "Images / Base Images";
const API_ROOT = "https://api.github.com";
const RUN_URL_ROOT = `https://github.com/${REPOSITORY}/actions/runs`;
const WORKFLOW_URL = `https://github.com/${REPOSITORY}/blob/${MAIN_BRANCH}/${WORKFLOW_PATH}`;
const PAGE_SIZE = 100;
const MAX_API_PAGES = 10;
const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRY_DELAY_MS = 10_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const PENDING_RUN_STATUSES = new Set(["requested", "waiting", "pending", "queued", "in_progress"]);
const COMPLETED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

export const REQUIRED_PUBLISHER_JOBS = [
  "Build and push OpenClaw base image",
  "Build and push Hermes base image",
  "Build and push Deep Agents Code base image",
] as const;

type JsonRecord = Record<string, unknown>;

export interface FirstParentHistory {
  expectedSha: string;
  relevantSha: string;
  relevantDistance: number;
  distanceBySha: ReadonlyMap<string, number>;
}

export interface PublicationRun {
  id: number;
  attempt: number;
  workflowId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export type PublicationSelection =
  | { state: "missing" }
  | { state: "pending"; run: PublicationRun }
  | { state: "ready"; run: PublicationRun };

export interface PublicationWaitOptions {
  history: FirstParentHistory;
  request: (path: string) => Promise<unknown>;
  waitMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  notice?: (message: string) => void;
}

export interface GithubRequestOptions {
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  attempts?: number;
  timeoutMs?: number;
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub response must contain JSON objects");
  }
  return value as JsonRecord;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function exactString(value: unknown, expected: string, label: string): string {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function parseQuotedPath(raw: string, lineNumber: number): string {
  let value: unknown;
  try {
    if (raw.startsWith('"') && raw.endsWith('"')) {
      value = JSON.parse(raw);
    } else if (raw.startsWith("'") && raw.endsWith("'")) {
      value = raw.slice(1, -1).replaceAll("''", "'");
    } else {
      throw new Error("not quoted");
    }
  } catch {
    throw new Error(`base-image push path on line ${lineNumber} must be one quoted scalar`);
  }
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`base-image push path on line ${lineNumber} must be a non-empty exact path`);
  }
  if (
    !SAFE_PATH_PATTERN.test(value) ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.startsWith(":") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`base-image push path on line ${lineNumber} is not a safe literal path`);
  }
  return value;
}

/**
 * Read the literal path list that controls the publisher without requiring a
 * dependency install in the preflight job. Deliberately reject YAML features
 * such as flow lists, aliases, globs, and folded scalars instead of guessing.
 */
export function parseBaseImagePushPaths(source: string): string[] {
  const lines = source.split(/\r?\n/u);
  let inOn = false;
  let inPush = false;
  let inPaths = false;
  let sawOn = false;
  let sawPush = false;
  let sawPaths = false;
  let sawMainBranch = false;
  const paths: string[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      inOn = trimmed === "on:";
      inPush = false;
      inPaths = false;
      if (inOn) {
        if (sawOn) throw new Error("base-image workflow must declare exactly one on block");
        sawOn = true;
      }
      continue;
    }
    if (!inOn) continue;

    if (indent === 2) {
      inPush = trimmed === "push:";
      inPaths = false;
      if (inPush) {
        if (sawPush) throw new Error("base-image workflow must declare exactly one push trigger");
        sawPush = true;
      }
      continue;
    }
    if (!inPush) continue;

    if (indent === 4) {
      if (trimmed === "branches: [main]") sawMainBranch = true;
      inPaths = trimmed === "paths:";
      if (inPaths) {
        if (sawPaths)
          throw new Error("base-image push trigger must declare exactly one paths list");
        sawPaths = true;
      }
      continue;
    }
    if (!inPaths) continue;

    const match = line.match(/^ {6}- (.+)$/u);
    if (!match) {
      throw new Error(
        `base-image push paths must be a six-space-indented scalar list (line ${lineNumber})`,
      );
    }
    paths.push(parseQuotedPath(match[1], lineNumber));
  }

  if (!sawOn || !sawPush || !sawMainBranch || !sawPaths || paths.length === 0) {
    throw new Error("base-image workflow must declare a non-empty on.push.paths list");
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("base-image push paths must be unique");
  }
  if (!paths.includes(WORKFLOW_PATH)) {
    throw new Error(`base-image push paths must include ${WORKFLOW_PATH}`);
  }
  return paths;
}

function defaultGit(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveFirstParentHistory(
  expectedSha: string,
  paths: readonly string[],
  runGit: (args: string[]) => string = defaultGit,
): FirstParentHistory {
  sha(expectedSha, "expected SHA");
  if (paths.length === 0) throw new Error("at least one base-image path is required");

  const checkedOutSha = runGit(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (checkedOutSha !== expectedSha) {
    throw new Error(
      `checked-out commit ${checkedOutSha || "missing"} does not match ${expectedSha}`,
    );
  }
  if (runGit(["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("base-image publication gate requires a complete Git history");
  }

  const relevantSha = runGit([
    "log",
    "--first-parent",
    "-n",
    "1",
    "--format=%H",
    expectedSha,
    "--",
    ...paths,
  ]);
  sha(relevantSha, "latest applicable base-image commit");

  const firstParentShas = runGit(["rev-list", "--first-parent", expectedSha])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (firstParentShas.length === 0 || firstParentShas[0] !== expectedSha) {
    throw new Error("first-parent history must begin at the expected SHA");
  }
  if (new Set(firstParentShas).size !== firstParentShas.length) {
    throw new Error("first-parent history must not contain duplicate commits");
  }
  for (const [index, value] of firstParentShas.entries())
    sha(value, `first-parent commit ${index}`);

  const relevantDistance = firstParentShas.indexOf(relevantSha);
  if (relevantDistance < 0) {
    throw new Error("latest applicable base-image commit is not on the first-parent history");
  }
  const eligibleShas = firstParentShas.slice(0, relevantDistance + 1);
  return {
    expectedSha,
    relevantSha,
    relevantDistance,
    distanceBySha: new Map(eligibleShas.map((value, index) => [value, index])),
  };
}

export function validateWorkflow(payload: unknown): number {
  const workflow = asRecord(payload);
  const workflowId = positiveSafeInteger(workflow.id, "base-image workflow id");
  exactString(workflow.name, WORKFLOW_NAME, "base-image workflow name");
  exactString(workflow.path, WORKFLOW_PATH, "base-image workflow path");
  exactString(workflow.state, "active", "base-image workflow state");
  exactString(workflow.html_url, WORKFLOW_URL, "base-image workflow URL");
  exactString(
    workflow.url,
    `${API_ROOT}/repos/${REPOSITORY}/actions/workflows/${workflowId}`,
    "base-image workflow API URL",
  );
  return workflowId;
}

function validateRun(value: unknown, index: number, expectedWorkflowId: number): PublicationRun {
  const run = asRecord(value);
  const id = positiveSafeInteger(run.id, `workflow run ${index} id`);
  const attempt = positiveSafeInteger(run.run_attempt, `workflow run ${index} attempt`);
  if (
    positiveSafeInteger(run.workflow_id, `workflow run ${index} workflow id`) !== expectedWorkflowId
  ) {
    throw new Error(`workflow run ${index} workflow id does not match the base-image workflow`);
  }
  const headSha = sha(run.head_sha, `workflow run ${index} head SHA`);
  exactString(run.event, "push", `workflow run ${index} event`);
  exactString(run.head_branch, MAIN_BRANCH, `workflow run ${index} branch`);
  exactString(run.path, WORKFLOW_PATH, `workflow run ${index} path`);
  exactString(run.name, WORKFLOW_NAME, `workflow run ${index} name`);
  exactString(asRecord(run.repository).full_name, REPOSITORY, `workflow run ${index} repository`);
  exactString(
    asRecord(run.head_repository).full_name,
    REPOSITORY,
    `workflow run ${index} head repository`,
  );
  const url = `${RUN_URL_ROOT}/${id}`;
  exactString(run.html_url, url, `workflow run ${index} URL`);

  if (typeof run.status !== "string") throw new Error(`workflow run ${index} status is invalid`);
  const status = run.status;
  let conclusion: string | null = null;
  if (status === "completed") {
    if (typeof run.conclusion !== "string" || !COMPLETED_CONCLUSIONS.has(run.conclusion)) {
      throw new Error(`workflow run ${index} completed conclusion is invalid`);
    }
    conclusion = run.conclusion;
  } else {
    if (!PENDING_RUN_STATUSES.has(status) || run.conclusion !== null) {
      throw new Error(`workflow run ${index} pending state is invalid`);
    }
  }
  return { id, attempt, workflowId: expectedWorkflowId, headSha, status, conclusion, url };
}

export function selectPublicationRun(
  payload: unknown,
  history: FirstParentHistory,
  workflowId: number,
): PublicationSelection {
  positiveSafeInteger(workflowId, "base-image workflow id");
  const response = asRecord(payload);
  const totalCount = Number(response.total_count);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error("workflow run total_count is invalid");
  }
  if (!Array.isArray(response.workflow_runs) || response.workflow_runs.length !== totalCount) {
    throw new Error("workflow run listing is incomplete");
  }

  const runs = response.workflow_runs.map((run, index) => validateRun(run, index, workflowId));
  if (new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new Error("workflow run listing contains duplicate run ids");
  }
  const eligible = runs.flatMap((run) => {
    const distance = history.distanceBySha.get(run.headSha);
    return distance === undefined ? [] : [{ run, distance }];
  });
  if (eligible.length === 0) return { state: "missing" };

  const nearestDistance = Math.min(...eligible.map(({ distance }) => distance));
  const nearest = eligible.filter(({ distance }) => distance === nearestDistance);
  if (nearest.length !== 1) {
    throw new Error(
      `multiple trusted base-image workflow runs match ${nearest[0]?.run.headSha ?? history.relevantSha}`,
    );
  }
  const run = nearest[0].run;
  if (run.status !== "completed") return { state: "pending", run };
  if (run.conclusion !== "success") {
    throw new Error(
      `base-image workflow for ${run.headSha} concluded ${run.conclusion}; ${run.url}`,
    );
  }
  return { state: "ready", run };
}

export function validatePublisherJobs(payload: unknown, run: PublicationRun): void {
  const response = asRecord(payload);
  const totalCount = Number(response.total_count);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error("publisher job total_count is invalid");
  }
  if (!Array.isArray(response.jobs) || response.jobs.length !== totalCount) {
    throw new Error("publisher job listing is incomplete");
  }

  const jobsByName = new Map<
    string,
    Array<{ attempt: number; status: string; conclusion: string }>
  >();
  for (const [index, value] of response.jobs.entries()) {
    const job = asRecord(value);
    positiveSafeInteger(job.id, `publisher job ${index} id`);
    const attempt = positiveSafeInteger(job.run_attempt, `publisher job ${index} attempt`);
    if (job.run_id !== run.id || attempt > run.attempt || job.head_sha !== run.headSha) {
      throw new Error(`publisher job ${index} provenance does not match the selected run`);
    }
    if (typeof job.name !== "string" || job.name.length === 0) {
      throw new Error(`publisher job ${index} name is invalid`);
    }
    if (
      job.status !== "completed" ||
      typeof job.conclusion !== "string" ||
      !COMPLETED_CONCLUSIONS.has(job.conclusion)
    ) {
      throw new Error(`publisher job ${job.name} completion evidence is invalid; ${run.url}`);
    }
    const occurrences = jobsByName.get(job.name) ?? [];
    if (occurrences.some((occurrence) => occurrence.attempt === attempt)) {
      throw new Error(`publisher job ${job.name} is duplicated in attempt ${attempt}; ${run.url}`);
    }
    occurrences.push({ attempt, status: job.status, conclusion: job.conclusion });
    jobsByName.set(job.name, occurrences);
  }

  for (const requiredName of REQUIRED_PUBLISHER_JOBS) {
    const occurrences = jobsByName.get(requiredName) ?? [];
    if (occurrences.length === 0) {
      throw new Error(`missing required ${requiredName} job; ${run.url}`);
    }
    const latestAttempt = Math.max(...occurrences.map((occurrence) => occurrence.attempt));
    const latest = occurrences.find((occurrence) => occurrence.attempt === latestAttempt);
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(
        `latest ${requiredName} job did not complete successfully in attempt ${latestAttempt}; ${run.url}`,
      );
    }
  }
}

export function validateBoundRun(payload: unknown, expected: PublicationRun): void {
  const actual = validateRun(payload, 0, expected.workflowId);
  if (
    actual.id !== expected.id ||
    actual.attempt !== expected.attempt ||
    actual.headSha !== expected.headSha ||
    actual.status !== "completed" ||
    actual.conclusion !== "success"
  ) {
    throw new Error(
      `selected base-image workflow changed while evidence was verified; ${expected.url}`,
    );
  }
}

export async function collectPaginated(
  request: (path: string) => Promise<unknown>,
  basePath: string,
  collectionKey: "workflow_runs" | "jobs",
  maxPages = MAX_API_PAGES,
): Promise<JsonRecord> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("pagination page cap must be a positive integer");
  }
  const label = collectionKey === "workflow_runs" ? "workflow run" : "publisher job";
  const values: unknown[] = [];
  const ids = new Set<number>();
  let totalCount: number | undefined;
  const separator = basePath.includes("?") ? "&" : "?";

  for (let page = 1; page <= maxPages; page += 1) {
    const response = asRecord(await request(`${basePath}${separator}page=${page}`));
    const pageTotal = Number(response.total_count);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0) {
      throw new Error(`${label} total_count is invalid`);
    }
    if (totalCount === undefined) totalCount = pageTotal;
    if (pageTotal !== totalCount) {
      throw new Error(`${label} total_count changed during pagination`);
    }
    const pageValues = response[collectionKey];
    if (!Array.isArray(pageValues) || pageValues.length > PAGE_SIZE) {
      throw new Error(`${label} page ${page} must contain at most ${PAGE_SIZE} entries`);
    }
    const expectedLength = Math.min(PAGE_SIZE, totalCount - values.length);
    if (expectedLength < 0 || pageValues.length !== expectedLength) {
      throw new Error(`${label} pagination is incomplete`);
    }
    for (const [index, value] of pageValues.entries()) {
      const id = positiveSafeInteger(asRecord(value).id, `${label} page ${page} entry ${index} id`);
      if (ids.has(id)) throw new Error(`${label} pagination contains duplicate id ${id}`);
      ids.add(id);
      values.push(value);
    }
    if (values.length === totalCount) {
      return { total_count: totalCount, [collectionKey]: values };
    }
  }

  throw new Error(`${label} pagination exceeded the ${maxPages}-page safety cap`);
}

function annotationValue(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function publicationEvidenceError(error: unknown, run: PublicationRun): Error {
  const message = error instanceof Error ? error.message : "unknown publisher evidence error";
  const context: string[] = [];
  if (!message.includes(run.headSha)) context.push(`expected publisher SHA ${run.headSha}`);
  if (!message.includes(run.url)) context.push(run.url);
  return new Error([message, ...context].join("; "));
}

export async function waitForBaseImagePublication(
  options: PublicationWaitOptions,
): Promise<PublicationRun> {
  const now = options.now ?? performance.now.bind(performance);
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const notice =
    options.notice ?? ((message) => console.log(`::notice::${annotationValue(message)}`));
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0) {
    throw new Error("waitMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1) {
    throw new Error("pollMs must be a positive integer");
  }

  const deadline = now() + options.waitMs;
  const workflowId = validateWorkflow(
    await options.request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`),
  );
  const runsPath = `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${MAIN_BRANCH}&event=push&per_page=100`;
  while (true) {
    const runs = await collectPaginated(options.request, runsPath, "workflow_runs");
    const selection = selectPublicationRun(runs, options.history, workflowId);
    if (selection.state === "ready") {
      const jobsPath = `/repos/${REPOSITORY}/actions/runs/${selection.run.id}/jobs?filter=all&per_page=100`;
      if (now() > deadline) {
        throw new Error(
          `timed out validating base-image publication for ${selection.run.headSha}; ${selection.run.url}`,
        );
      }
      try {
        const jobs = await collectPaginated(options.request, jobsPath, "jobs");
        validatePublisherJobs(jobs, selection.run);
        validateBoundRun(
          await options.request(`/repos/${REPOSITORY}/actions/runs/${selection.run.id}`),
          selection.run,
        );
      } catch (error) {
        throw publicationEvidenceError(error, selection.run);
      }
      if (now() > deadline) {
        throw new Error(
          `timed out validating base-image publication for ${selection.run.headSha}; ${selection.run.url}`,
        );
      }
      return selection.run;
    }

    if (now() >= deadline) {
      const pending = selection.state === "pending" ? `; ${selection.run.url}` : "";
      throw new Error(
        `timed out waiting for base-image publication covering ${options.history.relevantSha}${pending}`,
      );
    }
    notice(
      selection.state === "pending"
        ? `Base-image publication is ${selection.run.status} for ${selection.run.headSha}; ${selection.run.url}`
        : `Waiting for a trusted base-image push run covering ${options.history.relevantSha}`,
    );
    await sleep(Math.min(options.pollMs, Math.max(1, deadline - now())));
  }
}

function retryDelay(response: Response, attempt: number, now: () => number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^(0|[1-9][0-9]*)$/u.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, MAX_RETRY_DELAY_MS);
  }
  if (retryAfter) {
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) {
      return Math.min(Math.max(0, retryDate - now()), MAX_RETRY_DELAY_MS);
    }
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^(0|[1-9][0-9]*)$/u.test(reset)) {
    return Math.min(Math.max(0, Number(reset) * 1000 - now()), MAX_RETRY_DELAY_MS);
  }
  return Math.min(attempt * 1000, MAX_RETRY_DELAY_MS);
}

export async function githubRequest(
  path: string,
  token: string,
  options: GithubRequestOptions = {},
): Promise<unknown> {
  if (!path.startsWith(`/repos/${REPOSITORY}/`) || path.includes("\r") || path.includes("\n")) {
    throw new Error("GitHub API path must stay within the canonical NemoClaw repository");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const now = options.now ?? Date.now;
  const attempts = options.attempts ?? REQUEST_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > REQUEST_ATTEMPTS) {
    throw new Error(`request attempts must be between 1 and ${REQUEST_ATTEMPTS}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) {
    throw new Error(`request timeout must be between 1 and ${REQUEST_TIMEOUT_MS} milliseconds`);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${API_ROOT}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "NemoClaw-base-image-publication-gate",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === attempts) {
        throw new Error(`GitHub API request failed after ${attempts} attempts`);
      }
      await sleep(Math.min(attempt * 1000, MAX_RETRY_DELAY_MS));
      continue;
    }

    if (!response.ok) {
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      const transient = response.status === 408 || response.status >= 500 || rateLimited;
      if (!transient || attempt === attempts) {
        throw new Error(`GitHub API request failed with HTTP ${response.status}`);
      }
      await sleep(retryDelay(response, attempt, now));
      continue;
    }
    try {
      return await response.json();
    } catch {
      throw new Error("GitHub API response was not valid JSON");
    }
  }

  throw new Error("GitHub API request failed unexpectedly");
}

function parseDurationArgument(argv: string[], name: string, defaultSeconds: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return defaultSeconds;
  if (index !== argv.lastIndexOf(name) || index + 1 >= argv.length) {
    throw new Error(`${name} must be provided exactly once with a value`);
  }
  const raw = argv[index + 1];
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) throw new Error(`${name} must be whole seconds`);
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)) throw new Error(`${name} is too large`);
  return seconds;
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const known = new Set(["--wait-seconds", "--poll-seconds"]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!known.has(argv[index]) || index + 1 >= argv.length) {
      throw new Error(`unsupported argument ${argv[index] ?? "missing"}`);
    }
  }
  const waitSeconds = parseDurationArgument(argv, "--wait-seconds", 3000);
  const pollSeconds = parseDurationArgument(argv, "--poll-seconds", 15);
  if (waitSeconds > 3000) throw new Error("--wait-seconds must not exceed 3000");
  if (pollSeconds < 1 || pollSeconds > 60) {
    throw new Error("--poll-seconds must be between 1 and 60");
  }

  const token = env.GITHUB_TOKEN ?? "";
  const expectedSha = env.EXPECTED_SHA ?? "";
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  if (token.length === 0 || token.includes("\r") || token.includes("\n")) {
    throw new Error("GITHUB_TOKEN must be a non-empty single-line value");
  }
  sha(expectedSha, "EXPECTED_SHA");
  if (env.GITHUB_REPOSITORY !== REPOSITORY) {
    throw new Error(`GITHUB_REPOSITORY must be ${REPOSITORY}`);
  }
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("GITHUB_REF must be refs/heads/main");
  }
  if (env.GITHUB_EVENT_NAME !== "schedule" && env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("GITHUB_EVENT_NAME must be schedule or workflow_dispatch");
  }
  if (env.GITHUB_SHA !== expectedSha) {
    throw new Error("EXPECTED_SHA must match GITHUB_SHA");
  }

  const workflowSource = readFileSync(resolve(workspace, WORKFLOW_PATH), "utf8");
  const paths = parseBaseImagePushPaths(workflowSource);
  const history = resolveFirstParentHistory(expectedSha, paths);
  const run = await waitForBaseImagePublication({
    history,
    request: (path) => githubRequest(path, token),
    waitMs: waitSeconds * 1000,
    pollMs: pollSeconds * 1000,
  });
  console.log(
    `::notice title=Base-image publication verified::${annotationValue(
      `All required publishers succeeded for ${run.headSha}; ${run.url}`,
    )}`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown base-image publication error";
    console.error(`::error title=Base-image publication gate failed::${annotationValue(message)}`);
    process.exitCode = 1;
  });
}
