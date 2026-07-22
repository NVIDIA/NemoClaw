#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary compatibility patch for OpenClaw 2026.7.1 split-user state.
 *
 * NemoClaw's root entrypoint runs the OpenClaw CLI and gateway as separate
 * users in the same group. OpenClaw 2026.7.1 makes shared and per-agent SQLite
 * state part of gateway startup, but hardens those paths to owner-only modes.
 * For that topology, keep generic credential and identity stores owner-only
 * while applying group-shared modes only to the databases. Leave private-store
 * enforcement unchanged, and ignore only the obsolete pinned-version update
 * cache when its migration cannot archive through a shields-protected parent.
 *
 * Remove this patch once upstream supports a group-shared state database for
 * split-user containers without requiring a non-owner to chmod an already
 * correctly configured file.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw: group-shared OpenClaw state */";
export const AGENT_MARKER = "/* nemoclaw: group-shared OpenClaw agent state */";
export const MIGRATION_MARKER = "/* nemoclaw: ignore legacy OpenClaw update-check state */";
export const MODELS_MARKER = "/* nemoclaw: group-shared OpenClaw models file */";

const GROUP_SHARED_ENV_HELPER = [
  "function nemoclawUsesGroupSharedState(env) {",
  "\tconst nemoclawSharedStateMarker = env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;",
  '\treturn nemoclawSharedStateMarker === "1";',
  "}",
].join("\n");

const MANAGED_RUNTIME_ENV_HELPER = [
  "function nemoclawUsesManagedRuntime(env) {",
  "\tconst nemoclawSharedStateMarker = env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;",
  "\tconst nemoclawOpenShellMarker = env?.OPENSHELL_SANDBOX ?? process.env.OPENSHELL_SANDBOX;",
  '\treturn nemoclawSharedStateMarker === "1" || nemoclawOpenShellMarker === "1" || (typeof nemoclawOpenShellMarker === "string" && /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(nemoclawOpenShellMarker));',
  "}",
].join("\n");

const UPSTREAM_MODE_CONSTANTS = [
  "const OPENCLAW_STATE_DIR_MODE = 448;",
  "const OPENCLAW_STATE_FILE_MODE = 384;",
].join("\n");

const PATCHED_MODE_CONSTANTS = [
  UPSTREAM_MODE_CONSTANTS,
  `const NEMOCLAW_SHARED_STATE_DIR_MODE = 0o2770; ${MARKER}`,
  "const NEMOCLAW_SHARED_STATE_FILE_MODE = 0o660;",
  GROUP_SHARED_ENV_HELPER,
].join("\n");

const UPSTREAM_CHMOD_HELPER = [
  "function bestEffortChmodSync(target, mode) {",
  "\tconst result = applyPrivateModeSync(target, mode);",
  "\tif (result.applied || chmodWarnedTargets.has(target)) return;",
  "\tchmodWarnedTargets.add(target);",
  "\tstateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);",
  "}",
].join("\n");

const PATCHED_CHMOD_HELPER = [
  "function bestEffortChmodSync(target, mode, skipWhenModeMatches = false) {",
  "\tif (skipWhenModeMatches) try {",
  "\t\tif ((statSync(target).mode & 0o7777) === mode) return;",
  "\t} catch {}",
  "\tconst result = applyPrivateModeSync(target, mode);",
  "\tif (result.applied || chmodWarnedTargets.has(target)) return;",
  "\tchmodWarnedTargets.add(target);",
  "\tstateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);",
  "}",
].join("\n");

const UPSTREAM_PERMISSION_HELPER = [
  "function ensureOpenClawStatePermissions(pathname, env) {",
  "\tconst dir = path.dirname(pathname);",
  "\tconst defaultDir = resolveOpenClawStateSqliteDir(env);",
  "\tconst isDefaultStateDatabase = path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));",
  "\tif (isDefaultStateDatabase && dir !== defaultDir) throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);",
  "\tconst dirExisted = existsSync(dir);",
  "\tmkdirSync(dir, {",
  "\t\trecursive: true,",
  "\t\tmode: OPENCLAW_STATE_DIR_MODE",
  "\t});",
  "\tif (isDefaultStateDatabase || !dirExisted) bestEffortChmodSync(dir, OPENCLAW_STATE_DIR_MODE);",
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) if (existsSync(candidate)) bestEffortChmodSync(candidate, OPENCLAW_STATE_FILE_MODE);",
  "}",
].join("\n");

