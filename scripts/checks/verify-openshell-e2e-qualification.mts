// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readValidatedArtifactZipEntry } from "../scorecard/read-artifact-zip.mts";
import { extractInstallerPins } from "./extract-installer-pins.mts";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const SAFE_PATH_PATTERN = /^[^\u0000-\u001f\u007f\\]{1,4096}$/u;
const SAFE_JOB_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PR_FILE_PAGES = 30;
const MAX_WORKFLOW_RUNS = 2_000;
const MAX_RUN_ARTIFACTS = 1_000;
const MAX_RUN_JOBS = 500;
const MAX_CHECK_RUNS = 1_000;
const PAGE_SIZE = 100;
const E2E_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const E2E_WORKFLOW_FILE = "e2e.yaml";
const DISPATCH_KIND = "nemoclaw-e2e-dispatch-v2";
const DISPATCH_FILE = "dispatch.json";

export const REQUIRED_PROOF_CHECKS = {
  managed: "PR exact all-agent managed runtime activation",
  rootless: "Rootless Podman CPU lifecycle with Docker disabled",
} as const;

const OPTIONAL_SKIPPED_E2E_JOBS = new Set([
  "retired-selector-compatibility",
  "Exact staging Brev Launchable",
  "jetson-nvmap-gpu",
  "Compile protected llama.cpp DGX Spark plan",
  "Protected llama.cpp on NVIDIA DGX Spark",
  "report-to-pr",
  "scorecard",
]);

const REQUIRED_CONTROLLER_TARGET_PREFIXES = [
  "live (ubuntu-policy-custom-missing-presets-negative,",
  "live (ubuntu-repo-cloud-langchain-deepagents-code,",
  "live (ubuntu-repo-cloud-openclaw,",
  "live (ubuntu-repo-docker-post-reboot-recovery,",
] as const;

const KNOWN_FILE_STATUSES = new Set([
  "added",
  "changed",
  "copied",
  "modified",
  "removed",
  "renamed",
  "unchanged",
]);

