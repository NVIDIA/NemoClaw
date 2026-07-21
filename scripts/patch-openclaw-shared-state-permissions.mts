#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary compatibility patch for OpenClaw 2026.7.1 split-user state.
 *
 * NemoClaw intentionally runs the OpenClaw CLI and gateway as separate users
 * in the same group. OpenClaw 2026.7.1 makes shared and per-agent SQLite state
 * and private file stores part of gateway startup, but hardens those paths to
 * owner-only modes. Preserve upstream behavior outside NemoClaw, use
 * group-shared modes inside its image or an OpenShell sandbox, and ignore only
 * the obsolete pinned-version update cache when its migration cannot archive
 * through a shields-protected parent.
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
export const SECRET_MARKER = "/* nemoclaw: group-shared OpenClaw private store */";
export const MIGRATION_MARKER = "/* nemoclaw: ignore legacy OpenClaw update-check state */";
export const FILE_STORE_MARKER = "/* nemoclaw: group-shared OpenClaw file-store defaults */";
export const MODELS_MARKER = "/* nemoclaw: group-shared OpenClaw models file */";

const GROUP_SHARED_ENV_HELPER = [
  "function nemoclawUsesGroupSharedState(env) {",
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
  "env?.OPENSHELL_SANDBOX ?? process.env.OPENSHELL_SANDBOX",
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

const UPSTREAM_SECRET_MODE_CONSTANTS = [
  "const PRIVATE_SECRET_DIR_MODE = 448;",
  "const PRIVATE_SECRET_FILE_MODE = 384;",
].join("\n");

const PATCHED_SECRET_MODE_CONSTANTS = [
  `const NEMOCLAW_SHARED_SECRET_DIR_MODE = 0o2770; ${SECRET_MARKER}`,
  "const NEMOCLAW_SHARED_SECRET_FILE_MODE = 0o660;",
  GROUP_SHARED_ENV_HELPER,
  "const PRIVATE_SECRET_DIR_MODE = nemoclawUsesGroupSharedState() ? NEMOCLAW_SHARED_SECRET_DIR_MODE : 448;",
  "const PRIVATE_SECRET_FILE_MODE = nemoclawUsesGroupSharedState() ? NEMOCLAW_SHARED_SECRET_FILE_MODE : 384;",
].join("\n");

const UPSTREAM_SECRET_PATH_MODE_HELPER = [
  "async function enforcePrivatePathMode(resolvedPath, expectedMode, kind) {",
  '\tif (process.platform === "win32") return;',
  "\tawait fs$1.chmod(resolvedPath, expectedMode);",
  "\tconst actualMode = (await fs$1.stat(resolvedPath)).mode & 511;",
  "\tif (actualMode !== expectedMode) throw new Error(`Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`);",
  "}",
].join("\n");

const PATCHED_SECRET_PATH_MODE_HELPER = [
  "async function enforcePrivatePathMode(resolvedPath, expectedMode, kind) {",
  '\tif (process.platform === "win32") return;',
  "\tconst nemoclawGroupSharedState = nemoclawUsesGroupSharedState();",
  "\tconst nemoclawModeMask = nemoclawGroupSharedState ? 0o7777 : 511;",
  "\tif (nemoclawGroupSharedState && ((await fs$1.stat(resolvedPath)).mode & nemoclawModeMask) === expectedMode) return;",
  "\tawait fs$1.chmod(resolvedPath, expectedMode);",
  "\tconst actualMode = (await fs$1.stat(resolvedPath)).mode & nemoclawModeMask;",
  "\tif (actualMode !== expectedMode) throw new Error(`Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`);",
  "}",
].join("\n");

const UPSTREAM_SECRET_WRITE_DEFAULTS = [
  "async function writeSecretFileAtomic(params) {",
  "\tconst mode = params.mode ?? 384;",
  "\tconst dirMode = params.dirMode ?? 448;",
].join("\n");

const PATCHED_SECRET_WRITE_DEFAULTS = [
  "async function writeSecretFileAtomic(params) {",
  "\tconst mode = params.mode ?? PRIVATE_SECRET_FILE_MODE;",
  "\tconst dirMode = params.dirMode ?? PRIVATE_SECRET_DIR_MODE;",
].join("\n");

const PATCHED_SECRET_REQUIRED_PATTERNS = [
  SECRET_MARKER,
  "const NEMOCLAW_SHARED_SECRET_DIR_MODE = 0o2770;",
  "const NEMOCLAW_SHARED_SECRET_FILE_MODE = 0o660;",
  "const PRIVATE_SECRET_DIR_MODE = nemoclawUsesGroupSharedState()",
  "const PRIVATE_SECRET_FILE_MODE = nemoclawUsesGroupSharedState()",
  "const nemoclawModeMask = nemoclawGroupSharedState ? 0o7777 : 511;",
  "nemoclawGroupSharedState && ((await fs$1.stat(resolvedPath)).mode & nemoclawModeMask) === expectedMode",
  "const actualMode = (await fs$1.stat(resolvedPath)).mode & nemoclawModeMask;",
  "const mode = params.mode ?? PRIVATE_SECRET_FILE_MODE;",
  "const dirMode = params.dirMode ?? PRIVATE_SECRET_DIR_MODE;",
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
  GROUP_SHARED_ENV_HELPER,
  UPSTREAM_MIGRATION_FUNCTION_START,
  `\tif (nemoclawUsesGroupSharedState()) return { changes, warnings }; ${MIGRATION_MARKER}`,
  "\tif (!fileExists(params.detected.sourcePath)) return {",
].join("\n");

const PATCHED_MIGRATION_REQUIRED_PATTERNS = [
  MIGRATION_MARKER,
  "function nemoclawUsesGroupSharedState(env) {",
  "env?.NEMOCLAW_OPENCLAW_SHARED_STATE ?? process.env.NEMOCLAW_OPENCLAW_SHARED_STATE",
  "env?.OPENSHELL_SANDBOX ?? process.env.OPENSHELL_SANDBOX",
  "function migrateLegacyUpdateCheckState(params) {",
  "if (nemoclawUsesGroupSharedState()) return { changes, warnings };",
] as const;

const UPSTREAM_FILE_STORE_START = [
  "function fileStore(options) {",
  "\tconst rootDir = path.resolve(options.rootDir);",
  "\tconst privateMode = options.private ?? false;",
  "\tconst dirMode = options.dirMode ?? 448;",
  "\tconst mode = options.mode ?? 384;",
].join("\n");

const PATCHED_FILE_STORE_START = [
  GROUP_SHARED_ENV_HELPER,
  `function fileStore(options) { ${FILE_STORE_MARKER}`,
  "\tconst rootDir = path.resolve(options.rootDir);",
  "\tconst privateMode = options.private ?? false;",
  "\tconst nemoclawGroupSharedPrivateStore = privateMode && nemoclawUsesGroupSharedState();",
  "\tconst dirMode = options.dirMode ?? (nemoclawGroupSharedPrivateStore ? 0o2770 : 448);",
  "\tconst mode = options.mode ?? (nemoclawGroupSharedPrivateStore ? 0o660 : 384);",
].join("\n");

const UPSTREAM_FILE_STORE_SYNC_START = [
  "function fileStoreSync(options) {",
  "\tconst rootDir = path.resolve(options.rootDir);",
  "\tconst privateMode = options.private ?? false;",
  "\tconst dirMode = options.dirMode ?? 448;",
  "\tconst mode = options.mode ?? 384;",
].join("\n");

const PATCHED_FILE_STORE_SYNC_START = [
  "function fileStoreSync(options) {",
  "\tconst rootDir = path.resolve(options.rootDir);",
  "\tconst privateMode = options.private ?? false;",
  "\tconst nemoclawGroupSharedPrivateStore = privateMode && nemoclawUsesGroupSharedState();",
  "\tconst dirMode = options.dirMode ?? (nemoclawGroupSharedPrivateStore ? 0o2770 : 448);",
  "\tconst mode = options.mode ?? (nemoclawGroupSharedPrivateStore ? 0o660 : 384);",
].join("\n");

const PATCHED_FILE_STORE_REQUIRED_PATTERNS = [
  FILE_STORE_MARKER,
  "function nemoclawUsesGroupSharedState(env) {",
  "function fileStore(options) {",
  "function fileStoreSync(options) {",
  "const nemoclawGroupSharedPrivateStore = privateMode && nemoclawUsesGroupSharedState();",
  "const dirMode = options.dirMode ?? (nemoclawGroupSharedPrivateStore ? 0o2770 : 448);",
  "const mode = options.mode ?? (nemoclawGroupSharedPrivateStore ? 0o660 : 384);",
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
  "env?.OPENSHELL_SANDBOX ?? process.env.OPENSHELL_SANDBOX",
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

function validatePatchedSecretText(source: string, file: string): void {
  for (const pattern of PATCHED_SECRET_REQUIRED_PATTERNS) {
    requireExactlyOnce(source, pattern, `patched pattern ${JSON.stringify(pattern)}`, file);
  }
  for (const upstreamTarget of [
    UPSTREAM_SECRET_MODE_CONSTANTS,
    UPSTREAM_SECRET_PATH_MODE_HELPER,
    UPSTREAM_SECRET_WRITE_DEFAULTS,
  ]) {
    if (source.includes(upstreamTarget)) {
      throw new Error(
        `${file}: patch marker is present but an upstream private-store target remains`,
      );
    }
  }
}

export function patchOpenClawSecretFileText(source: string, file: string): PatchTextResult {
  if (source.includes(SECRET_MARKER)) {
    validatePatchedSecretText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_SECRET_MODE_CONSTANTS, "private-store mode constants", file);
  requireExactlyOnce(
    source,
    UPSTREAM_SECRET_PATH_MODE_HELPER,
    "private-store path mode helper",
    file,
  );
  requireExactlyOnce(source, UPSTREAM_SECRET_WRITE_DEFAULTS, "private-store write defaults", file);
  const text = source
    .replace(UPSTREAM_SECRET_MODE_CONSTANTS, PATCHED_SECRET_MODE_CONSTANTS)
    .replace(UPSTREAM_SECRET_PATH_MODE_HELPER, PATCHED_SECRET_PATH_MODE_HELPER)
    .replace(UPSTREAM_SECRET_WRITE_DEFAULTS, PATCHED_SECRET_WRITE_DEFAULTS);
  validatePatchedSecretText(text, file);
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

function validatePatchedFileStoreText(source: string, file: string): void {
  for (const pattern of PATCHED_FILE_STORE_REQUIRED_PATTERNS) {
    const expectedCount = pattern.startsWith("const ") ? 2 : 1;
    const count = countOccurrences(source, pattern);
    if (count !== expectedCount) {
      throw new Error(
        `${file}: expected exactly ${expectedCount === 1 ? "one" : expectedCount} patched pattern ${JSON.stringify(pattern)}, found ${count}`,
      );
    }
  }
  if (
    source.includes(UPSTREAM_FILE_STORE_START) ||
    source.includes(UPSTREAM_FILE_STORE_SYNC_START)
  ) {
    throw new Error(`${file}: patch marker is present but an upstream file-store target remains`);
  }
}

export function patchOpenClawFileStoreText(source: string, file: string): PatchTextResult {
  if (source.includes(FILE_STORE_MARKER)) {
    validatePatchedFileStoreText(source, file);
    return { patched: false, status: "already-patched", text: source };
  }

  requireExactlyOnce(source, UPSTREAM_FILE_STORE_START, "async file-store defaults", file);
  requireExactlyOnce(source, UPSTREAM_FILE_STORE_SYNC_START, "sync file-store defaults", file);
  const text = source
    .replace(UPSTREAM_FILE_STORE_START, PATCHED_FILE_STORE_START)
    .replace(UPSTREAM_FILE_STORE_SYNC_START, PATCHED_FILE_STORE_SYNC_START);
  validatePatchedFileStoreText(text, file);
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
  const secretCandidates = listCandidates(resolvedDist, /^secret-file-.+\.js$/).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      source.includes(SECRET_MARKER) ||
      source.includes("const PRIVATE_SECRET_DIR_MODE = 448;") ||
      source.includes("async function enforcePrivatePathMode(resolvedPath, expectedMode, kind) {")
    );
  });
  if (secretCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw private-store target in ${resolvedDist}, found ${secretCandidates.length}`,
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
  const fileStoreCandidates = listCandidates(resolvedDist, /^file-store-.+\.js$/).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      source.includes(FILE_STORE_MARKER) ||
      (source.includes("function fileStore(options) {") &&
        source.includes("function fileStoreSync(options) {"))
    );
  });
  if (fileStoreCandidates.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw file-store target in ${resolvedDist}, found ${fileStoreCandidates.length}`,
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
  const secretFile = secretCandidates[0];
  const migrationFile = migrationCandidates[0];
  const fileStoreFile = fileStoreCandidates[0];
  const modelsFile = modelsCandidates[0];
  const stateResult = patchOpenClawStateDbText(fs.readFileSync(stateFile, "utf8"), stateFile);
  const agentResult = patchOpenClawAgentDbText(fs.readFileSync(agentFile, "utf8"), agentFile);
  const secretResult = patchOpenClawSecretFileText(fs.readFileSync(secretFile, "utf8"), secretFile);
  const migrationResult = patchOpenClawStateMigrationText(
    fs.readFileSync(migrationFile, "utf8"),
    migrationFile,
  );
  const fileStoreResult = patchOpenClawFileStoreText(
    fs.readFileSync(fileStoreFile, "utf8"),
    fileStoreFile,
  );
  const modelsResult = patchOpenClawModelsConfigText(
    fs.readFileSync(modelsFile, "utf8"),
    modelsFile,
  );
  if (stateResult.patched) fs.writeFileSync(stateFile, stateResult.text);
  if (agentResult.patched) fs.writeFileSync(agentFile, agentResult.text);
  if (secretResult.patched) fs.writeFileSync(secretFile, secretResult.text);
  if (migrationResult.patched) fs.writeFileSync(migrationFile, migrationResult.text);
  if (fileStoreResult.patched) fs.writeFileSync(fileStoreFile, fileStoreResult.text);
  if (modelsResult.patched) fs.writeFileSync(modelsFile, modelsResult.text);
  const patched =
    stateResult.patched ||
    agentResult.patched ||
    secretResult.patched ||
    migrationResult.patched ||
    fileStoreResult.patched ||
    modelsResult.patched;
  return {
    files: [stateFile, agentFile, secretFile, migrationFile, fileStoreFile, modelsFile],
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