const PATCHED_PERMISSION_HELPER = [
  "function ensureOpenClawStatePermissions(pathname, env) {",
  "\tconst dir = path.dirname(pathname);",
  "\tconst defaultDir = resolveOpenClawStateSqliteDir(env);",
  "\tconst isDefaultStateDatabase = path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));",
  "\tif (isDefaultStateDatabase && dir !== defaultDir) throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);",
  "\tconst nemoclawGroupSharedState = nemoclawUsesGroupSharedState(env);",
  "\tconst nemoclawStateDirMode = nemoclawGroupSharedState ? NEMOCLAW_SHARED_STATE_DIR_MODE : OPENCLAW_STATE_DIR_MODE;",
  "\tconst nemoclawStateFileMode = nemoclawGroupSharedState ? NEMOCLAW_SHARED_STATE_FILE_MODE : OPENCLAW_STATE_FILE_MODE;",
  "\tconst dirExisted = existsSync(dir);",
  "\tmkdirSync(dir, {",
  "\t\trecursive: true,",
  "\t\tmode: nemoclawStateDirMode",
  "\t});",
  "\tif (isDefaultStateDatabase || !dirExisted) bestEffortChmodSync(dir, nemoclawStateDirMode, nemoclawGroupSharedState);",
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) if (existsSync(candidate)) bestEffortChmodSync(candidate, nemoclawStateFileMode, nemoclawGroupSharedState);",
  "}",
].join("\n");

const PATCHED_STATE_REQUIRED_PATTERNS = [
  MARKER,
  "const NEMOCLAW_SHARED_STATE_DIR_MODE = 0o2770;",
  "const NEMOCLAW_SHARED_STATE_FILE_MODE = 0o660;",
  "function nemoclawUsesGroupSharedState(env) {",
  "env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE",
  "function bestEffortChmodSync(target, mode, skipWhenModeMatches = false) {",
  "(statSync(target).mode & 0o7777) === mode",
  "const nemoclawGroupSharedState = nemoclawUsesGroupSharedState(env);",
  "mode: nemoclawStateDirMode",
  "bestEffortChmodSync(dir, nemoclawStateDirMode, nemoclawGroupSharedState);",
  "bestEffortChmodSync(candidate, nemoclawStateFileMode, nemoclawGroupSharedState);",
] as const;

const UPSTREAM_AGENT_MODE_CONSTANTS = [
  "const OPENCLAW_AGENT_DB_DIR_MODE = 448;",
  "const OPENCLAW_AGENT_DB_FILE_MODE = 384;",
].join("\n");

const PATCHED_AGENT_MODE_CONSTANTS = [
  UPSTREAM_AGENT_MODE_CONSTANTS,
  `const NEMOCLAW_SHARED_AGENT_DB_DIR_MODE = 0o2770; ${AGENT_MARKER}`,
  "const NEMOCLAW_SHARED_AGENT_DB_FILE_MODE = 0o660;",
  GROUP_SHARED_ENV_HELPER,
].join("\n");

const UPSTREAM_AGENT_PERMISSION_HELPER = [
  "function ensureOpenClawAgentDatabasePermissions(pathname, options) {",
  "\tconst dir = path.dirname(pathname);",
  "\tconst defaultPath = resolveOpenClawAgentSqlitePath({",
  "\t\tagentId: options.agentId,",
  "\t\tenv: options.env",
  "\t});",
  "\tconst isDefaultAgentDatabase = path.resolve(pathname) === path.resolve(defaultPath);",
  "\tconst dirExisted = existsSync(dir);",
  "\tmkdirSync(dir, {",
  "\t\trecursive: true,",
  "\t\tmode: OPENCLAW_AGENT_DB_DIR_MODE",
  "\t});",
  "\tif (isDefaultAgentDatabase || !dirExisted) chmodSync(dir, OPENCLAW_AGENT_DB_DIR_MODE);",
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) if (existsSync(candidate)) chmodSync(candidate, OPENCLAW_AGENT_DB_FILE_MODE);",
  "}",
].join("\n");