const KNOWN_RUN_STATUSES = new Set([
  "completed",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);

const SENSITIVE_EXACT_PATHS = new Set([
  ".dockerignore",
  ".github/workflows/e2e.yaml",
  ".github/workflows/managed-images.yaml",
  ".github/workflows/podman-cpu-proof.yaml",
  "Dockerfile",
  "nemoclaw-blueprint/blueprint.yaml",
  "nemoclaw/src/shared/openshell-policy-boundary.cts",
  "schemas/blueprint.schema.json",
  "scripts/brev-launchable-ci-cpu.sh",
  "scripts/check-installer-hash.sh",
  "scripts/checks/dependency-pins.mts",
  "scripts/checks/extract-installer-pins.mts",
  "scripts/checks/managed-image-protected-runtime-contract.ts",
  "scripts/checks/verify-openshell-e2e-qualification.mts",
  "scripts/install-openshell.sh",
  "scripts/install.sh",
  "scripts/nemoclaw-start.sh",
  "src/lib/gateway-runtime-action.ts",
  "src/lib/inference/serving/managed-runtime-receipts.ts",
  "src/lib/onboard/gateway-host-runtime.ts",
  "test/openshell-e2e-qualification.test.ts",
  "tools/e2e/openshell-gateway-upgrade-workflow-boundary.mts",
]);

const SENSITIVE_PREFIXES = [
  ".github/actions/ci-installer-hash-check/",
  ".github/actions/prepare-e2e/",
  ".github/actions/restore-e2e-cli-artifact/",
  ".github/actions/upload-e2e-artifacts/",
  ".github/actions/verify-openshell-e2e-qualification/",
  "agents/hermes/",
  "agents/langchain-deepagents-code/",
  "agents/openclaw/",
  "nemoclaw-blueprint/model-specific-setup/",
  "nemoclaw-blueprint/openclaw-plugins/",
  "nemoclaw/src/blueprint/",
  "scripts/lib/openshell-",
  "src/lib/adapters/openshell/",
  "src/lib/adapters/sandbox/command-transport",
  "src/lib/onboard/managed-bootstrap/",
  "src/lib/onboard/managed-startup",
  "src/lib/onboard/openshell-",
  "src/lib/sandbox/version",
  "test/e2e/live/openshell-gateway-upgrade",
  "test/e2e/live/podman-cpu-lifecycle",
  "test/e2e/support/openshell-gateway-upgrade",
  "test/e2e/support/podman-cpu-proof-workflow",
] as const;

const MANAGED_PROOF_EXACT_PATHS = new Set([
  ".dockerignore",
  ".github/workflows/managed-images.yaml",
  "Dockerfile",
  "ci/npm-audit-exceptions.json",
  "src/lib/core/json-types.ts",
  "src/lib/core/ports.ts",
  "src/lib/security/credential-hash.ts",
  "src/lib/state/paths.ts",
  "src/lib/state/state-root.ts",
  "src/lib/tool-disclosure.ts",
  "tsconfig.runtime-preloads.json",
]);

const MANAGED_PROOF_PREFIXES = [
  "agents/",
  "nemoclaw/",
  "nemoclaw-blueprint/",
  "scripts/",
  "src/lib/messaging/",
  "src/lib/onboard/",
  "test/e2e/live/managed-image-activation-e2e",
  "tools/mcp-tool-discovery-runtime/",
] as const;

const ROOTLESS_PROOF_EXACT_PATHS = new Set([
  ".github/workflows/podman-cpu-proof.yaml",
  "scripts/install-openshell.sh",
  "src/lib/adapters/container-engine.ts",
  "src/lib/onboard/experimental/portable-demo-lifecycle.test.ts",
  "src/lib/onboard/experimental/portable-demo-lifecycle.ts",
  "test/e2e/live/podman-cpu-lifecycle-artifacts.ts",
  "test/e2e/live/podman-cpu-lifecycle-helpers.ts",
  "test/e2e/live/podman-cpu-lifecycle-policy.yaml",
  "test/e2e/live/podman-cpu-lifecycle.test.ts",
  "test/e2e/support/podman-cpu-proof-workflow.test.ts",
]);

const ROOTLESS_PROOF_PREFIXES = [
  "src/lib/adapters/podman/",
  "src/lib/onboard/docker-driver-gateway-",
  "src/lib/onboard/managed-bootstrap/podman-",
  "src/lib/onboard/runtime-provider/podman",
] as const;

export type PullRequestFile = {
  filename: string;
  previousFilename?: string;
  status: string;
};

export type PullRequestIdentity = {
  baseSha: string;
  candidateRepository: string;
  candidateSha: string;
  number: number;
  repository: string;
};

export type E2EDispatchReceipt = {
  allowDgxSparkRunnerQueue: boolean;
  allowJetsonRunnerQueue: boolean;
  baseSha: string;
  candidateRepository: string;
  candidateSha: string;
  emptySelectors: boolean;
  eventName: "workflow_dispatch";
  includeStagingBrevLaunchable: boolean;
  jobs: "";
  kind: typeof DISPATCH_KIND;
  prNumber: number;
  repository: string;
  targets: "";
  workflowRunAttempt: number;
  workflowRunId: string;
  workflowSha: string;
};

type E2EDispatchReceiptEnvelope = Omit<
  E2EDispatchReceipt,
  | "allowDgxSparkRunnerQueue"
  | "allowJetsonRunnerQueue"
  | "emptySelectors"
  | "includeStagingBrevLaunchable"
  | "jobs"
  | "targets"
> & {
  allowDgxSparkRunnerQueue: boolean;
  allowJetsonRunnerQueue: boolean;
  emptySelectors: boolean;
  includeStagingBrevLaunchable: boolean;
  jobs: string;
  targets: string;
};

export type QualificationJobEvidence = {
  conclusion: "skipped" | "success";
  name: string;
  url: string;
};

export type QualificationCheckEvidence = {
  conclusion: "success";
  name: string;
  url: string;
};

export type QualificationEvidence = {
  baselineVersion?: string;
  baseSha: string;
  candidateRepository: string;
  candidateSha: string;
  changedFileCount: number;
  e2e?: {
    jobs: QualificationJobEvidence[];
    runAttempt: number;
    runId: number;
    url: string;
    workflowSha: string;
  };
  exercisedUpgradeVersion?: string;
  proofChecks: QualificationCheckEvidence[];
  qualificationRequired: boolean;
  repository: string;
  requiredProofChecks: string[];
  schemaVersion: 1;
  sensitiveFileCount: number;
  sensitiveFiles: string[];
  sensitiveFilesTruncated: boolean;
  status: "not-required" | "qualified";
  targetVersion?: string;
};

export type GitHubReader = {
  getBytes(apiPath: string): Promise<Buffer>;
  getJson(apiPath: string): Promise<unknown>;
};

export type QualificationDependencies = {
  api: GitHubReader;
  loadReceipt?: (artifact: WorkflowArtifact, api: GitHubReader) => Promise<unknown>;
  readVersion?: (root: string) => string;
};

export type VerifyQualificationInput = {
  baseRoot: string;
  baseSha: string;
  candidateRoot: string;
  candidateSha: string;
  prNumber: number;
  repository: string;
  workflowSha: string;
};

type WorkflowIdentity = {
  id: number;
};

type WorkflowRun = {
  conclusion: string | null;
  event: string;
  headSha: string;
  id: number;
  path: string;
  repository: string;
  runAttempt: number;
  status: string;
  url: string;
  workflowId: number;
};

export type WorkflowArtifact = {
  archivePath: string;
  expired: boolean;
  id: number;
  name: string;
  runId: number;
  workflowSha: string;
};

type WorkflowJob = {
  conclusion: string | null;
  id: number;
  name: string;
  runAttempt: number;
  runId: number;
  status: string;
  url: string;
};

type CheckRun = {
  conclusion: string | null;
  headSha: string;
  id: number;
  name: string;
  status: string;
  url: string;
};

function fail(message: string): never {
  throw new Error(`OpenShell E2E qualification failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has an unexpected schema`);
  }
}

function validateRepository(repository: string): void {
  if (!REPOSITORY_PATTERN.test(repository)) fail("repository is invalid");
}

function validateSha(sha: string, label: string): void {
  if (!SHA_PATTERN.test(sha)) fail(`${label} must be a lowercase 40-character SHA`);
}

export function validateRepositoryPath(value: unknown, label = "path"): string {
  if (typeof value !== "string" || !SAFE_PATH_PATTERN.test(value)) {
    fail(`${label} is invalid`);
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path.posix.normalize(value) !== value
  ) {
    fail(`${label} is not a canonical repository-relative path`);
  }
  return value;
}

export function validatePullRequestFile(value: unknown): PullRequestFile {
  if (!isRecord(value)) fail("pull-request files response contains a non-object entry");
  const filename = validateRepositoryPath(value.filename, "pull-request filename");
  if (typeof value.status !== "string" || !KNOWN_FILE_STATUSES.has(value.status)) {
    fail(`pull-request file ${filename} has unknown status`);
  }
  if (value.status === "renamed") {
    const previousFilename = validateRepositoryPath(
      value.previous_filename,
      "renamed pull-request previous_filename",
    );
    if (previousFilename === filename) fail(`renamed pull-request file ${filename} did not move`);
    return { filename, previousFilename, status: value.status };
  }
  if (value.previous_filename !== undefined) {
    fail(`non-renamed pull-request file ${filename} unexpectedly has previous_filename`);
  }
  return { filename, status: value.status };
}

