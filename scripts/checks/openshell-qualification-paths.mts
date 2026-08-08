// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const SAFE_PATH_PATTERN = /^[^\u0000-\u001f\u007f\\\\]{1,4096}$/u;
const MAX_PR_FILE_PAGES = 30;
const PAGE_SIZE = 100;

const KNOWN_FILE_STATUSES = new Set([
  "added",
  "changed",
  "copied",
  "modified",
  "removed",
  "renamed",
  "unchanged",
]);

const SENSITIVE_EXACT_PATHS = new Set([
  ".dockerignore",
  ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md",
  ".agents/skills/nemoclaw-maintainer-cut-release-tag/scripts/release-e2e-evidence.mts",
  ".github/workflows/managed-images.yaml",
  ".github/workflows/openshell-0.0.101-pr-gate.yaml",
  ".github/workflows/openshell-0.0.101-qualification.yaml",
  ".github/workflows/podman-cpu-proof.yaml",
  "Dockerfile",
  "ci/openshell-0.0.101-qualification-v1.json",
  "nemoclaw-blueprint/blueprint.yaml",
  "nemoclaw/src/shared/openshell-policy-boundary.cts",
  "schemas/blueprint.schema.json",
  "scripts/brev-launchable-ci-cpu.sh",
  "scripts/checks/dependency-pins.mts",
  "scripts/checks/managed-image-protected-runtime-contract.ts",
  "scripts/checks/openshell-qualification-contract.mts",
  "scripts/checks/openshell-qualification-core.mts",
  "scripts/checks/openshell-qualification-github.mts",
  "scripts/checks/openshell-qualification-io.mts",
  "scripts/checks/openshell-qualification-matrix.mts",
  "scripts/checks/openshell-qualification-paths.mts",
  "scripts/checks/openshell-qualification-schema.mts",
  "scripts/checks/verify-openshell-qualification-producer-workflow.mts",
  "scripts/checks/verify-openshell-qualification-pr-gate.mts",
  "scripts/release-cut-tag.sh",
  "scripts/scorecard/read-artifact-zip.mts",
  "scripts/install-openshell.sh",
  "scripts/install.sh",
  "scripts/nemoclaw-start.sh",
  "src/lib/adapters/container-engine.ts",
  "src/lib/gateway-runtime-action.ts",
  "src/lib/inference/serving/managed-runtime-receipts.ts",
  "src/lib/onboard/experimental/portable-demo-lifecycle.test.ts",
  "src/lib/onboard/experimental/portable-demo-lifecycle.ts",
  "src/lib/onboard/gateway-host-runtime.ts",
  "tools/e2e/openshell-gateway-upgrade-workflow-boundary.mts",
]);

const SENSITIVE_PREFIXES = [
  "agents/hermes/",
  "agents/langchain-deepagents-code/",
  "agents/openclaw/",
  "nemoclaw-blueprint/model-specific-setup/",
  "nemoclaw-blueprint/openclaw-plugins/",
  "nemoclaw/src/blueprint/",
  "scripts/lib/openshell-",
  "src/lib/adapters/openshell/",
  "src/lib/adapters/podman/",
  "src/lib/adapters/sandbox/command-transport",
  "src/lib/onboard/managed-bootstrap/",
  "src/lib/onboard/managed-startup",
  "src/lib/onboard/openshell-",
  "src/lib/onboard/runtime-provider/podman",
  "src/lib/sandbox/version",
  "test/e2e/live/managed-image-activation-e2e",
  "test/e2e/live/openshell-gateway-upgrade",
  "test/e2e/live/podman-cpu-lifecycle",
  "test/e2e/support/openshell-gateway-upgrade",
  "test/e2e/support/podman-cpu-proof-workflow",
] as const;

export type PullRequestFile = {
  filename: string;
  previousFilename?: string;
  status: string;
};

export type GitHubReader = {
  getBytes(apiPath: string): Promise<Buffer>;
  getJson(apiPath: string): Promise<unknown>;
};

function fail(message: string): never {
  throw new Error(`OpenShell E2E qualification failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function pathsForFile(file: PullRequestFile): string[] {
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
  sensitivePaths: string[];
} {
  const allPaths = files.flatMap(pathsForFile);
  const sensitivePaths = [
    ...new Set(allPaths.filter(isOpenShellQualificationSensitivePath)),
  ].sort();
  return { required: sensitivePaths.length > 0, sensitivePaths };
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