const PATCHED_AGENT_PERMISSION_HELPER = [
  "function ensureOpenClawAgentDatabasePermissions(pathname, options) {",
  "\tconst dir = path.dirname(pathname);",
  "\tconst defaultPath = resolveOpenClawAgentSqlitePath({",
  "\t\tagentId: options.agentId,",
  "\t\tenv: options.env",
  "\t});",
  "\tconst isDefaultAgentDatabase = path.resolve(pathname) === path.resolve(defaultPath);",
  "\tconst nemoclawGroupSharedState = nemoclawUsesGroupSharedState(options.env);",
  "\tconst nemoclawAgentDirMode = nemoclawGroupSharedState ? NEMOCLAW_SHARED_AGENT_DB_DIR_MODE : OPENCLAW_AGENT_DB_DIR_MODE;",
  "\tconst nemoclawAgentFileMode = nemoclawGroupSharedState ? NEMOCLAW_SHARED_AGENT_DB_FILE_MODE : OPENCLAW_AGENT_DB_FILE_MODE;",
  "\tconst dirExisted = existsSync(dir);",
  "\tmkdirSync(dir, {",
  "\t\trecursive: true,",
  "\t\tmode: nemoclawAgentDirMode",
  "\t});",
  "\tif ((isDefaultAgentDatabase || !dirExisted) && (!nemoclawGroupSharedState || (statSync(dir).mode & 0o7777) !== nemoclawAgentDirMode)) chmodSync(dir, nemoclawAgentDirMode);",
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) if (existsSync(candidate) && (!nemoclawGroupSharedState || (statSync(candidate).mode & 0o7777) !== nemoclawAgentFileMode)) chmodSync(candidate, nemoclawAgentFileMode);",
  "}",
].join("\n");

const PATCHED_AGENT_REQUIRED_PATTERNS = [
  AGENT_MARKER,
  "const NEMOCLAW_SHARED_AGENT_DB_DIR_MODE = 0o2770;",
  "const NEMOCLAW_SHARED_AGENT_DB_FILE_MODE = 0o660;",
  "function nemoclawUsesGroupSharedState(env) {",
  "const nemoclawGroupSharedState = nemoclawUsesGroupSharedState(options.env);",
  "mode: nemoclawAgentDirMode",
  "(statSync(dir).mode & 0o7777) !== nemoclawAgentDirMode",
  "(statSync(candidate).mode & 0o7777) !== nemoclawAgentFileMode",
] as const;

const UPSTREAM_MIGRATION_FUNCTION_START = [
  "function migrateLegacyUpdateCheckState(params) {",
  "\tconst changes = [];",
  "\tconst warnings = [];",
].join("\n");

const UPSTREAM_MIGRATION_START = [
  UPSTREAM_MIGRATION_FUNCTION_START,
  "\tif (!fileExists(params.detected.sourcePath)) return {",
].join("\n");

const PATCHED_MIGRATION_START = [
  MANAGED_RUNTIME_ENV_HELPER,
  UPSTREAM_MIGRATION_FUNCTION_START,
  `\tif (nemoclawUsesManagedRuntime()) return { changes, warnings }; ${MIGRATION_MARKER}`,
  "\tif (!fileExists(params.detected.sourcePath)) return {",
].join("\n");

const PATCHED_MIGRATION_REQUIRED_PATTERNS = [
  MIGRATION_MARKER,
  "function nemoclawUsesManagedRuntime(env) {",
  "env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE",
  "env?.OPENSHELL_SANDBOX ?? process.env.OPENSHELL_SANDBOX",
  "function migrateLegacyUpdateCheckState(params) {",
  "if (nemoclawUsesManagedRuntime()) return { changes, warnings };",
] as const;

const UPSTREAM_MODELS_FILE_MODE_HELPER = [
  "async function ensureModelsFileModeForModelsJson(pathname) {",
  "\tawait fs.chmod(pathname, 384).catch(() => {});",
  "}",
].join("\n");

const PATCHED_MODELS_FILE_MODE_HELPER = [
  GROUP_SHARED_ENV_HELPER,
  `async function ensureModelsFileModeForModelsJson(pathname) { ${MODELS_MARKER}`,
  "\tconst nemoclawGroupSharedState = nemoclawUsesGroupSharedState();",
  "\tconst nemoclawModelsFileMode = nemoclawGroupSharedState ? 0o660 : 384;",
  "\tif (nemoclawGroupSharedState) try {",
  "\t\tif (((await fs.stat(pathname)).mode & 0o7777) === nemoclawModelsFileMode) return;",
  "\t} catch {}",
  "\tawait fs.chmod(pathname, nemoclawModelsFileMode).catch(() => {});",
  "}",
].join("\n");

