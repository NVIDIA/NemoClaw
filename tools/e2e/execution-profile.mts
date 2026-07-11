// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const HERMETIC_EXECUTION_PROFILE = Object.freeze({
  id: "hermetic",
  tag: "e2e-profile/hermetic",
  executorJob: "hermetic",
});

export type ExecutionProfileProject = "e2e-live" | "integration";

export type ExecutionProfileMatrixRow = {
  id: string;
  file: string;
  project: ExecutionProfileProject;
};

export type ExecutionProfileModule = {
  file: string;
  project: ExecutionProfileProject;
  source: string;
};

export type ExecutionProfileSelectors = {
  jobs?: string;
  targets?: string;
};

type VitestFile = {
  file: string;
  projectName: string;
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROFILE_TAG_PREFIX = "e2e-profile/";
const MODULE_TAG_BODY_PATTERN = /^@module-tag[\t ]+([A-Za-z0-9/_-]+)$/u;
const SAFE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_SELECTOR_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const SUPPORTED_PROJECTS = new Set<ExecutionProfileProject>(["e2e-live", "integration"]);

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
  project: ExecutionProfileProject;
} {
  if (!SUPPORTED_PROJECTS.has(candidate.projectName as ExecutionProfileProject)) {
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
    project: candidate.projectName as ExecutionProfileProject,
  };
}

function validateTestFile(file: string, project: ExecutionProfileProject): void {
  if (
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file.includes("\\") ||
    !file.startsWith("test/") ||
    !file.split("/").every((segment) => SAFE_PATH_SEGMENT_PATTERN.test(segment)) ||
    !/\.test\.(?:js|ts)$/.test(file)
  ) {
    throw new Error(`Execution-profile test path must be a safe repo-relative test file: ${file}`);
  }

  if (project === "e2e-live" && !/^test\/e2e\/live\/.+\.test\.ts$/.test(file)) {
    throw new Error(`e2e-live execution-profile test must live under test/e2e/live/: ${file}`);
  }
  if (project === "integration" && /^test\/e2e\//.test(file)) {
    throw new Error(`integration execution-profile test must not live under test/e2e/: ${file}`);
  }
}

type ModuleTagDeclaration = {
  tag: string;
  start: number;
  end: number;
};

function standaloneModuleTag(comment: string): string | undefined {
  const body = comment.startsWith("//")
    ? comment.slice(2).trim()
    : comment
        .slice(2, -2)
        .split(/\r?\n/u)
        .map((line) => line.replace(/^[\t ]*\**[\t ]?/u, "").trim())
        .filter(Boolean)
        .join("\n");
  return MODULE_TAG_BODY_PATTERN.exec(body)?.[1];
}

function declarationLineRange(
  source: string,
  tokenStart: number,
  tokenEnd: number,
): Pick<ModuleTagDeclaration, "start" | "end"> | undefined {
  const lineStart = source.lastIndexOf("\n", tokenStart - 1) + 1;
  const nextNewline = source.indexOf("\n", tokenEnd);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;
  if (
    !/^[\t ]*$/u.test(source.slice(lineStart, tokenStart)) ||
    !/^[\t \r]*$/u.test(source.slice(tokenEnd, lineEnd))
  ) {
    return undefined;
  }
  return { start: lineStart, end: nextNewline < 0 ? source.length : nextNewline + 1 };
}

function moduleTagDeclarations(source: string): ModuleTagDeclaration[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const declarations: ModuleTagDeclaration[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const tag = standaloneModuleTag(scanner.getTokenText());
    const range = declarationLineRange(source, scanner.getTokenPos(), scanner.getTextPos());
    if (tag && range) declarations.push({ tag, ...range });
  }
  return declarations;
}

function profileTags(source: string): string[] {
  return moduleTagDeclarations(source)
    .map(({ tag }) => tag)
    .filter((tag) => tag.startsWith(PROFILE_TAG_PREFIX));
}

