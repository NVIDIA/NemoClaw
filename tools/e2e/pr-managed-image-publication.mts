// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
} from "../../src/lib/onboard/managed-image/contract.ts";
import { githubRequest } from "./base-image-publication.mts";
import {
  bindNamedExactArtifact,
  downloadBoundArtifact,
  materializeContractArchive,
} from "./exact-artifact-download.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_PATH = ".github/workflows/managed-images.yaml";
const WORKFLOW_FILE = "managed-images.yaml";
const WORKFLOW_NAME = "Images / Build, Test, and Publish Managed Images";
const MAX_CHANGED_FILES = 3_000;
const PAGE_SIZE = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/*-]+$/u;
const PUBLIC_PULL_REQUEST_METADATA_PATH =
  /^\/repos\/NVIDIA\/NemoClaw\/pulls\/[1-9][0-9]*(?:$|\/files(?:\?|$))/u;
const REUSABLE_NON_IMAGE_PATHS = [
  /^ci\/test-file-size-budget[.]json$/u,
  /^[.]github\/actions\/restore-e2e-cli-artifact\/action[.]yaml$/u,
  /^[.]github\/actions\/setup-native-podman-e2e\/action[.]yaml$/u,
  /^[.]github\/workflows\/e2e(?:-standard-profile)?[.]yaml$/u,
  /^scripts\/install[.]sh$/u,
  /^scripts\/checks\/run-managed-image-openshell-e2e[.]ts$/u,
  /^src\/lib\/actions\/maintenance(?:[.]test)?[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/connect-probe-observe[.]test[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/(?:gateway-failure-classifier|status-preflight)(?:[.]test)?[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/launch-readiness-ordinary-pairing[.]test[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/process-recovery[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/rebuild-dcode-mutation-edge[.]test[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/rebuild-dcode-preflight[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/rebuild-destroy-phase(?:[.]test)?[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/mcp-bridge-tool-discovery(?:[.]test)?[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/mcp-bridge-input-targets[.]test[.]ts$/u,
  /^src\/lib\/actions\/sandbox\/stopped-sandbox-backup(?:[.]test)?[.]ts$/u,
  /^src\/lib\/adapters\/podman\/index(?:[.]test)?[.]ts$/u,
  /^src\/lib\/inference\/serving\/profile-list[.]test[.]ts$/u,
  /^src\/lib\/onboard[.]ts$/u,
  /^src\/lib\/shields\/.*[.]ts$/u,
  /^src\/lib\/tunnel\/agent-forward-stop(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/credential-provider-registration(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/initial-policy-real-policy[.]test[.]ts$/u,
  /^src\/lib\/onboard\/managed-bootstrap\/docker-runtime(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/managed-bootstrap\/podman-bootstrap-replacement(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/managed-bootstrap\/podman-image-transaction(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/managed-bootstrap\/podman-runtime(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/managed-bootstrap\/runtime-create[.]ts$/u,
  /^src\/lib\/onboard\/managed-startup\/state-roots[.]ts$/u,
  /^src\/lib\/onboard\/sandbox-gpu-create-(?:flow|run-attempt)(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/managed-workload\/onboard-orchestration(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/machine\/finalization-deps(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/machine\/messaging-credential-convergence(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/runtime-provider\/(?:docker-state-mutation|podman-host-local-inference(?:-[a-z-]+)?|podman-runtime-surfaces|podman-state-mutation)(?:[.]test)?[.]ts$/u,
  /^src\/lib\/onboard\/sandbox-create\/orchestration[.]ts$/u,
  /^src\/lib\/onboard\/sandbox-workload-preparation[.]test[.]ts$/u,
  /^src\/lib\/onboard\/workload\/preparation[.]ts$/u,
  /^test\//u,
  /^tools\/e2e\//u,
] as const;

type JsonRecord = Record<string, unknown>;

export interface ManagedImagePublicationRun {
  readonly id: number;
  readonly attempt: number;
  readonly headSha: string;
}

export interface ManagedImagePublicationComparison {
  readonly changedFiles: readonly string[];
  readonly commits: number;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

function compileManagedImagePath(pattern: string): RegExp {
  if (
    !SAFE_PATH_PATTERN.test(pattern) ||
    pattern.startsWith("/") ||
    pattern.includes("//") ||
    pattern.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`managed-image PR path '${pattern}' is invalid`);
  }
  const stars = [...pattern.matchAll(/\*/gu)].map((match) => match.index);
  if (stars.length === 0) {
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
  }
  if (pattern.endsWith("/**") && stars.length === 2) {
    const prefix = pattern.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`^${prefix}/.+$`, "u");
  }
  if (stars.length === 1) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`, "u");
  }
  throw new Error(`managed-image PR path '${pattern}' uses an unsupported glob`);
}

function validateChangedFilePath(file: string): void {
  if (
    file.length === 0 ||
    file.length > 4_096 ||
    /[\0\r\n]/u.test(file) ||
    file.startsWith("/") ||
    file.includes("//") ||
    file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("PR changed-file path is invalid");
  }
}

/** Read the managed-image workflow path filter from the trusted workflow source. */
export function parseManagedImagePullRequestPaths(source: string): string[] {
  const workflow = record(YAML.parse(source), "managed-image workflow");
  const triggers = record(workflow.on, "managed-image workflow on block");
  const pullRequest = record(triggers.pull_request, "managed-image pull_request trigger");
  if (!Array.isArray(pullRequest.paths) || pullRequest.paths.length === 0) {
    throw new Error("managed-image pull_request trigger must declare paths");
  }
  const paths = pullRequest.paths.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new Error("managed-image PR paths must be non-empty strings");
    }
    compileManagedImagePath(value);
    return value;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("managed-image PR paths must be unique");
  }
  if (!paths.includes(WORKFLOW_PATH)) {
    throw new Error(`managed-image PR paths must include ${WORKFLOW_PATH}`);
  }
  return paths;
}

/** Determine whether changed PR files require exact managed-image publication. */
export function managedImagePublicationRequired(
  changedFiles: readonly string[],
  patterns: readonly string[],
): boolean {
  if (changedFiles.length > MAX_CHANGED_FILES * 2) {
    throw new Error(`PR changed-path count exceeds ${MAX_CHANGED_FILES * 2}`);
  }
  const matchers = patterns.map(compileManagedImagePath);
  for (const file of changedFiles) {
    validateChangedFilePath(file);
    if (matchers.some((matcher) => matcher.test(file))) return true;
  }
  return false;
}

/**
 * Allow an older exact PR publication only when every later change is outside
 * the managed-image Dockerfile inputs. This intentionally stays narrower than
 * the workflow trigger: the host installer and E2E planning/tests do not enter
 * any shipped managed image.
 */
export function managedImagePublicationReuseAllowed(changedFiles: readonly string[]): boolean {
  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`managed-image reuse changed-path count exceeds ${MAX_CHANGED_FILES}`);
  }
  return changedFiles.every((file) => {
    validateChangedFilePath(file);
    return REUSABLE_NON_IMAGE_PATHS.some((pattern) => pattern.test(file));
  });
}

/** Validate one complete ancestor comparison used as image-reuse authority. */
export function parseManagedImagePublicationComparison(
  payload: unknown,
  expected: { readonly candidateSha: string; readonly publicationSha: string },
): ManagedImagePublicationComparison {
  if (!SHA_PATTERN.test(expected.candidateSha) || !SHA_PATTERN.test(expected.publicationSha)) {
    throw new Error("managed-image reuse SHAs are invalid");
  }
  const comparison = record(payload, "managed-image publication comparison");
  exactString(
    record(comparison.base_commit, "managed-image comparison base").sha,
    expected.publicationSha,
    "managed-image comparison base commit",
  );
  exactString(
    record(comparison.merge_base_commit, "managed-image comparison merge base").sha,
    expected.publicationSha,
    "managed-image comparison merge base commit",
  );
  if (comparison.status !== "ahead" || comparison.behind_by !== 0) {
    throw new Error("managed-image publication must be an ancestor of the candidate");
  }
  const commits = positiveInteger(comparison.total_commits, "managed-image reuse commit count");
  if (commits > 250 || comparison.ahead_by !== commits) {
    throw new Error("managed-image reuse comparison is incomplete");
  }
  if (!Array.isArray(comparison.commits) || comparison.commits.length !== commits) {
    throw new Error("managed-image reuse commit listing is incomplete");
  }
  exactString(
    record(comparison.commits.at(-1), "managed-image comparison candidate").sha,
    expected.candidateSha,
    "managed-image comparison candidate commit",
  );
  if (
    !Array.isArray(comparison.files) ||
    comparison.files.length === 0 ||
    comparison.files.length >= 300
  ) {
    throw new Error("managed-image reuse changed-file listing is incomplete");
  }
  const changedFiles = comparison.files.flatMap((value) => {
    const file = record(value, "managed-image comparison file");
    if (typeof file.filename !== "string") {
      throw new Error("managed-image comparison file name is invalid");
    }
    const paths = [file.filename];
    if (file.previous_filename !== undefined) {
      if (typeof file.previous_filename !== "string") {
        throw new Error("managed-image comparison previous file name is invalid");
      }
      paths.push(file.previous_filename);
    }
    return paths;
  });
  if (!managedImagePublicationReuseAllowed(changedFiles)) {
    throw new Error("candidate changes managed-image inputs after the requested publication");
  }
  return { changedFiles: [...new Set(changedFiles)], commits };
}

/** Select the unique successful managed-image workflow run for one PR commit. */
export function selectManagedImagePublicationRun(
  payload: unknown,
  expected: { readonly headSha: string; readonly prNumber: number; readonly workflowId: number },
): ManagedImagePublicationRun {
  if (!SHA_PATTERN.test(expected.headSha)) throw new Error("candidate SHA is invalid");
  positiveInteger(expected.prNumber, "PR number");
  positiveInteger(expected.workflowId, "managed-image workflow id");
  const response = record(payload, "managed-image workflow runs");
  if (response.total_count !== 1 || !Array.isArray(response.workflow_runs)) {
    throw new Error("exact managed-image workflow run is missing or ambiguous");
  }
  if (response.workflow_runs.length !== 1) {
    throw new Error("exact managed-image workflow run listing is incomplete");
  }
  const run = record(response.workflow_runs[0], "managed-image workflow run");
  const id = positiveInteger(run.id, "managed-image workflow run id");
  const attempt = positiveInteger(run.run_attempt, "managed-image workflow run attempt");
  if (run.workflow_id !== expected.workflowId) {
    throw new Error("managed-image workflow run does not match the trusted workflow");
  }
  exactString(run.name, WORKFLOW_NAME, "managed-image workflow run name");
  exactString(run.path, WORKFLOW_PATH, "managed-image workflow run path");
  exactString(run.event, "pull_request", "managed-image workflow run event");
  exactString(run.head_sha, expected.headSha, "managed-image workflow run commit");
  exactString(
    record(run.repository, "managed-image workflow repository").full_name,
    REPOSITORY,
    "managed-image workflow repository",
  );
  exactString(
    record(run.head_repository, "managed-image workflow source repository").full_name,
    REPOSITORY,
    "managed-image workflow source repository",
  );
  if (
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1 ||
    record(run.pull_requests[0], "managed-image workflow pull request").number !== expected.prNumber
  ) {
    throw new Error("managed-image workflow run does not match the PR number");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `managed-image workflow for candidate ${expected.headSha} must complete successfully before live E2E`,
    );
  }
  return { id, attempt, headSha: expected.headSha };
}

/** Assemble one all-agent catalog and reject mixed publication authority. */
export function assembleManagedImageCatalog(
  values: readonly unknown[],
  candidateSha: string,
): ManagedImageContractCatalog {
  if (!SHA_PATTERN.test(candidateSha)) throw new Error("candidate SHA is invalid");
  if (values.length !== SHIPPED_MANAGED_IMAGE_AGENTS.length) {
    throw new Error(
      `exact PR managed-image publication requires ${SHIPPED_MANAGED_IMAGE_AGENTS.length} contracts`,
    );
  }
  const contracts = values.map((value) =>
    parseManagedImageContractV1(value, undefined, "linux/amd64"),
  );
  const byAgent = new Map(contracts.map((contract) => [contract.agent, contract]));
  if (
    byAgent.size !== SHIPPED_MANAGED_IMAGE_AGENTS.length ||
    SHIPPED_MANAGED_IMAGE_AGENTS.some((agent) => !byAgent.has(agent))
  ) {
    throw new Error("exact PR managed-image publication must contain every shipped agent once");
  }
  const revisions = new Set(contracts.map((contract) => contract.source.revision));
  const releases = new Set(contracts.map((contract) => contract.source.release));
  const cohorts = new Set(contracts.map((contract) => contract.source.cohort));
  if (!revisions.has(candidateSha) || revisions.size !== 1) {
    throw new Error("exact PR managed-image contracts do not match the candidate commit");
  }
  if (releases.size !== 1 || cohorts.size !== 1) {
    throw new Error("exact PR managed-image contracts do not form one publication cohort");
  }
  return Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => [agent, byAgent.get(agent)!]),
  );
}

/** Write one validated exact-candidate catalog from local contract paths. */
export function writeManagedImageCatalog(
  contractPaths: readonly string[],
  candidateSha: string,
  outputPath: string,
): void {
  const contracts = contractPaths.map(
    (contractPath) => JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown,
  );
  const catalog = assembleManagedImageCatalog(contracts, candidateSha);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { mode: 0o700, recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function validateWorkflow(payload: unknown): number {
  const workflow = record(payload, "managed-image workflow");
  const id = positiveInteger(workflow.id, "managed-image workflow id");
  exactString(workflow.name, WORKFLOW_NAME, "managed-image workflow name");
  exactString(workflow.path, WORKFLOW_PATH, "managed-image workflow path");
  exactString(workflow.state, "active", "managed-image workflow state");
  return id;
}

async function readChangedFiles(
  prNumber: number,
  count: number,
  request: (path: string) => Promise<unknown>,
): Promise<string[]> {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CHANGED_FILES) {
    throw new Error("PR changed-file count is invalid");
  }
  const files: string[] = [];
  let listedFiles = 0;
  for (let page = 1; listedFiles < count; page += 1) {
    if (page > Math.ceil(MAX_CHANGED_FILES / PAGE_SIZE)) {
      throw new Error("PR changed-file pagination exceeded the safety cap");
    }
    const payload = await request(
      `/repos/${REPOSITORY}/pulls/${prNumber}/files?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(payload) || payload.length === 0 || payload.length > PAGE_SIZE) {
      throw new Error("PR changed-file page is invalid or incomplete");
    }
    for (const value of payload) {
      const file = record(value, "PR changed file");
      if (typeof file.filename !== "string") throw new Error("PR changed-file name is invalid");
      files.push(file.filename);
      if (file.previous_filename !== undefined) {
        if (typeof file.previous_filename !== "string") {
          throw new Error("PR previous changed-file name is invalid");
        }
        files.push(file.previous_filename);
      }
      listedFiles += 1;
    }
  }
  if (listedFiles !== count) {
    throw new Error("PR changed-file listing is incomplete");
  }
  return [...new Set(files)];
}

