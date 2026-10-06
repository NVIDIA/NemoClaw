#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary compatibility patch for OpenClaw 2026.9.1 managed state.
 *
 * NemoClaw's native OpenClaw lifecycle runs the gateway, doctor, auto-pair,
 * one-shot, and agent paths as the sandbox identity. OpenClaw 2026.9.1 makes
 * shared and per-agent SQLite state part of gateway startup and hardens those
 * paths to owner-only modes. Generic credential and identity stores remain owner-only.
 * Preserve those private modes. OpenClaw owns its native state migrations;
 * this patch validates but does not modify the update-check migration.
 *
 * Remove this patch once upstream no longer needs these managed-runtime
 * permission and legacy-cache compatibility changes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw: group-shared OpenClaw state */";
export const AGENT_MARKER = "/* nemoclaw: group-shared OpenClaw agent state */";
export const MODELS_MARKER = "/* nemoclaw: group-shared OpenClaw models file */";

const GROUP_SHARED_ENV_HELPER = [
  "function nemoclawUsesGroupSharedState(env) {",
  "\tconst nemoclawSharedStateMarker = env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;",
  '\treturn nemoclawSharedStateMarker === "1";',
  "}",
].join("\n");

const UPSTREAM_MODE_CONSTANTS = [
  "const OPENCLAW_STATE_DIR_MODE = 448;",
  "const OPENCLAW_STATE_FILE_MODE = 384;",
].join("\n");