export function stripExecutionProfileDeclarations(source: string): string {
  const declarations = moduleTagDeclarations(source).filter(({ tag }) =>
    tag.startsWith(PROFILE_TAG_PREFIX),
  );
  let cursor = 0;
  let stripped = "";
  for (const declaration of declarations) {
    stripped += source.slice(cursor, declaration.start);
    cursor = declaration.end;
  }
  return stripped + source.slice(cursor);
}

export function executionProfileRowFromModule(
  module: ExecutionProfileModule,
): ExecutionProfileMatrixRow {
  validateTestFile(module.file, module.project);
  const tags = profileTags(module.source);
  if (tags.length !== 1) {
    throw new Error(
      `${module.file} must declare exactly one ${PROFILE_TAG_PREFIX} module tag; found ${tags.length}`,
    );
  }
  if (tags[0] !== HERMETIC_EXECUTION_PROFILE.tag) {
    throw new Error(`Unknown execution profile tag '${tags[0]}' in ${module.file}`);
  }

  const id = path.posix.basename(module.file).replace(/\.test\.(?:js|ts)$/, "");
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Execution-profile test filename must derive a safe id: ${module.file}`);
  }

  return { id, file: module.file, project: module.project };
}

export function discoverExecutionProfileRows(
  modules: readonly ExecutionProfileModule[],
): ExecutionProfileMatrixRow[] {
  const rows = modules.map(executionProfileRowFromModule).sort((left, right) => {
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
      throw new Error(`Duplicate execution-profile test id '${row.id}': ${previous}, ${row.file}`);
    }
    seen.set(row.id, row.file);
  }
  return rows;
}

export function listVitestExecutionProfileModules(repoRoot = REPO_ROOT): ExecutionProfileModule[] {
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

  return candidates.flatMap((candidate): ExecutionProfileModule[] => {
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
    if (!profileTags(source).length) return [];
    return [{ file: normalized.file, project: normalized.project, source }];
  });
}

const discoveryCache = new Map<string, ExecutionProfileMatrixRow[]>();

export function discoverExecutionProfileTests(repoRoot = REPO_ROOT): ExecutionProfileMatrixRow[] {
  const resolvedRoot = fs.realpathSync(repoRoot);
  const cached = discoveryCache.get(resolvedRoot);
  if (cached) return cached.map((row) => ({ ...row }));
  const rows = discoverExecutionProfileRows(listVitestExecutionProfileModules(resolvedRoot));
  discoveryCache.set(resolvedRoot, rows);
  return rows.map((row) => ({ ...row }));
}

function selectorIds(value: string | undefined, label: "jobs" | "targets"): Set<string> {
  if (!value) return new Set();
  const ids = value.split(",");
  if (ids.some((id) => !SAFE_SELECTOR_PATTERN.test(id))) {
    throw new Error(`Invalid ${label} selector; use comma-separated execution-profile test ids`);
  }
  return new Set(ids);
}

export function selectExecutionProfileRows(
  rows: readonly ExecutionProfileMatrixRow[],
  selectors: ExecutionProfileSelectors = {},
): ExecutionProfileMatrixRow[] {
  const jobs = selectorIds(selectors.jobs, "jobs");
  const targets = selectorIds(selectors.targets, "targets");
  if (jobs.size && targets.size) {
    throw new Error("Use either jobs or targets, not both");
  }
  const selected = jobs.size ? jobs : targets;
  if (!selected.size) return [...rows];
  return rows.filter((row) => selected.has(row.id));
}

export function buildExecutionProfileMatrix(
  selectors: ExecutionProfileSelectors = {},
  repoRoot = REPO_ROOT,
): ExecutionProfileMatrixRow[] {
  return selectExecutionProfileRows(discoverExecutionProfileTests(repoRoot), selectors);
}

function parseArgs(argv: readonly string[]): ExecutionProfileSelectors {
  const selectors: ExecutionProfileSelectors = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--jobs" && arg !== "--targets") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--jobs") selectors.jobs = value;
    else selectors.targets = value;
    index += 1;
  }
  return selectors;
}

export function runExecutionProfileCli(argv = process.argv.slice(2)): void {
  const rows = buildExecutionProfileMatrix(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    runExecutionProfileCli();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