function pathsForFile(file: PullRequestFile): string[] {
  return file.previousFilename ? [file.previousFilename, file.filename] : [file.filename];
}

function matchesExactOrPrefix(
  candidatePath: string,
  exact: ReadonlySet<string>,
  prefixes: readonly string[],
): boolean {
  return exact.has(candidatePath) || prefixes.some((prefix) => candidatePath.startsWith(prefix));
}

export function isOpenShellQualificationSensitivePath(candidatePath: string): boolean {
  validateRepositoryPath(candidatePath, "qualification candidate path");
  if (matchesExactOrPrefix(candidatePath, SENSITIVE_EXACT_PATHS, SENSITIVE_PREFIXES)) return true;
  if (/^agents\/[^/]+\/(?:manifest\.yaml|state-lock-plan\.json)$/u.test(candidatePath)) return true;
  if (
    /^src\/lib\/actions\/sandbox\/openshell-child-visible-credentials\.v[^/]+\.json$/u.test(
      candidatePath,
    )
  ) {
    return true;
  }
  if (
    /^src\/lib\/(?:actions\/sandbox|onboard)\/[^/]*(?:gateway|supervisor)[^/]*\.(?:ts|json)$/u.test(
      candidatePath,
    )
  ) {
    return true;
  }
  if (
    /^\.github\/workflows\/[^/]*(?:openshell|runtime|qualification)[^/]*\.ya?ml$/u.test(
      candidatePath,
    )
  ) {
    return true;
  }
  return false;
}

export function classifyQualification(files: readonly PullRequestFile[]): {
  required: boolean;
  requiredProofChecks: string[];
  sensitivePaths: string[];
} {
  const allPaths = files.flatMap(pathsForFile);
  const sensitivePaths = [
    ...new Set(allPaths.filter(isOpenShellQualificationSensitivePath)),
  ].sort();
  const requiredProofChecks: string[] = [];
  if (
    allPaths.some((candidatePath) =>
      matchesExactOrPrefix(candidatePath, MANAGED_PROOF_EXACT_PATHS, MANAGED_PROOF_PREFIXES),
    ) ||
    allPaths.some((candidatePath) =>
      /^src\/lib\/actions\/sandbox\/openshell-child-visible-credentials\.v[^/]+\.json$/u.test(
        candidatePath,
      ),
    )
  ) {
    requiredProofChecks.push(REQUIRED_PROOF_CHECKS.managed);
  }
  if (
    allPaths.some((candidatePath) =>
      matchesExactOrPrefix(candidatePath, ROOTLESS_PROOF_EXACT_PATHS, ROOTLESS_PROOF_PREFIXES),
    )
  ) {
    requiredProofChecks.push(REQUIRED_PROOF_CHECKS.rootless);
  }
  return { required: sensitivePaths.length > 0, requiredProofChecks, sensitivePaths };
}