const PATCHED_MODELS_REQUIRED_PATTERNS = [
  MODELS_MARKER,
  "function nemoclawUsesGroupSharedState(env) {",
  "env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE",
  "async function ensureModelsFileModeForModelsJson(pathname) {",
  "const nemoclawModelsFileMode = nemoclawGroupSharedState ? 0o660 : 384;",
  "((await fs.stat(pathname)).mode & 0o7777) === nemoclawModelsFileMode",
  "await fs.chmod(pathname, nemoclawModelsFileMode).catch(() => {});",
] as const;

type PatchStatus = "patched" | "already-patched";

export interface PatchTextResult {
  readonly patched: boolean;
  readonly status: PatchStatus;
  readonly text: string;
}

export interface PatchDistResult {
  readonly files: readonly string[];
  readonly patched: boolean;
  readonly status: PatchStatus;
}

function usage(): string {
  return "Usage: patch-openclaw-shared-state-permissions.mts <openclaw-dist-dir>";
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = source.indexOf(needle);
  while (offset !== -1) {
    count += 1;
    offset = source.indexOf(needle, offset + needle.length);
  }
  return count;
}

function requireExactlyOnce(source: string, needle: string, label: string, file: string): void {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    throw new Error(`${file}: expected exactly one ${label}, found ${count}`);
  }
}

