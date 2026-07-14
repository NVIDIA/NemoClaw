// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { moduleTagDeclarations, stripModuleTagDeclarations } from "./module-tags.mts";

export const CREDENTIAL_FREE_TEST_TAG = "e2e/credential-free";
export const SHARED_E2E_JOB_ID = "shared-e2e";

export type CredentialFreeTestProject = "e2e-live" | "integration";

export type CredentialFreeTestMatrixRow = {
  id: string;
  file: string;
  project: CredentialFreeTestProject;
};

export type CredentialFreeTestModule = {
  file: string;
  project: CredentialFreeTestProject;
  source: string;
};

type VitestFile = {
  file: string;
  projectName: string;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const E2E_LIVE_CREDENTIAL_FREE_TEST_PATTERN =
  /^test\/e2e\/live\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.ts$/;
const INTEGRATION_CREDENTIAL_FREE_TEST_PATTERN =
  /^test\/(?!e2e\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.(?:js|ts)$/;
const SUPPORTED_PROJECTS = new Set<CredentialFreeTestProject>(["e2e-live", "integration"]);

export function credentialFreeTestProjectForFile(
  file: string,
): CredentialFreeTestProject | undefined {
  if (E2E_LIVE_CREDENTIAL_FREE_TEST_PATTERN.test(file)) return "e2e-live";
  if (INTEGRATION_CREDENTIAL_FREE_TEST_PATTERN.test(file)) return "integration";
  return undefined;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function normalizeVitestFile(
  repoRoot: string,
  candidate: VitestFile,
): {
  absoluteFile: string;
  file: string;
  project: CredentialFreeTestProject;
} {
  if (!SUPPORTED_PROJECTS.has(candidate.projectName as CredentialFreeTestProject)) {
    throw new Error(`Unsupported Vitest project '${candidate.projectName}' for ${candidate.file}`);
  }

  const absoluteRoot = fs.realpathSync(repoRoot);
  const absoluteFile = fs.realpathSync(candidate.file);
  if (!isInside(absoluteRoot, absoluteFile)) {
    throw new Error(`Vitest returned a test file outside the repository: ${candidate.file}`);
  }

  return {
    absoluteFile,
    file: path.relative(absoluteRoot, absoluteFile).split(path.sep).join("/"),
    project: candidate.projectName as CredentialFreeTestProject,
  };
}

function validateTestFile(file: string, project: CredentialFreeTestProject): void {
  if (
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file.includes("\\") ||
    !file.startsWith("test/") ||
    !file.split("/").every((segment) => SAFE_PATH_SEGMENT_PATTERN.test(segment)) ||
    !/\.test\.(?:js|ts)$/.test(file)
  ) {
    throw new Error(`Credential-free test path must be a safe repo-relative test file: ${file}`);
  }

  const inferredProject = credentialFreeTestProjectForFile(file);
  if (project === "e2e-live" && inferredProject !== "e2e-live") {
    throw new Error(`e2e-live credential-free test must live under test/e2e/live/: ${file}`);
  }
  if (project === "integration" && inferredProject !== "integration") {
    throw new Error(`integration credential-free test must not live under test/e2e/: ${file}`);
  }
}

function credentialFreeTestTags(source: string, file?: string): string[] {
  const tags = moduleTagDeclarations(source).map(({ tag }) => tag);
  const unknownTag = tags.find((tag) => tag.startsWith("e2e/") && tag !== CREDENTIAL_FREE_TEST_TAG);
  if (unknownTag) {
    throw new Error(`Unknown E2E test tag '${unknownTag}'${file ? ` in ${file}` : ""}`);
  }
  return tags.filter((tag) => tag === CREDENTIAL_FREE_TEST_TAG);
}

export function stripCredentialFreeTestDeclarations(source: string): string {
  return stripModuleTagDeclarations(
    source,
    moduleTagDeclarations(source).filter(({ tag }) => tag === CREDENTIAL_FREE_TEST_TAG),
  );
}

export function credentialFreeTestRowFromModule(
  module: CredentialFreeTestModule,
): CredentialFreeTestMatrixRow {
  validateTestFile(module.file, module.project);
  const tags = credentialFreeTestTags(module.source, module.file);
  if (tags.length !== 1) {
    throw new Error(
      `${module.file} must declare exactly one ${CREDENTIAL_FREE_TEST_TAG} module tag; found ${tags.length}`,
    );
  }

  const id = path.posix.basename(module.file).replace(/\.test\.(?:js|ts)$/, "");
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Credential-free test filename must derive a safe id: ${module.file}`);
  }

  return { id, file: module.file, project: module.project };
}

export function discoverCredentialFreeTestRows(
  modules: readonly CredentialFreeTestModule[],
): CredentialFreeTestMatrixRow[] {
  const rows = modules.map(credentialFreeTestRowFromModule).sort((left, right) => {
    return (
      left.id.localeCompare(right.id) ||
      left.file.localeCompare(right.file) ||
      left.project.localeCompare(right.project)
    );
  });
  const seen = new Map<string, string>();
  for (const row of rows) {
    const previous = seen.get(row.id);
    if (previous) {
      throw new Error(`Duplicate credential-free test id '${row.id}': ${previous}, ${row.file}`);
    }
    seen.set(row.id, row.file);
  }
  return rows;
}

export function listVitestCredentialFreeTestModules(
  repoRoot = REPO_ROOT,
): CredentialFreeTestModule[] {
  const vitestEntrypoint = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [
      vitestEntrypoint,
      "list",
      "--filesOnly",
      "--json",
      "--project",
      "e2e-live",
      "--project",
      "integration",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_RUN_LIVE_E2E: "1" },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error) {
    throw new Error(`Failed to list Vitest test files: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Failed to list Vitest test files (exit ${result.status ?? "unknown"}): ${result.stderr || result.stdout}`,
    );
  }

  let candidates: unknown;
  try {
    candidates = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Vitest test-file list was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(candidates)) {
    throw new Error("Vitest test-file list must be a JSON array");
  }

  return candidates.flatMap((candidate): CredentialFreeTestModule[] => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof (candidate as VitestFile).file !== "string" ||
      typeof (candidate as VitestFile).projectName !== "string"
    ) {
      throw new Error("Vitest test-file list contains an invalid entry");
    }
    const normalized = normalizeVitestFile(repoRoot, candidate as VitestFile);
    const source = fs.readFileSync(normalized.absoluteFile, "utf8");
    if (!credentialFreeTestTags(source, normalized.file).length) return [];
    return [{ file: normalized.file, project: normalized.project, source }];
  });
}

const discoveryCache = new Map<string, CredentialFreeTestMatrixRow[]>();

export function discoverCredentialFreeTests(repoRoot = REPO_ROOT): CredentialFreeTestMatrixRow[] {
  const resolvedRoot = fs.realpathSync(repoRoot);
  const cached = discoveryCache.get(resolvedRoot);
  if (cached) return cached.map((row) => ({ ...row }));
  const rows = discoverCredentialFreeTestRows(listVitestCredentialFreeTestModules(resolvedRoot));
  discoveryCache.set(resolvedRoot, rows);
  return rows.map((row) => ({ ...row }));
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) {
      throw new Error(
        "Credential-free test discovery does not accept selectors; use workflow-plan.mts",
      );
    }
    process.stdout.write(`${JSON.stringify(discoverCredentialFreeTests())}\n`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