const PATCHED_MODE_CONSTANTS = [
  UPSTREAM_MODE_CONSTANTS,
  `const NEMOCLAW_SHARED_STATE_DIR_MODE = 0o700; ${MARKER}`,
  "const NEMOCLAW_SHARED_STATE_FILE_MODE = 0o600;",
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

const UPSTREAM_CHMOD_HELPER_20260901 = [
  "function bestEffortChmodSync(target, mode) {",
  "\tconst result = applyPrivateModeSync(target, mode);",
  "\tif (result.applied || chmodWarnedTargets.check(target)) return;",
  "\tstateDbLog$2.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);",
  "}",
].join("\n");

const PATCHED_CHMOD_HELPER_20260901 = [
  "function bestEffortChmodSync(target, mode, skipWhenModeMatches = false) {",
  "\tif (skipWhenModeMatches) try {",
  "\t\tif ((fs.statSync(target).mode & 0o7777) === mode) return;",
  "\t} catch {}",
  "\tconst result = applyPrivateModeSync(target, mode);",
  "\tif (result.applied || chmodWarnedTargets.check(target)) return;",
  "\tstateDbLog$2.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);",
  "}",
].join("\n");

const STATE_CHMOD_HELPER_SHAPES = [
  { patched: PATCHED_CHMOD_HELPER, upstream: UPSTREAM_CHMOD_HELPER },
  {
    patched: PATCHED_CHMOD_HELPER_20260901,
    upstream: UPSTREAM_CHMOD_HELPER_20260901,
  },
] as const;

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

const UPSTREAM_PERMISSION_HELPER_20260901 = [
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
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) if (existsSync(candidate)) try {",
  "\t\tbestEffortChmodSync(candidate, OPENCLAW_STATE_FILE_MODE);",
  "\t} catch (error) {",
  '\t\tif (candidate === pathname || !hasErrnoCode(error, "ENOENT")) throw error;',
  "\t}",
  "}",
].join("\n");

const PATCHED_PERMISSION_HELPER_20260901 = [
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
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) if (existsSync(candidate)) try {",
  "\t\tbestEffortChmodSync(candidate, nemoclawStateFileMode, nemoclawGroupSharedState);",
  "\t} catch (error) {",
  '\t\tif (candidate === pathname || !hasErrnoCode(error, "ENOENT")) throw error;',
  "\t}",
  "}",
].join("\n");

const STATE_PERMISSION_HELPER_SHAPES = [
  { patched: PATCHED_PERMISSION_HELPER, upstream: UPSTREAM_PERMISSION_HELPER },
  {
    patched: PATCHED_PERMISSION_HELPER_20260901,
    upstream: UPSTREAM_PERMISSION_HELPER_20260901,
  },
] as const;

const PATCHED_STATE_REQUIRED_PATTERNS = [
  MARKER,
  "const NEMOCLAW_SHARED_STATE_DIR_MODE = 0o700;",
  "const NEMOCLAW_SHARED_STATE_FILE_MODE = 0o600;",
  "function nemoclawUsesGroupSharedState(env) {",
  "env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE",
  "function bestEffortChmodSync(target, mode, skipWhenModeMatches = false) {",
  "const nemoclawGroupSharedState = nemoclawUsesGroupSharedState(env);",
  "mode: nemoclawStateDirMode",
  "bestEffortChmodSync(dir, nemoclawStateDirMode, nemoclawGroupSharedState);",
  "bestEffortChmodSync(candidate, nemoclawStateFileMode, nemoclawGroupSharedState);",
] as const;

const PATCHED_STATE_MODE_MATCH_PATTERNS = [
  "(statSync(target).mode & 0o7777) === mode",
  "(fs.statSync(target).mode & 0o7777) === mode",
] as const;

const UPSTREAM_AGENT_MODE_CONSTANTS = [
  "const OPENCLAW_AGENT_DB_DIR_MODE = 448;",
  "const OPENCLAW_AGENT_DB_FILE_MODE = 384;",
].join("\n");

const PATCHED_AGENT_MODE_CONSTANTS = [
  UPSTREAM_AGENT_MODE_CONSTANTS,
  `const NEMOCLAW_SHARED_AGENT_DB_DIR_MODE = 0o700; ${AGENT_MARKER}`,
  "const NEMOCLAW_SHARED_AGENT_DB_FILE_MODE = 0o600;",
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

const UPSTREAM_AGENT_PERMISSION_HELPER_20260901 = [
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
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) try {",
  "\t\tchmodSync(candidate, OPENCLAW_AGENT_DB_FILE_MODE);",
  "\t} catch (error) {",
  '\t\tif (error.code !== "ENOENT") throw error;',
  "\t}",
  "}",
].join("\n");

const PATCHED_AGENT_PERMISSION_HELPER_20260901 = [
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
  "\tfor (const candidate of resolveSqliteDatabaseFilePaths(pathname)) try {",
  "\t\tif (!nemoclawGroupSharedState || (statSync(candidate).mode & 0o7777) !== nemoclawAgentFileMode) chmodSync(candidate, nemoclawAgentFileMode);",
  "\t} catch (error) {",
  '\t\tif (error.code !== "ENOENT") throw error;',
  "\t}",
  "}",
].join("\n");

const AGENT_PERMISSION_HELPER_SHAPES = [
  {
    patched: PATCHED_AGENT_PERMISSION_HELPER,
    upstream: UPSTREAM_AGENT_PERMISSION_HELPER,
  },
  {
    patched: PATCHED_AGENT_PERMISSION_HELPER_20260901,
    upstream: UPSTREAM_AGENT_PERMISSION_HELPER_20260901,
  },
] as const;

const PATCHED_AGENT_REQUIRED_PATTERNS = [
  AGENT_MARKER,
  "const NEMOCLAW_SHARED_AGENT_DB_DIR_MODE = 0o700;",
  "const NEMOCLAW_SHARED_AGENT_DB_FILE_MODE = 0o600;",
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

const UPSTREAM_MIGRATION_START_20260901 = [
  "function migrateLegacyUpdateCheckState(params) {",
  "\treturn migrateLegacyJsonState({",
].join("\n");

const NATIVE_MIGRATION_STARTS = [
  UPSTREAM_MIGRATION_START,
  UPSTREAM_MIGRATION_START_20260901,
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
  "\tconst nemoclawModelsFileMode = nemoclawGroupSharedState ? 0o600 : 384;",
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
  "const nemoclawModelsFileMode = nemoclawGroupSharedState ? 0o600 : 384;",
  "((await fs.stat(pathname)).mode & 0o7777) === nemoclawModelsFileMode",
  "await fs.chmod(pathname, nemoclawModelsFileMode).catch(() => {});",
] as const;

type PatchStatus = "patched" | "already-patched" | "unchanged";

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

function resolveExactlyOneShape(
  source: string,
  shapes: ReadonlyArray<{
    readonly patched: string;
    readonly upstream: string;
  }>,
  label: string,
  file: string,
) {
  const count = shapes.reduce(
    (total, shape) => total + countOccurrences(source, shape.upstream),
    0,
  );
  if (count !== 1) throw new Error(`${file}: expected exactly one ${label}, found ${count}`);
  return shapes.find((shape) => source.includes(shape.upstream)) as {
    readonly patched: string;
    readonly upstream: string;
  };
}

function validatePatchedStateText(source: string, file: string): void {
  for (const pattern of PATCHED_STATE_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  const modeMatchCount = PATCHED_STATE_MODE_MATCH_PATTERNS.reduce(
    (count, pattern) => count + countOccurrences(source, pattern),
    0,
  );
  if (modeMatchCount !== 1) {
    throw new Error(
      `${file}: expected exactly one patched shared-state mode guard, found ${modeMatchCount}`,
    );
  }
  if (
    STATE_CHMOD_HELPER_SHAPES.some((shape) => source.includes(shape.upstream)) ||
    STATE_PERMISSION_HELPER_SHAPES.some((shape) => source.includes(shape.upstream))
  ) {
    throw new Error(`${file}: patch marker is present but an upstream permission target remains`);
  }
}

export function patchOpenClawStateDbText(source: string, file: string): PatchTextResult {
  if (source.includes(MARKER)) {
    validatePatchedStateText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_MODE_CONSTANTS, "state mode constants", file);
  const chmodShape = resolveExactlyOneShape(
    source,
    STATE_CHMOD_HELPER_SHAPES,
    "chmod helper",
    file,
  );
  const permissionShape = resolveExactlyOneShape(
    source,
    STATE_PERMISSION_HELPER_SHAPES,
    "state permission helper",
    file,
  );

  const text = source
    .replace(UPSTREAM_MODE_CONSTANTS, PATCHED_MODE_CONSTANTS)
    .replace(chmodShape.upstream, chmodShape.patched)
    .replace(permissionShape.upstream, permissionShape.patched);
  validatePatchedStateText(text, file);
  return { patched: true, status: "patched", text };
}

function validatePatchedAgentText(source: string, file: string): void {
  for (const pattern of PATCHED_AGENT_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  if (AGENT_PERMISSION_HELPER_SHAPES.some((shape) => source.includes(shape.upstream))) {
    throw new Error(`${file}: patch marker is present but an upstream permission target remains`);
  }
}

export function patchOpenClawAgentDbText(source: string, file: string): PatchTextResult {
  if (source.includes(AGENT_MARKER)) {
    validatePatchedAgentText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_AGENT_MODE_CONSTANTS, "agent state mode constants", file);
  const permissionShape = resolveExactlyOneShape(
    source,
    AGENT_PERMISSION_HELPER_SHAPES,
    "agent state permission helper",
    file,
  );
  const text = source
    .replace(UPSTREAM_AGENT_MODE_CONSTANTS, PATCHED_AGENT_MODE_CONSTANTS)
    .replace(permissionShape.upstream, permissionShape.patched);
  validatePatchedAgentText(text, file);
  return { patched: true, status: "patched", text };
}

export function patchOpenClawStateMigrationText(source: string, file: string): PatchTextResult {
  const matches = NATIVE_MIGRATION_STARTS.filter((start) => source.includes(start));
  if (matches.length !== 1) {
    throw new Error(
      `${file}: expected exactly one legacy update-check migration start, found ${matches.length}`,
    );
  }
  return { patched: false, status: "unchanged", text: source };
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
  const migrationCandidates = listCandidates(resolvedDist, /^state-migrations[.-].+\.js$/).filter(
    (file) => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes("function migrateLegacyUpdateCheckState(params) {");
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