function validatePatchedStateText(source: string, file: string): void {
  for (const pattern of PATCHED_STATE_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  if (source.includes(UPSTREAM_CHMOD_HELPER) || source.includes(UPSTREAM_PERMISSION_HELPER)) {
    throw new Error(`${file}: patch marker is present but an upstream permission target remains`);
  }
}

export function patchOpenClawStateDbText(source: string, file: string): PatchTextResult {
  if (source.includes(MARKER)) {
    validatePatchedStateText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_MODE_CONSTANTS, "state mode constants", file);
  requireExactlyOnce(source, UPSTREAM_CHMOD_HELPER, "chmod helper", file);
  requireExactlyOnce(source, UPSTREAM_PERMISSION_HELPER, "state permission helper", file);

  const text = source
    .replace(UPSTREAM_MODE_CONSTANTS, PATCHED_MODE_CONSTANTS)
    .replace(UPSTREAM_CHMOD_HELPER, PATCHED_CHMOD_HELPER)
    .replace(UPSTREAM_PERMISSION_HELPER, PATCHED_PERMISSION_HELPER);
  validatePatchedStateText(text, file);
  return { patched: true, status: "patched", text };
}

function validatePatchedAgentText(source: string, file: string): void {
  for (const pattern of PATCHED_AGENT_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  if (source.includes(UPSTREAM_AGENT_PERMISSION_HELPER)) {
    throw new Error(`${file}: patch marker is present but an upstream permission target remains`);
  }
}

export function patchOpenClawAgentDbText(source: string, file: string): PatchTextResult {
  if (source.includes(AGENT_MARKER)) {
    validatePatchedAgentText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_AGENT_MODE_CONSTANTS, "agent state mode constants", file);
  requireExactlyOnce(
    source,
    UPSTREAM_AGENT_PERMISSION_HELPER,
    "agent state permission helper",
    file,
  );
  const text = source
    .replace(UPSTREAM_AGENT_MODE_CONSTANTS, PATCHED_AGENT_MODE_CONSTANTS)
    .replace(UPSTREAM_AGENT_PERMISSION_HELPER, PATCHED_AGENT_PERMISSION_HELPER);
  validatePatchedAgentText(text, file);
  return { patched: true, status: "patched", text };
}

function validatePatchedMigrationText(source: string, file: string): void {
  for (const pattern of PATCHED_MIGRATION_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  if (source.includes(UPSTREAM_MIGRATION_START)) {
    throw new Error(`${file}: patch marker is present but the upstream migration target remains`);
  }
}

export function patchOpenClawStateMigrationText(source: string, file: string): PatchTextResult {
  if (source.includes(MIGRATION_MARKER)) {
    validatePatchedMigrationText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_MIGRATION_START, "legacy update-check migration start", file);
  const text = source.replace(UPSTREAM_MIGRATION_START, PATCHED_MIGRATION_START);
  validatePatchedMigrationText(text, file);
  return { patched: true, status: "patched", text };
}

function validatePatchedModelsText(source: string, file: string): void {
  for (const pattern of PATCHED_MODELS_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  if (source.includes(UPSTREAM_MODELS_FILE_MODE_HELPER)) {
    throw new Error(`${file}: patch marker is present but the upstream models mode target remains`);
  }
}

export function patchOpenClawModelsConfigText(source: string, file: string): PatchTextResult {
  if (source.includes(MODELS_MARKER)) {
    validatePatchedModelsText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_MODELS_FILE_MODE_HELPER, "models file mode helper", file);
  const text = source.replace(UPSTREAM_MODELS_FILE_MODE_HELPER, PATCHED_MODELS_FILE_MODE_HELPER);
  validatePatchedModelsText(text, file);
  return { patched: true, status: "patched", text };
}

function listCandidates(dir: string, filenamePattern: RegExp): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw dist directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return entries
    .filter((entry) => entry.isFile() && filenamePattern.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function isStateDbCandidate(source: string): boolean {
  return (
    source.includes(MARKER) ||
    source.includes("const OPENCLAW_STATE_DIR_MODE = 448;") ||
    source.includes("function ensureOpenClawStatePermissions(pathname, env) {")
  );
}

export function patchOpenClawSharedStatePermissions(distDir: string): PatchDistResult {
  const resolvedDist = path.resolve(distDir);
  const stateCandidates = listCandidates(resolvedDist, /^openclaw-state-db-.+\.js$/).filter(
    (file) => isStateDbCandidate(fs.readFileSync(file, "utf8")),
  );
  if (stateCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw shared-state database target in ${resolvedDist}, found ${stateCandidates.length}`,
    );
  }
  const agentCandidates = listCandidates(resolvedDist, /^openclaw-agent-db-.+\.js$/).filter(
    (file) => {
      const source = fs.readFileSync(file, "utf8");
      return (
        source.includes(AGENT_MARKER) ||
        source.includes("const OPENCLAW_AGENT_DB_DIR_MODE = 448;") ||
        source.includes("function ensureOpenClawAgentDatabasePermissions(pathname, options) {")
      );
    },
  );
  if (agentCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw per-agent database target in ${resolvedDist}, found ${agentCandidates.length}`,
    );
  }
  const migrationCandidates = listCandidates(resolvedDist, /^state-migrations-.+\.js$/).filter(
    (file) => {
      const source = fs.readFileSync(file, "utf8");
      return (
        source.includes(MIGRATION_MARKER) ||
        source.includes("function migrateLegacyUpdateCheckState(params) {")
      );
    },
  );
  if (migrationCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw state-migration target in ${resolvedDist}, found ${migrationCandidates.length}`,
    );
  }
  const modelsCandidates = listCandidates(resolvedDist, /^models-config-.+\.js$/).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      source.includes(MODELS_MARKER) ||
      (source.includes("async function ensureModelsFileModeForModelsJson(pathname) {") &&
        source.includes(
          "async function writeModelsFileAtomicForModelsJson(targetPath, contents) {",
        ))
    );
  });
  if (modelsCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw models-config target in ${resolvedDist}, found ${modelsCandidates.length}`,
    );
  }

  const stateFile = stateCandidates[0];
  const agentFile = agentCandidates[0];
  const migrationFile = migrationCandidates[0];
  const modelsFile = modelsCandidates[0];
  const stateResult = patchOpenClawStateDbText(fs.readFileSync(stateFile, "utf8"), stateFile);
  const agentResult = patchOpenClawAgentDbText(fs.readFileSync(agentFile, "utf8"), agentFile);
  const migrationResult = patchOpenClawStateMigrationText(
    fs.readFileSync(migrationFile, "utf8"),
    migrationFile,
  );
  const modelsResult = patchOpenClawModelsConfigText(
    fs.readFileSync(modelsFile, "utf8"),
    modelsFile,
  );
  if (stateResult.patched) fs.writeFileSync(stateFile, stateResult.text);
  if (agentResult.patched) fs.writeFileSync(agentFile, agentResult.text);
  if (migrationResult.patched) fs.writeFileSync(migrationFile, migrationResult.text);
  if (modelsResult.patched) fs.writeFileSync(modelsFile, modelsResult.text);
  const patched =
    stateResult.patched || agentResult.patched || migrationResult.patched || modelsResult.patched;
  return {
    files: [stateFile, agentFile, migrationFile, modelsFile],
    patched,
    status: patched ? "patched" : "already-patched",
  };
}

function main(argv: readonly string[]): number {
  const distDir = argv[2];
  if (!distDir || argv.length > 3) {
    console.error(usage());
    return 2;
  }
  try {
    const result = patchOpenClawSharedStatePermissions(distDir);
    console.log(
      `INFO: OpenClaw SQLite state permissions ${result.status}: ${result.files.map((file) => path.basename(file)).join(", ")}`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv);
}