function validatePr(
  payload: unknown,
  expected: { readonly baseSha: string; readonly candidateSha: string; readonly prNumber: number },
): number {
  const pull = record(payload, "pull request");
  exactString(pull.state, "open", "pull request state");
  exactString(
    record(pull.base, "pull request base").sha,
    expected.baseSha,
    "pull request base commit",
  );
  exactString(
    record(pull.head, "pull request source").sha,
    expected.candidateSha,
    "pull request source commit",
  );
  exactString(
    record(record(pull.base, "pull request base").repo, "pull request base repository").full_name,
    REPOSITORY,
    "pull request base repository",
  );
  exactString(
    record(record(pull.head, "pull request source").repo, "pull request source repository")
      .full_name,
    REPOSITORY,
    "pull request source repository",
  );
  return positiveInteger(pull.changed_files, "PR changed-file count");
}

/** Resolve and download the exact all-agent catalog before candidate code executes. */
export async function resolvePrManagedImageCatalog(
  input: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
    readonly outputPath: string;
    readonly publicationSha?: string;
    readonly prNumber: number;
    readonly token: string;
    readonly workflowSource: string;
  },
  request: (path: string) => Promise<unknown> = (apiPath) =>
    githubRequest(apiPath, input.token, {
      authenticated: !PUBLIC_PULL_REQUEST_METADATA_PATH.test(apiPath),
    }),
): Promise<"not-required" | "reused" | "written"> {
  if (input.candidateRepository !== REPOSITORY) return "not-required";
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("PR base and candidate SHAs are required");
  }
  positiveInteger(input.prNumber, "PR number");
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  const changedCount = validatePr(
    await request(`/repos/${REPOSITORY}/pulls/${input.prNumber}`),
    input,
  );
  const changedFiles = await readChangedFiles(input.prNumber, changedCount, request);
  const patterns = parseManagedImagePullRequestPaths(input.workflowSource);
  if (!managedImagePublicationRequired(changedFiles, patterns)) return "not-required";

  const publicationSha = input.publicationSha?.trim() || input.candidateSha;
  if (!SHA_PATTERN.test(publicationSha)) {
    throw new Error("managed-image publication SHA is invalid");
  }
  if (publicationSha !== input.candidateSha) {
    parseManagedImagePublicationComparison(
      await request(`/repos/${REPOSITORY}/compare/${publicationSha}...${input.candidateSha}`),
      { candidateSha: input.candidateSha, publicationSha },
    );
  }

  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`),
  );
  const runs = await request(
    `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?event=pull_request&head_sha=${publicationSha}&per_page=100`,
  );
  const run = selectManagedImagePublicationRun(runs, {
    headSha: publicationSha,
    prNumber: input.prNumber,
    workflowId,
  });

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-managed-catalog-"));
  try {
    const contracts: ManagedImageContractV1[] = [];
    for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
      const name = `managed-pr-contract-${run.id}-${run.attempt}-${agent}`;
      const metadata = await request(
        `/repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      );
      const identity = bindNamedExactArtifact(
        metadata,
        {
          headSha: run.headSha,
          runAttempt: run.attempt,
          runId: run.id,
        },
        name,
      );
      const archive = await downloadBoundArtifact(identity, input.token);
      const contractPath = materializeContractArchive(archive, path.join(tempDirectory, agent));
      contracts.push(
        JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown as ManagedImageContractV1,
      );
    }
    const catalog = assembleManagedImageCatalog(contracts, publicationSha);
    fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { mode: 0o700, recursive: true });
    fs.writeFileSync(input.outputPath, `${JSON.stringify(catalog)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return publicationSha === input.candidateSha ? "written" : "reused";
  } finally {
    fs.rmSync(tempDirectory, { force: true, recursive: true });
  }
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv[0] === "assemble") {
    if (argv.length < 4) {
      throw new Error("expected candidate SHA, output path, and managed-image contract paths");
    }
    writeManagedImageCatalog(argv.slice(3), argv[1], argv[2]);
    console.log("pr-managed-image-catalog outcome=assembled");
    return;
  }
  if (argv.length !== 1) throw new Error("expected one managed-image catalog output path");
  const candidateSha = env.CANDIDATE_SHA ?? "";
  if (!candidateSha) return;
  const result = await resolvePrManagedImageCatalog({
    baseSha: env.BASE_SHA ?? "",
    candidateRepository: env.CANDIDATE_REPOSITORY ?? "",
    candidateSha,
    outputPath: argv[0],
    publicationSha: env.MANAGED_IMAGE_PUBLICATION_SHA,
    prNumber: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
    token: env.GITHUB_TOKEN ?? "",
    workflowSource: fs.readFileSync(WORKFLOW_PATH, "utf8"),
  });
  console.log(`pr-managed-image-catalog outcome=${result}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown PR managed-image error");
    process.exitCode = 1;
  }
}