export async function loadPullRequestFiles(
  api: GitHubReader,
  repository: string,
  prNumber: number,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  const filenames = new Set<string>();
  for (let page = 1; page <= MAX_PR_FILE_PAGES; page += 1) {
    const value = await api.getJson(
      `repos/${repository}/pulls/${prNumber}/files?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(value) || value.length > PAGE_SIZE) {
      fail(`pull-request files page ${page} is malformed`);
    }
    for (const item of value) {
      const file = validatePullRequestFile(item);
      if (filenames.has(file.filename))
        fail(`pull-request filename ${file.filename} is duplicated`);
      filenames.add(file.filename);
      files.push(file);
    }
    if (value.length < PAGE_SIZE) return files;
  }
  fail("pull-request files pagination is incomplete or exceeds GitHub's 3,000-file limit");
}

function validatePullRequest(
  value: unknown,
  expected: VerifyQualificationInput,
): PullRequestIdentity {
  if (
    !isRecord(value) ||
    value.number !== expected.prNumber ||
    value.state !== "open" ||
    !isRecord(value.head) ||
    !isRecord(value.head.repo) ||
    !isRecord(value.base) ||
    !isRecord(value.base.repo) ||
    typeof value.head.sha !== "string" ||
    typeof value.head.repo.full_name !== "string" ||
    typeof value.base.sha !== "string" ||
    value.base.repo.full_name !== expected.repository
  ) {
    fail("live pull-request identity is malformed, closed, or belongs to another base repository");
  }
  validateSha(value.head.sha, "live pull-request head");
  validateSha(value.base.sha, "live pull-request base");
  validateRepository(value.head.repo.full_name);
  if (
    value.head.sha !== expected.candidateSha ||
    value.base.sha !== expected.baseSha ||
    expected.workflowSha !== expected.baseSha
  ) {
    fail("requested head, base, or trusted workflow SHA is stale");
  }
  return {
    baseSha: value.base.sha,
    candidateRepository: value.head.repo.full_name,
    candidateSha: value.head.sha,
    number: expected.prNumber,
    repository: expected.repository,
  };
}

function readBoundedRootFile(root: string, relativePath: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const rootStats = fs.lstatSync(canonicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    fail(`${root} is not a real directory`);
  let cursor = canonicalRoot;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) fail(`${relativePath} crosses a symbolic link`);
    if (index < parts.length - 1 && !stats.isDirectory())
      fail(`${relativePath} has an invalid parent`);
    if (index === parts.length - 1 && (!stats.isFile() || stats.size > 1024 * 1024)) {
      fail(`${relativePath} must be a regular file no larger than 1 MiB`);
    }
  }
  const resolved = fs.realpathSync(cursor);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) fail(`${relativePath} escapes its root`);
  return fs.readFileSync(resolved, "utf8");
}

function exactVersion(source: string, pattern: RegExp, label: string, capture = 1): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  const version = matches[0]?.[capture];
  if (matches.length !== 1 || !version || !VERSION_PATTERN.test(version)) {
    fail(`${label} must contain exactly one literal X.Y.Z version`);
  }
  return version;
}

export function extractOpenShellVersion(root: string): string {
  const installer = readBoundedRootFile(root, "scripts/install-openshell.sh");
  const brev = readBoundedRootFile(root, "scripts/brev-launchable-ci-cpu.sh");
  const blueprint = readBoundedRootFile(root, "nemoclaw-blueprint/blueprint.yaml");
  const installerPins = extractInstallerPins(installer, {
    functionName: "openshell_pinned_sha256",
    sourceLabel: "installer",
  });
  const brevPins = extractInstallerPins(brev, {
    functionName: "openshell_cli_pinned_sha256",
    sourceLabel: "Brev launchable",
  });
  const versions = [
    ...installerPins.map((pin) => pin.releaseVersion),
    ...brevPins.map((pin) => pin.releaseVersion),
    exactVersion(
      installer,
      /^MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gmu,
      "installer MIN_VERSION",
    ),
    exactVersion(
      installer,
      /^MAX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gmu,
      "installer MAX_VERSION",
    ),
    exactVersion(
      installer,
      /^DEV_MIN_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gmu,
      "installer DEV_MIN_VERSION",
    ),
    exactVersion(
      brev,
      /^\s*stable\s*\|\s*auto\)\s*OPENSHELL_VERSION="v([0-9]+\.[0-9]+\.[0-9]+)"\s*;;\s*$/gmu,
      "Brev stable OpenShell version",
    ),
    exactVersion(
      blueprint,
      /^max_openshell_version:\s*(["'])([0-9]+\.[0-9]+\.[0-9]+)\1\s*$/gmu,
      "blueprint max_openshell_version",
      2,
    ),
  ];
  const unique = [...new Set(versions)].sort();
  if (unique.length !== 1) fail(`OpenShell version surfaces disagree: ${unique.join(", ")}`);
  return unique[0] ?? fail("OpenShell version is missing");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function extractUpgradeFixtureRequirement(
  baseRoot: string,
  baselineVersion: string,
  targetVersion: string,
): { jobNames: string[]; version: string } {
  const workflow = readBoundedRootFile(baseRoot, E2E_WORKFLOW_PATH);
  const lines = workflow.split(/\r?\n/u);
  const jobStart = lines.indexOf("  openshell-gateway-upgrade:");
  if (jobStart < 0) fail("trusted E2E workflow has no OpenShell gateway upgrade job");
  const envOffset = lines.slice(jobStart + 1).findIndex((line) => line === "    env:");
  if (envOffset < 0) fail("trusted E2E upgrade matrix is incomplete");
  const matrixLines = lines.slice(jobStart + 1, jobStart + 1 + envOffset);
  const fixtures: Array<{ id: string; version: string }> = [];
  let currentId: string | undefined;
  for (const line of matrixLines) {
    const id = /^          - id: ([A-Za-z0-9._-]+)$/u.exec(line)?.[1];
    if (id) {
      if (currentId) fail(`trusted E2E fixture ${currentId} has no openshell_version`);
      currentId = id;
      continue;
    }
    const version = /^            openshell_version: ([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(line)?.[1];
    if (version) {
      if (!currentId) fail("trusted E2E upgrade version has no fixture id");
      fixtures.push({ id: currentId, version });
      currentId = undefined;
    }
  }
  if (currentId) fail(`trusted E2E fixture ${currentId} has no openshell_version`);
  const selectedVersion =
    baselineVersion !== targetVersion
      ? baselineVersion
      : fixtures
          .map((fixture) => fixture.version)
          .filter((version) => compareVersions(version, targetVersion) < 0)
          .sort((left, right) => compareVersions(right, left))[0];
  if (!selectedVersion) {
    fail(`trusted E2E matrix has no predecessor fixture below target ${targetVersion}`);
  }
  const matching = fixtures.filter((fixture) => fixture.version === selectedVersion);
  if (matching.length === 0) fail(`trusted E2E matrix has no ${selectedVersion} upgrade fixture`);
  const ids = matching.map((fixture) => fixture.id);
  if (new Set(ids).size !== ids.length)
    fail(`trusted E2E ${selectedVersion} fixture ids are duplicated`);
  return {
    jobNames: ids.sort().map((id) => `OpenShell gateway upgrade (${id})`),
    version: selectedVersion,
  };
}

function extractSharedE2EJobRequirements(baseRoot: string): string[] {
  const workflow = readBoundedRootFile(baseRoot, E2E_WORKFLOW_PATH);
  const lines = workflow.split(/\r?\n/u);
  const controllerStart = lines.findIndex((line) => line === "      - id: controller_matrix");
  const controllerEnd = lines.findIndex(
    (line, index) => index > controllerStart && line === "      - id: runner_routing",
  );
  if (controllerStart < 0 || controllerEnd < 0) {
    fail("trusted E2E controller matrix boundary is missing");
  }
  const assignments = lines.slice(controllerStart + 1, controllerEnd).flatMap((line) => {
    const value = /^\s*test_matrix='([^']+)'\s*$/u.exec(line)?.[1];
    if (!value) return [];
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      fail("trusted E2E controller test matrix is not valid JSON");
    }
  });
  const nonEmpty = assignments.filter((value) => Array.isArray(value) && value.length > 0);
  if (
    assignments.length < 2 ||
    assignments.some((value) => !Array.isArray(value)) ||
    nonEmpty.length !== 1
  ) {
    fail("trusted E2E controller must define exactly one nonempty default test matrix");
  }
  const rows = nonEmpty[0] as unknown[];
  const ids = new Set<string>();
  const names: string[] = [];
  for (const value of rows) {
    if (!isRecord(value)) fail("trusted E2E controller test matrix contains a non-object row");
    assertExactKeys(value, ["file", "id", "project"], "trusted E2E controller test row");
    if (
      typeof value.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
      typeof value.file !== "string" ||
      !/^test\/(?!e2e\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.(?:js|ts)$/u.test(
        value.file,
      ) ||
      value.project !== "integration"
    ) {
      fail("trusted E2E controller test matrix row is malformed or unsupported");
    }
    validateRepositoryPath(value.file, "trusted E2E controller test file");
    if (ids.has(value.id)) fail(`trusted E2E controller test id ${value.id} is duplicated`);
    ids.add(value.id);
    names.push(`Shared E2E (${value.id})`);
  }
  if (names.length === 0) fail("trusted E2E controller default test matrix is empty");
  return names.sort();
}

export function validateDispatchReceipt(
  value: unknown,
  expected: PullRequestIdentity & { runAttempt: number; runId: number; workflowSha: string },
): E2EDispatchReceipt {
  const receipt = validateDispatchReceiptEnvelope(value, expected);
  if (
    receipt.jobs !== "" ||
    receipt.targets !== "" ||
    receipt.emptySelectors !== true ||
    receipt.allowDgxSparkRunnerQueue !== false ||
    receipt.allowJetsonRunnerQueue !== false ||
    receipt.includeStagingBrevLaunchable !== false
  ) {
    fail("trusted E2E dispatch receipt is stale, selective, or identity-mismatched");
  }
  return receipt as E2EDispatchReceipt;
}

function validateDispatchReceiptEnvelope(
  value: unknown,
  expected: PullRequestIdentity & { runAttempt: number; runId: number; workflowSha: string },
): E2EDispatchReceiptEnvelope {
  if (!isRecord(value)) fail("trusted E2E dispatch receipt is not an object");
  assertExactKeys(
    value,
    [
      "allowDgxSparkRunnerQueue",
      "allowJetsonRunnerQueue",
      "baseSha",
      "candidateRepository",
      "candidateSha",
      "emptySelectors",
      "eventName",
      "includeStagingBrevLaunchable",
      "jobs",
      "kind",
      "prNumber",
      "repository",
      "targets",
      "workflowRunAttempt",
      "workflowRunId",
      "workflowSha",
    ],
    "trusted E2E dispatch receipt",
  );
  if (
    value.kind !== DISPATCH_KIND ||
    value.repository !== expected.repository ||
    value.prNumber !== expected.number ||
    value.candidateRepository !== expected.candidateRepository ||
    value.candidateSha !== expected.candidateSha ||
    value.baseSha !== expected.baseSha ||
    value.workflowSha !== expected.workflowSha ||
    value.workflowRunId !== String(expected.runId) ||
    value.workflowRunAttempt !== expected.runAttempt ||
    value.workflowRunAttempt !== 1 ||
    value.eventName !== "workflow_dispatch" ||
    typeof value.jobs !== "string" ||
    typeof value.targets !== "string" ||
    typeof value.emptySelectors !== "boolean" ||
    value.emptySelectors !== (value.jobs === "" && value.targets === "") ||
    typeof value.allowDgxSparkRunnerQueue !== "boolean" ||
    typeof value.allowJetsonRunnerQueue !== "boolean" ||
    typeof value.includeStagingBrevLaunchable !== "boolean"
  ) {
    fail("trusted E2E dispatch receipt is stale, selective, or identity-mismatched");
  }
  return value as E2EDispatchReceiptEnvelope;
}

function validateWorkflowIdentity(value: unknown): WorkflowIdentity {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    value.path !== E2E_WORKFLOW_PATH ||
    value.state !== "active"
  ) {
    fail("trusted E2E workflow identity is malformed or inactive");
  }
  return { id: value.id };
}

function validateWorkflowRun(value: unknown): WorkflowRun {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    !positiveInteger(value.workflow_id) ||
    !positiveInteger(value.run_attempt) ||
    typeof value.event !== "string" ||
    typeof value.status !== "string" ||
    !KNOWN_RUN_STATUSES.has(value.status) ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    typeof value.head_sha !== "string" ||
    typeof value.path !== "string" ||
    typeof value.html_url !== "string" ||
    !isRecord(value.repository) ||
    typeof value.repository.full_name !== "string"
  ) {
    fail("E2E workflow-runs response contains a malformed entry");
  }
  validateSha(value.head_sha, "E2E workflow run head");
  return {
    conclusion: value.conclusion,
    event: value.event,
    headSha: value.head_sha,
    id: value.id,
    path: value.path,
    repository: value.repository.full_name,
    runAttempt: value.run_attempt,
    status: value.status,
    url: value.html_url,
    workflowId: value.workflow_id,
  };
}

async function loadCountedPages<T>(options: {
  api: GitHubReader;
  collectionKey: string;
  label: string;
  maxItems: number;
  pathForPage: (page: number) => string;
  validate: (value: unknown) => T;
}): Promise<T[]> {
  const result: T[] = [];
  let expectedTotal: number | undefined;
  const maxPages = Math.ceil(options.maxItems / PAGE_SIZE);
  for (let page = 1; page <= maxPages; page += 1) {
    const value = await options.api.getJson(options.pathForPage(page));
    if (!isRecord(value) || !nonNegativeInteger(value.total_count)) {
      fail(`${options.label} page ${page} has no valid total_count`);
    }
    const pageItems = value[options.collectionKey];
    if (!Array.isArray(pageItems) || pageItems.length > PAGE_SIZE) {
      fail(`${options.label} page ${page} is malformed`);
    }
    if (expectedTotal === undefined) expectedTotal = value.total_count;
    if (value.total_count !== expectedTotal || expectedTotal > options.maxItems) {
      fail(`${options.label} pagination changed or exceeds its ${options.maxItems}-item bound`);
    }
    result.push(...pageItems.map(options.validate));
    if (result.length > expectedTotal)
      fail(`${options.label} returned more entries than total_count`);
    if (result.length === expectedTotal) return result;
    if (pageItems.length === 0) fail(`${options.label} pagination ended before total_count`);
  }
  fail(`${options.label} pagination is incomplete`);
}

async function loadWorkflowRuns(
  api: GitHubReader,
  repository: string,
  workflowSha: string,
): Promise<WorkflowRun[]> {
  return loadCountedPages({
    api,
    collectionKey: "workflow_runs",
    label: "E2E workflow runs",
    maxItems: MAX_WORKFLOW_RUNS,
    pathForPage: (page) =>
      `repos/${repository}/actions/workflows/${E2E_WORKFLOW_FILE}/runs?branch=main&event=workflow_dispatch&head_sha=${workflowSha}&per_page=${PAGE_SIZE}&page=${page}`,
    validate: validateWorkflowRun,
  });
}

function validateWorkflowArtifact(value: unknown): WorkflowArtifact {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    typeof value.name !== "string" ||
    typeof value.expired !== "boolean" ||
    typeof value.archive_download_url !== "string" ||
    !isRecord(value.workflow_run) ||
    !positiveInteger(value.workflow_run.id) ||
    typeof value.workflow_run.head_sha !== "string"
  ) {
    fail("E2E artifacts response contains a malformed entry");
  }
  validateSha(value.workflow_run.head_sha, "E2E artifact workflow SHA");
  return {
    archivePath: `repos/${value.archive_download_url.split("/repos/")[1] ?? ""}`,
    expired: value.expired,
    id: value.id,
    name: value.name,
    runId: value.workflow_run.id,
    workflowSha: value.workflow_run.head_sha,
  };
}

async function loadRunArtifacts(
  api: GitHubReader,
  repository: string,
  runId: number,
): Promise<WorkflowArtifact[]> {
  const artifacts = await loadCountedPages({
    api,
    collectionKey: "artifacts",
    label: `E2E run ${runId} artifacts`,
    maxItems: MAX_RUN_ARTIFACTS,
    pathForPage: (page) =>
      `repos/${repository}/actions/runs/${runId}/artifacts?per_page=${PAGE_SIZE}&page=${page}`,
    validate: validateWorkflowArtifact,
  });
  for (const artifact of artifacts) {
    const expectedPath = `repos/${repository}/actions/artifacts/${artifact.id}/zip`;
    if (artifact.archivePath !== expectedPath) {
      fail(`E2E artifact ${artifact.id} has a mismatched archive URL`);
    }
  }
  return artifacts;
}

async function defaultLoadReceipt(artifact: WorkflowArtifact, api: GitHubReader): Promise<unknown> {
  const archive = await api.getBytes(artifact.archivePath);
  if (archive.length > MAX_ARTIFACT_BYTES) fail("trusted E2E dispatch artifact is oversized");
  const source = readValidatedArtifactZipEntry(archive, DISPATCH_FILE, {
    maxBytes: MAX_RECEIPT_BYTES,
    maxEntries: 1,
  });
  if (source === null) fail("trusted E2E dispatch artifact is not one valid dispatch.json ZIP");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail("trusted E2E dispatch receipt is not valid JSON");
  }
}

async function selectQualifiedRun(options: {
  api: GitHubReader;
  identity: PullRequestIdentity;
  loadReceipt: (artifact: WorkflowArtifact, api: GitHubReader) => Promise<unknown>;
  repository: string;
  workflowId: number;
  workflowSha: string;
}): Promise<WorkflowRun> {
  const inventory = await loadWorkflowRuns(options.api, options.repository, options.workflowSha);
  const candidates = inventory
    .filter(
      (run) =>
        run.workflowId === options.workflowId &&
        run.event === "workflow_dispatch" &&
        run.headSha === options.workflowSha &&
        run.path === E2E_WORKFLOW_PATH &&
        run.repository === options.repository,
    )
    .sort((left, right) => right.id - left.id);
  for (const run of candidates) {
    const artifacts = await loadRunArtifacts(options.api, options.repository, run.id);
    const expectedName = `e2e-dispatch-${run.id}-${run.runAttempt}`;
    const receipts = artifacts.filter((artifact) => artifact.name === expectedName);
    if (receipts.length > 1) fail(`E2E run ${run.id} has duplicate trusted dispatch artifacts`);
    const artifact = receipts[0];
    if (!artifact || artifact.expired) continue;
    if (artifact.runId !== run.id || artifact.workflowSha !== options.workflowSha) {
      fail(`E2E run ${run.id} dispatch artifact has mismatched workflow identity`);
    }
    const rawReceipt = await options.loadReceipt(artifact, options.api);
    if (!isRecord(rawReceipt) || rawReceipt.kind !== DISPATCH_KIND) continue;
    try {
      const receipt = validateDispatchReceiptEnvelope(rawReceipt, {
        ...options.identity,
        runAttempt: run.runAttempt,
        runId: run.id,
        workflowSha: options.workflowSha,
      });
      if (
        receipt.jobs !== "" ||
        receipt.targets !== "" ||
        !receipt.emptySelectors ||
        receipt.allowDgxSparkRunnerQueue ||
        receipt.allowJetsonRunnerQueue ||
        receipt.includeStagingBrevLaunchable
      ) {
        continue;
      }
      if (run.status !== "completed" || run.conclusion !== "success") {
        fail(
          `newest current-head full E2E run ${run.id} is not successful (${run.status}/${run.conclusion ?? "none"})`,
        );
      }
      return run;
    } catch (error) {
      if (rawReceipt.candidateSha === options.identity.candidateSha) throw error;
    }
  }
  fail("no current-head trusted full E2E dispatch receipt was found");
}

function validateWorkflowJob(value: unknown): WorkflowJob {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    !positiveInteger(value.run_id) ||
    !positiveInteger(value.run_attempt) ||
    typeof value.name !== "string" ||
    !SAFE_JOB_NAME_PATTERN.test(value.name) ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    typeof value.html_url !== "string"
  ) {
    fail("E2E jobs response contains a malformed entry");
  }
  return {
    conclusion: value.conclusion,
    id: value.id,
    name: value.name,
    runAttempt: value.run_attempt,
    runId: value.run_id,
    status: value.status,
    url: value.html_url,
  };
}

async function loadRunJobs(
  api: GitHubReader,
  repository: string,
  runId: number,
): Promise<WorkflowJob[]> {
  return loadCountedPages({
    api,
    collectionKey: "jobs",
    label: `E2E run ${runId} jobs`,
    maxItems: MAX_RUN_JOBS,
    pathForPage: (page) =>
      `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`,
    validate: validateWorkflowJob,
  });
}

export function validateSuccessfulJobs(
  jobs: readonly WorkflowJob[],
  run: { id: number; runAttempt: number },
  requiredUpgradeJobs: readonly string[],
  requiredSharedJobs: readonly string[] = [],
): QualificationJobEvidence[] {
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id) || names.has(job.name)) fail(`E2E job ${job.name} is duplicated`);
    ids.add(job.id);
    names.add(job.name);
    if (job.runId !== run.id || job.runAttempt !== run.runAttempt) {
      fail(`E2E job ${job.name} belongs to another run or attempt`);
    }
    if (job.status !== "completed") fail(`E2E job ${job.name} is incomplete`);
    if (job.conclusion === "skipped" && OPTIONAL_SKIPPED_E2E_JOBS.has(job.name)) continue;
    if (job.conclusion !== "success") {
      fail(`E2E job ${job.name} did not succeed (${job.conclusion ?? "no conclusion"})`);
    }
  }
  for (const requiredName of [
    "base-image-publication",
    "generate-matrix",
    ...requiredUpgradeJobs,
    ...requiredSharedJobs,
  ]) {
    if (!names.has(requiredName)) fail(`required E2E job ${requiredName} is missing`);
  }
  for (const prefix of REQUIRED_CONTROLLER_TARGET_PREFIXES) {
    const matching = jobs.filter((job) => job.name.startsWith(prefix));
    if (matching.length !== 1) fail(`required E2E matrix child ${prefix} is missing or duplicated`);
  }
  return [...jobs]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((job) => ({
      conclusion: job.conclusion as "skipped" | "success",
      name: job.name,
      url: job.url,
    }));
}

function validateCheckRun(value: unknown): CheckRun {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    typeof value.name !== "string" ||
    !SAFE_JOB_NAME_PATTERN.test(value.name) ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    typeof value.head_sha !== "string" ||
    typeof value.html_url !== "string"
  ) {
    fail("check-runs response contains a malformed entry");
  }
  validateSha(value.head_sha, "check-run head");
  return {
    conclusion: value.conclusion,
    headSha: value.head_sha,
    id: value.id,
    name: value.name,
    status: value.status,
    url: value.html_url,
  };
}

async function loadCheckRuns(
  api: GitHubReader,
  repository: string,
  candidateSha: string,
): Promise<CheckRun[]> {
  return loadCountedPages({
    api,
    collectionKey: "check_runs",
    label: "candidate check runs",
    maxItems: MAX_CHECK_RUNS,
    pathForPage: (page) =>
      `repos/${repository}/commits/${candidateSha}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`,
    validate: validateCheckRun,
  });
}

export function validateRequiredChecks(
  checks: readonly CheckRun[],
  candidateSha: string,
  requiredNames: readonly string[],
): QualificationCheckEvidence[] {
  return requiredNames.map((name) => {
    const matching = checks.filter((check) => check.name === name);
    if (matching.length !== 1) fail(`required current-head check ${name} is missing or duplicated`);
    const check = matching[0] as CheckRun;
    if (
      check.headSha !== candidateSha ||
      check.status !== "completed" ||
      check.conclusion !== "success"
    ) {
      fail(`required current-head check ${name} is stale, incomplete, or unsuccessful`);
    }
    return { conclusion: "success", name, url: check.url };
  });
}

export async function verifyOpenShellE2EQualification(
  input: VerifyQualificationInput,
  dependencies: QualificationDependencies,
): Promise<QualificationEvidence> {
  validateRepository(input.repository);
  if (!positiveInteger(input.prNumber)) fail("pull-request number must be positive");
  validateSha(input.candidateSha, "candidate SHA");
  validateSha(input.baseSha, "base SHA");
  validateSha(input.workflowSha, "trusted workflow SHA");
  const pullPath = `repos/${input.repository}/pulls/${input.prNumber}`;
  const identity = validatePullRequest(await dependencies.api.getJson(pullPath), input);
  const files = await loadPullRequestFiles(dependencies.api, input.repository, input.prNumber);
  const classification = classifyQualification(files);
  const common = {
    baseSha: identity.baseSha,
    candidateRepository: identity.candidateRepository,
    candidateSha: identity.candidateSha,
    changedFileCount: files.length,
    proofChecks: [] as QualificationCheckEvidence[],
    repository: identity.repository,
    requiredProofChecks: classification.requiredProofChecks,
    schemaVersion: 1 as const,
    sensitiveFileCount: classification.sensitivePaths.length,
    sensitiveFiles: classification.sensitivePaths.slice(0, 100),
    sensitiveFilesTruncated: classification.sensitivePaths.length > 100,
  };
  if (!classification.required) {
    validatePullRequest(await dependencies.api.getJson(pullPath), input);
    return { ...common, qualificationRequired: false, status: "not-required" };
  }

  const readVersion = dependencies.readVersion ?? extractOpenShellVersion;
  const baselineVersion = readVersion(input.baseRoot);
  const targetVersion = readVersion(input.candidateRoot);
  if (!VERSION_PATTERN.test(baselineVersion) || !VERSION_PATTERN.test(targetVersion)) {
    fail("baseline or target OpenShell version is malformed");
  }
  const upgradeFixture = extractUpgradeFixtureRequirement(
    input.baseRoot,
    baselineVersion,
    targetVersion,
  );
  const requiredSharedJobs = extractSharedE2EJobRequirements(input.baseRoot);
  const workflow = validateWorkflowIdentity(
    await dependencies.api.getJson(
      `repos/${input.repository}/actions/workflows/${E2E_WORKFLOW_FILE}`,
    ),
  );
  const run = await selectQualifiedRun({
    api: dependencies.api,
    identity,
    loadReceipt: dependencies.loadReceipt ?? defaultLoadReceipt,
    repository: input.repository,
    workflowId: workflow.id,
    workflowSha: input.workflowSha,
  });
  const jobs = await loadRunJobs(dependencies.api, input.repository, run.id);
  const jobEvidence = validateSuccessfulJobs(
    jobs,
    run,
    upgradeFixture.jobNames,
    requiredSharedJobs,
  );
  const checks =
    classification.requiredProofChecks.length === 0
      ? []
      : await loadCheckRuns(dependencies.api, input.repository, input.candidateSha);
  const proofChecks = validateRequiredChecks(
    checks,
    input.candidateSha,
    classification.requiredProofChecks,
  );
  validatePullRequest(await dependencies.api.getJson(pullPath), input);
  return {
    ...common,
    baselineVersion,
    e2e: {
      jobs: jobEvidence,
      runAttempt: run.runAttempt,
      runId: run.id,
      url: run.url,
      workflowSha: input.workflowSha,
    },
    exercisedUpgradeVersion: upgradeFixture.version,
    proofChecks,
    qualificationRequired: true,
    status: "qualified",
    targetVersion,
  };
}

export function renderQualificationSummary(evidence: QualificationEvidence): string {
  const lines = [
    "## OpenShell exact-head E2E qualification",
    "",
    `- Status: **${evidence.status}**`,
    `- Pull request head: \`${evidence.candidateSha}\``,
    `- Pull request base: \`${evidence.baseSha}\``,
    `- Sensitive changed paths: ${evidence.sensitiveFileCount}`,
  ];
  if (evidence.status === "not-required") {
    lines.push("", "No OpenShell qualification-sensitive path changed.", "");
    return lines.join("\n");
  }
  lines.push(
    `- OpenShell baseline: \`${evidence.baselineVersion}\``,
    `- OpenShell target: \`${evidence.targetVersion}\``,
    `- Exercised upgrade fixture: OpenShell \`${evidence.exercisedUpgradeVersion}\``,
    `- Trusted E2E: [run ${evidence.e2e?.runId}](${evidence.e2e?.url}) (attempt ${evidence.e2e?.runAttempt})`,
    "",
    "### Required exact-head checks",
    "",
  );
  if (evidence.proofChecks.length === 0) lines.push("- None for these changed paths.");
  for (const check of evidence.proofChecks)
    lines.push(`- [${check.name}](${check.url}): ${check.conclusion}`);
  lines.push("", "### Trusted E2E jobs", "");
  for (const job of evidence.e2e?.jobs ?? [])
    lines.push(`- [${job.name}](${job.url}): ${job.conclusion}`);
  lines.push("");
  return lines.join("\n");
}

function createGitHubReader(token: string): GitHubReader {
  async function request(apiPath: string): Promise<Response> {
    if (!apiPath.startsWith("repos/")) fail("GitHub API path is outside the repository boundary");
    return fetch(`https://api.github.com/${apiPath}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "nemoclaw-openshell-e2e-qualification",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }
  return {
    async getBytes(apiPath) {
      const response = await request(apiPath);
      if (!response.ok) fail(`GitHub artifact download failed with HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES)
        fail("GitHub artifact is oversized");
      const result = Buffer.from(await response.arrayBuffer());
      if (result.length > MAX_ARTIFACT_BYTES) fail("GitHub artifact is oversized");
      return result;
    },
    async getJson(apiPath) {
      const response = await request(apiPath);
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_JSON_RESPONSE_BYTES)
        fail("GitHub JSON response is oversized");
      const body = await response.text();
      if (body.length > MAX_JSON_RESPONSE_BYTES) fail("GitHub JSON response is oversized");
      if (!response.ok) fail(`GitHub API request failed with HTTP ${response.status}`);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        fail("GitHub API returned invalid JSON");
      }
    },
  };
}

function parseCli(argv: readonly string[]): VerifyQualificationInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) fail("CLI arguments are malformed");
    values.set(key, value);
  }
  const allowed = new Set([
    "--base-root",
    "--base-sha",
    "--candidate-root",
    "--candidate-sha",
    "--pr-number",
    "--repository",
    "--workflow-sha",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key)) || values.size !== allowed.size) {
    fail("CLI requires repository, PR, root, head, base, and workflow identity arguments");
  }
  const prNumber = Number(values.get("--pr-number"));
  return {
    baseRoot: values.get("--base-root") ?? "",
    baseSha: values.get("--base-sha") ?? "",
    candidateRoot: values.get("--candidate-root") ?? "",
    candidateSha: values.get("--candidate-sha") ?? "",
    prNumber,
    repository: values.get("--repository") ?? "",
    workflowSha: values.get("--workflow-sha") ?? "",
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is required in the environment");
  const evidence = await verifyOpenShellE2EQualification(parseCli(argv), {
    api: createGitHubReader(token),
  });
  const serialized = `${JSON.stringify(evidence)}\n`;
  process.stdout.write(serialized);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath)
    fs.appendFileSync(summaryPath, `${renderQualificationSummary(evidence)}\n`, "utf8");
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
