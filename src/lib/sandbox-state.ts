// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Manifest-driven sandbox state backup and restore.
//
// Handles the sandbox→host direction for rebuild (reverse of migration-state.ts
// which handles host→sandbox for onboarding). Uses agent manifest state_dirs
// and configPaths to know what to back up, so it works for any agent type.
//
// Credentials are stripped from backups using shared credential-filter.ts.

import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import * as registry from "./registry.js";
import { loadAgent } from "./agent-defs.js";
import type { AgentStateFile } from "./agent-defs.js";
import { resolveOpenshell } from "./resolve-openshell.js";
import { captureOpenshellCommand } from "./openshell.js";
import { sanitizeConfigFile, isSensitiveFile } from "./credential-filter.js";
import { shellQuote } from "./runner.js";

const HOME_DIR = path.resolve(process.env.HOME || os.homedir());
const REBUILD_BACKUPS_DIR = path.join(HOME_DIR, ".nemoclaw", "rebuild-backups");

const MANIFEST_VERSION = 1;

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

// ── Types ──────────────────────────────────────────────────────────

export interface RebuildManifest {
  version: number;
  sandboxName: string;
  timestamp: string;
  agentType: string;
  agentVersion: string | null;
  expectedVersion: string | null;
  stateDirs: string[];
  stateFiles?: StateFileSpec[];
  /** Single config/state directory */
  dir: string;
  /** @deprecated Old field name for `dir` — retained for backward compat with pre-consolidation backups. */
  writableDir?: string;
  backupPath: string;
  blueprintDigest: string | null;
  policyPresets?: string[];
  instances?: InstanceBackup[];
  // Optional user-provided label for `snapshot restore <name>`.
  name?: string;
}

// Manifest enriched with a virtual version number computed at list time.
// Versions are position-based (v1 = oldest by timestamp) and NOT persisted,
// so they can shift if snapshots are deleted.
export type SnapshotEntry = RebuildManifest & { snapshotVersion: number };

export interface BackupOptions {
  name?: string | null;
}

export interface InstanceBackup {
  instanceId: string;
  agentType: string;
  dataDir: string;
  stateDirs: string[];
  backedUpDirs: string[];
}

export type StateFileStrategy = "copy" | "sqlite_backup";

export interface StateFileSpec {
  path: string;
  strategy: StateFileStrategy;
}

export interface BackupResult {
  success: boolean;
  // Only set once the backup has been written to disk — absent on
  // precondition failures like an invalid --name.
  manifest?: RebuildManifest;
  backedUpDirs: string[];
  failedDirs: string[];
  // Set when the failure is a precondition (e.g. duplicate --name) rather
  // than a mid-backup error. CLI surfaces this to the user verbatim.
  error?: string;
  backedUpFiles: string[];
  failedFiles: string[];
}

export interface RestoreResult {
  success: boolean;
  restoredDirs: string[];
  failedDirs: string[];
  restoredFiles: string[];
  failedFiles: string[];
}

export interface TarValidationResult {
  safe: boolean;
  entries: string[];
  violations: string[];
}

export interface SafeExtractResult {
  success: boolean;
  error?: string;
}

type UnknownRecord = { [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStateFileSpec(value: unknown): value is StateFileSpec {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.strategy === "copy" || value.strategy === "sqlite_backup") &&
    normalizeStateFileSpec({ path: value.path, strategy: value.strategy }) !== null
  );
}

function isInstanceBackup(value: unknown): value is InstanceBackup {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    typeof value.agentType === "string" &&
    typeof value.dataDir === "string" &&
    isStringArray(value.stateDirs) &&
    isStringArray(value.backedUpDirs)
  );
}

function isRebuildManifest(value: unknown): value is RebuildManifest {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    typeof value.sandboxName === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.agentType === "string" &&
    (value.agentVersion === null || typeof value.agentVersion === "string") &&
    (value.expectedVersion === null || typeof value.expectedVersion === "string") &&
    isStringArray(value.stateDirs) &&
    (typeof value.dir === "string" || typeof value.writableDir === "string") &&
    typeof value.backupPath === "string" &&
    (value.stateFiles === undefined ||
      (Array.isArray(value.stateFiles) && value.stateFiles.every(isStateFileSpec))) &&
    (value.blueprintDigest === undefined ||
      value.blueprintDigest === null ||
      typeof value.blueprintDigest === "string") &&
    (value.policyPresets === undefined || isStringArray(value.policyPresets)) &&
    (value.instances === undefined ||
      (Array.isArray(value.instances) &&
        value.instances.every((entry) => isInstanceBackup(entry)))) &&
    (value.name === undefined || typeof value.name === "string")
  );
}

// ── Safe tar extraction ──────────────────────────────────────────

/**
 * Normalize a host path for safe comparison.
 * Mirrors migration-state.ts normalizeHostPath().
 */
function normalizeHostPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Check whether candidatePath is within rootPath after normalization.
 * Mirrors migration-state.ts isWithinRoot().
 */
function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeHostPath(candidatePath);
  const root = normalizeHostPath(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reject a path if it — or any ancestor up to $HOME — is a symlink.
 * Prevents an attacker from planting a symlink at the target path to
 * redirect reads or writes to an attacker-controlled directory.
 *
 * Mirrors the pattern from config-io.ts (PR #2290) and
 * nemoclaw/src/blueprint/snapshot.ts.
 */
function rejectSymlinksOnPath(targetPath: string): void {
  const home = HOME_DIR;
  const resolved = path.resolve(targetPath);

  const relToHome = path.relative(home, resolved);
  if (relToHome === "" || relToHome.startsWith("..") || path.isAbsolute(relToHome)) {
    return;
  }

  let current = resolved;
  while (current !== home && current !== path.dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(current);
        throw new Error(
          `Refusing to operate on path: ${current} is a symbolic link ` +
            `(target: ${linkTarget}). This may indicate a symlink attack.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}

/**
 * List tar entries and validate every path is within targetDir.
 * Rejects absolute paths, path traversal (..), and null bytes.
 */
export function validateTarEntries(tarBuffer: Buffer, targetDir: string): TarValidationResult {
  const result = spawnSync("tar", ["-tf", "-"], {
    input: tarBuffer,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });

  if (result.status !== 0) {
    return {
      safe: false,
      entries: [],
      violations: [
        `tar listing failed (exit ${result.status}): ${(result.stderr || "").substring(0, 200)}`,
      ],
    };
  }

  const entries = (result.stdout || "")
    .trim()
    .split("\n")
    .filter((e) => e.length > 0);
  const violations: string[] = [];

  for (const entry of entries) {
    // Reject null bytes (null byte injection)
    if (entry.includes("\0")) {
      violations.push(`null byte in entry: ${JSON.stringify(entry)}`);
      continue;
    }

    // Reject absolute paths
    if (entry.startsWith("/")) {
      violations.push(`absolute path: ${entry}`);
      continue;
    }

    // Resolve the entry relative to targetDir and check containment
    const resolved = path.resolve(targetDir, entry);
    if (!isWithinRoot(resolved, targetDir)) {
      violations.push(`path traversal: ${entry}`);
    }
  }

  return { safe: violations.length === 0, entries, violations };
}

/**
 * Walk a directory and return violations for any symlinks whose
 * resolved targets don't land within any of the allowed roots.
 *
 * `allowedRoots` always includes the extraction directory (the local host
 * path). Callers pass additional roots — notably `/sandbox` — to permit
 * legitimate intra-sandbox symlinks baked into the sandbox base image
 * (e.g. `/sandbox/.openclaw` → `/sandbox/.openclaw-data`). Those look
 * like "escapes" relative to the extraction temp dir on the host, but
 * are intra-sandbox once the backup is restored. See issue #2268.
 */
function auditExtractedSymlinks(dirPath: string, allowedRoots: string[]): string[] {
  const violations: string[] = [];
  if (!existsSync(dirPath)) return violations;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(fullPath);

          // Resolve relative to the symlink's containing directory (standard).
          const resolvedRelative = path.resolve(path.dirname(fullPath), linkTarget);

          // For absolute symlinks that point into the canonical sandbox data
          // directory (/sandbox/.openclaw-data/** or /sandbox/.hermes-data/**),
          // also check whether the target falls within the extraction root when
          // the leading /sandbox/ prefix is mapped onto the archive root. This
          // mirrors how the symlink resolves once the backup is restored inside
          // the sandbox container (where /sandbox/.openclaw-data/* exists).
          //
          // Only /sandbox/ prefixed targets receive this treatment so that
          // symlinks pointing to arbitrary absolute paths (e.g. /etc/passwd)
          // are still rejected. Fixes #2317.
          const SANDBOX_DATA_PREFIXES = ["/sandbox/.openclaw-data/", "/sandbox/.hermes-data/"];
          // Normalize the target first to collapse any .. traversal segments
          // (e.g. /sandbox/.openclaw-data/../../etc/passwd → /etc/passwd).
          // Only then check the prefix — this prevents a traversal bypass
          // where a crafted target starts with an allowed prefix but escapes it.
          const normalizedTarget = path.posix.normalize(linkTarget);
          const resolvedInArchive =
            path.isAbsolute(normalizedTarget) &&
            SANDBOX_DATA_PREFIXES.some((p) => normalizedTarget.startsWith(p))
              ? path.resolve(dirPath, normalizedTarget.replace(/^\//, ""))
              : null;

          const inAnyAllowedRoot =
            allowedRoots.some((root) => isWithinRoot(resolvedRelative, root)) ||
            (resolvedInArchive !== null && isWithinRoot(resolvedInArchive, dirPath));

          if (!inAnyAllowedRoot) {
            violations.push(
              `symlink escape: ${fullPath} -> ${linkTarget} (resolves to ${resolvedRelative})`,
            );
          }
        } else if (stat.isDirectory()) {
          walk(fullPath);
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  walk(dirPath);
  return violations;
}

/**
 * Detect hard-link entries in a tar archive using verbose listing.
 * Hard links are rejected entirely — sandbox state backups have no
 * legitimate reason to contain them, and they can be used to reference
 * files outside the extraction root.
 */
export function rejectHardLinks(tarBuffer: Buffer): string[] {
  const result = spawnSync("tar", ["-tvf", "-"], {
    input: tarBuffer,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });

  if (result.status !== 0) {
    return [`tar verbose listing failed (exit ${result.status})`];
  }

  const violations: string[] = [];
  const lines = (result.stdout || "")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);

  for (const line of lines) {
    // Both GNU tar and bsdtar prefix hard-link entries with 'h' in verbose mode
    // and include " link to " in the line.
    if (line.startsWith("h") || / link to /.test(line)) {
      violations.push(`hard link: ${line.trim()}`);
    }
  }

  return violations;
}

/**
 * SECURITY: Validate tar contents, extract with safety flags, then
 * audit for symlink escapes. Nukes the extraction on any violation.
 */
export function safeTarExtract(tarBuffer: Buffer, targetDir: string): SafeExtractResult {
  // Phase 1a: Validate entry paths before extraction
  const validation = validateTarEntries(tarBuffer, targetDir);
  if (!validation.safe) {
    return {
      success: false,
      error: `tar entry validation failed: ${validation.violations.join("; ")}`,
    };
  }

  // Phase 1b: Reject hard links (not detectable via tar -tf, require verbose listing)
  const hardLinkViolations = rejectHardLinks(tarBuffer);
  if (hardLinkViolations.length > 0) {
    return {
      success: false,
      error: `hard link rejected: ${hardLinkViolations.join("; ")}`,
    };
  }

  // Phase 2: Extract with --no-same-owner to prevent ownership manipulation
  const extractResult = spawnSync("tar", ["-xf", "-", "--no-same-owner", "-C", targetDir], {
    input: tarBuffer,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });

  if (extractResult.status !== 0) {
    return {
      success: false,
      error: `tar extraction failed (exit ${extractResult.status}): ${(extractResult.stderr?.toString() || "").substring(0, 200)}`,
    };
  }

  // Phase 3: Post-extraction symlink audit (symlink targets are not
  // visible in `tar -tf` output, so we must check after extraction).
  // Allow targets inside either the host extraction dir OR the canonical
  // sandbox root (/sandbox) — the latter covers legitimate intra-sandbox
  // symlinks baked into the base image (see #2268).
  const symlinkViolations = auditExtractedSymlinks(targetDir, [targetDir, "/sandbox"]);
  if (symlinkViolations.length > 0) {
    // Nuke the extraction — do not leave attacker-controlled symlinks on host
    try {
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    } catch {
      /* best effort cleanup */
    }
    return {
      success: false,
      error: `post-extraction symlink audit failed: ${symlinkViolations.join("; ")}`,
    };
  }

  return { success: true };
}

// ── Helpers ────────────────────────────────────────────────────────

function getSshConfig(sandboxName: string): string | null {
  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const result = captureOpenshellCommand(openshellBinary, ["sandbox", "ssh-config", sandboxName], {
    ignoreError: true,
  });
  if (result.status !== 0) return null;
  return result.output;
}

function writeTempSshConfig(sshConfig: string): string {
  const tmpFile = path.join(os.tmpdir(), `nemoclaw-state-${process.pid}-${Date.now()}.conf`);
  writeFileSync(tmpFile, sshConfig, { mode: 0o600 });
  return tmpFile;
}

function sshArgs(configFile: string, sandboxName: string): string[] {
  return [
    "-F",
    configFile,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
    `openshell-${sandboxName}`,
  ];
}

function computeBlueprintDigest(): string | null {
  // Look for blueprint.yaml relative to the agent-defs ROOT
  const candidates = [
    path.join(process.env.HOME || "/tmp", ".nemoclaw", "blueprints", "0.1.0", "blueprint.yaml"),
    path.join(__dirname, "..", "..", "nemoclaw-blueprint", "blueprint.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return null;
}

/**
 * Walk a local directory and sanitize any JSON config files found.
 * Also removes files that match CREDENTIAL_SENSITIVE_BASENAMES.
 */
function sanitizeBackupDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) return;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (isSensitiveFile(entry.name)) {
          try {
            require("node:fs").unlinkSync(fullPath);
          } catch {
            /* best effort */
          }
        } else if (entry.name.endsWith(".json")) {
          sanitizeConfigFile(fullPath);
        } else if (entry.name === ".env" || entry.name.endsWith(".env")) {
          // Strip credential lines from .env files (KEY=value format).
          // Hermes stores API keys in .env alongside config.yaml.
          try {
            const envContent = readFileSync(fullPath, "utf-8");
            const filtered = envContent
              .split("\n")
              .map((line) => {
                const key = line.split("=")[0]?.trim().toUpperCase() || "";
                if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) {
                  return `${line.split("=")[0]}=[STRIPPED_BY_MIGRATION]`;
                }
                return line;
              })
              .join("\n");
            writeFileSync(fullPath, filtered);
            chmodSync(fullPath, 0o600);
          } catch {
            /* best effort */
          }
        }
      }
    }
  };
  walk(dirPath);
}

// ── Logging ────────────────────────────────────────────────────────

const _verbose = () => process.env.NEMOCLAW_REBUILD_VERBOSE === "1";
function _log(msg: string): void {
  if (_verbose()) console.error(`  [sandbox-state ${new Date().toISOString()}] ${msg}`);
}

// ── Naming / versioning helpers ────────────────────────────────────

const VERSION_SELECTOR_RE = /^v(\d+)$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function validateSnapshotName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return (
      `Invalid snapshot name '${name}'. Use 1–63 chars from [A-Za-z0-9._-], ` +
      `starting with an alphanumeric.`
    );
  }
  if (VERSION_SELECTOR_RE.test(name)) {
    return (
      `Snapshot name '${name}' conflicts with the auto-assigned version format ` +
      `(v<N>). Pick a different name.`
    );
  }
  return null;
}

function normalizeStateFilePath(filePath: string): string | null {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return null;
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

function normalizeStateFileSpec(spec: AgentStateFile | StateFileSpec): StateFileSpec | null {
  const normalized = normalizeStateFilePath(spec.path);
  if (!normalized) return null;
  if (spec.strategy !== "copy" && spec.strategy !== "sqlite_backup") return null;
  return { path: normalized, strategy: spec.strategy };
}

function normalizeStateFileSpecs(specs: readonly (AgentStateFile | StateFileSpec)[]): StateFileSpec[] {
  const normalized: StateFileSpec[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const next = normalizeStateFileSpec(spec);
    if (!next) continue;
    const key = `${next.strategy}:${next.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function stateFileRemotePath(dir: string, filePath: string): string {
  return `${dir.replace(/\/+$/, "")}/${filePath}`;
}

const SQLITE_BACKUP_PY = [
  "import sqlite3, sys",
  "src, dst = sys.argv[1], sys.argv[2]",
  "src_conn = sqlite3.connect('file:' + src + '?mode=ro', uri=True, timeout=30)",
  "dst_conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    dst_conn.execute('PRAGMA busy_timeout=30000')",
  "    src_conn.backup(dst_conn)",
  "    ok = dst_conn.execute('PRAGMA quick_check').fetchone()[0]",
  "    if ok != 'ok':",
  "        raise SystemExit('sqlite quick_check failed: ' + str(ok))",
  "finally:",
  "    dst_conn.close()",
  "    src_conn.close()",
].join("\n");

const SQLITE_RESTORE_PY = [
  "import os, sqlite3, sys",
  "src, dst = sys.argv[1], sys.argv[2]",
  "os.makedirs(os.path.dirname(dst), exist_ok=True)",
  "src_conn = sqlite3.connect('file:' + src + '?mode=ro', uri=True, timeout=30)",
  "dst_conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    dst_conn.execute('PRAGMA busy_timeout=30000')",
  "    src_conn.backup(dst_conn)",
  "    ok = dst_conn.execute('PRAGMA quick_check').fetchone()[0]",
  "    if ok != 'ok':",
  "        raise SystemExit('sqlite quick_check failed: ' + str(ok))",
  "finally:",
  "    dst_conn.close()",
  "    src_conn.close()",
  "os.chmod(dst, 0o660)",
].join("\n");

function buildStateFileBackupCommand(dir: string, spec: StateFileSpec): string {
  const remotePath = stateFileRemotePath(dir, spec.path);
  const quotedRemotePath = shellQuote(remotePath);
  if (spec.strategy === "sqlite_backup") {
    return [
      `src=${quotedRemotePath}`,
      "[ ! -e \"$src\" ] && exit 2",
      '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe sqlite state file: $src" >&2; exit 10; }',
      'hardlink_count="$(find "$src" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
      '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked sqlite state file rejected: $src" >&2; exit 11; }',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-backup.XXXXXX)"',
      'trap \'rm -f "$tmp"\' EXIT',
      `python3 -c ${shellQuote(SQLITE_BACKUP_PY)} "$src" "$tmp"`,
      'cat -- "$tmp"',
    ].join("; ");
  }

  return [
    `src=${quotedRemotePath}`,
    "[ ! -e \"$src\" ] && exit 2",
    '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe state file: $src" >&2; exit 10; }',
    'hardlink_count="$(find "$src" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
    '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked state file rejected: $src" >&2; exit 11; }',
    'cat -- "$src"',
  ].join("; ");
}

function backupStateFile(
  configFile: string,
  sandboxName: string,
  dir: string,
  spec: StateFileSpec,
  backupPath: string,
): "backed_up" | "missing" | "failed" {
  const command = buildStateFileBackupCommand(dir, spec);
  _log(`Backing up state file ${spec.path} (${spec.strategy})`);
  const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), command], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (result.status === 2) return "missing";
  if (result.status !== 0 || result.error || result.signal || !result.stdout) {
    const detail =
      (result.stderr?.toString() || "").trim() ||
      result.error?.message ||
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    _log(`FAILED: state file backup ${spec.path}: ${detail.substring(0, 200)}`);
    return "failed";
  }

  const localPath = path.join(backupPath, spec.path);
  const parent = path.dirname(localPath);
  rejectSymlinksOnPath(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  rejectSymlinksOnPath(localPath);
  writeFileSync(localPath, result.stdout);
  chmodSync(localPath, 0o600);
  return "backed_up";
}

function buildStateFileRestoreCommand(dir: string, spec: StateFileSpec): string {
  const remotePath = stateFileRemotePath(dir, spec.path);
  const quotedRemotePath = shellQuote(remotePath);
  if (spec.strategy === "sqlite_backup") {
    return [
      `dst=${quotedRemotePath}`,
      'parent="$(dirname "$dst")"',
      '[ ! -L "$parent" ] || { echo "refusing symlinked state parent: $parent" >&2; exit 10; }',
      '[ ! -L "$dst" ] || { echo "refusing symlinked sqlite target: $dst" >&2; exit 11; }',
      'mkdir -p "$parent"',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-restore.XXXXXX)"',
      'trap \'rm -f "$tmp"\' EXIT',
      'cat > "$tmp"',
      'chmod 600 "$tmp"',
      `umask 0007; python3 -c ${shellQuote(SQLITE_RESTORE_PY)} "$tmp" "$dst"`,
    ].join("; ");
  }

  return [
    `dst=${quotedRemotePath}`,
    'parent="$(dirname "$dst")"',
    '[ ! -L "$parent" ] || { echo "refusing symlinked state parent: $parent" >&2; exit 10; }',
    '[ ! -L "$dst" ] || { echo "refusing symlinked state target: $dst" >&2; exit 11; }',
    'mkdir -p "$parent"',
    'tmp="$(mktemp "${parent}/.nemoclaw-restore.XXXXXX")"',
    'trap \'rm -f "$tmp"\' EXIT',
    'cat > "$tmp"',
    'chmod 640 "$tmp"',
    'mv -f "$tmp" "$dst"',
  ].join("; ");
}

function restoreStateFile(
  configFile: string,
  sandboxName: string,
  dir: string,
  spec: StateFileSpec,
  backupPath: string,
): boolean {
  const localPath = path.join(backupPath, spec.path);
  if (!existsSync(localPath)) return true;

  const command = buildStateFileRestoreCommand(dir, spec);
  _log(`Restoring state file ${spec.path} (${spec.strategy})`);
  const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), command], {
    input: readFileSync(localPath),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });

  if (result.status === 0 && !result.error && !result.signal) return true;

  const detail =
    (result.stderr?.toString() || "").trim() ||
    result.error?.message ||
    (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
  _log(`FAILED: state file restore ${spec.path}: ${detail.substring(0, 200)}`);
  return false;
}

// ── Backup ─────────────────────────────────────────────────────────

/**
 * Back up all state directories from a running sandbox.
 * Uses the agent manifest to determine which directories contain state.
 */
export function backupSandboxState(sandboxName: string, options: BackupOptions = {}): BackupResult {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  const agent = loadAgent(agentName);
  const dir = agent.configPaths.dir;
  const stateDirs = agent.stateDirs;
  const stateFiles = normalizeStateFileSpecs(agent.stateFiles);
  _log(
    `backupSandboxState: agent=${agentName}, dir=${dir}, stateDirs=[${stateDirs.join(",")}], stateFiles=[${stateFiles.map((f) => f.path).join(",")}]`,
  );

  // Validate user-supplied name and check for conflicts BEFORE creating any
  // files on disk.
  const existingBackups = listBackups(sandboxName);
  // Preserve empty strings so `--name ""` hits validateSnapshotName and fails
  // with a clear error instead of silently creating an unnamed snapshot.
  const providedName = options.name ?? null;
  if (providedName !== null) {
    const validationError = validateSnapshotName(providedName);
    if (validationError) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error: validationError,
      };
    }
    const conflict = existingBackups.find((b) => b.name === providedName);
    if (conflict) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error:
          `Snapshot name '${providedName}' already exists for '${sandboxName}' ` +
          `(at ${conflict.timestamp}). Pick a different name or delete the existing snapshot.`,
      };
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(REBUILD_BACKUPS_DIR, sandboxName, timestamp);

  // SECURITY: Verify backup destination ancestors are not symlinks.
  // Without this check, an attacker who plants ~/.nemoclaw/rebuild-backups
  // as a symlink could redirect snapshot content to an arbitrary directory.
  rejectSymlinksOnPath(backupPath);

  mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  // Re-check after creation to narrow the TOCTOU race window —
  // a symlink swapped in between the first check and mkdirSync is caught here.
  rejectSymlinksOnPath(backupPath);

  // Capture applied policy presets from the registry so they can be
  // re-applied after rebuild. Presets live in the gateway policy engine,
  // not on the sandbox filesystem, so they are lost on destroy/recreate.
  const policyPresets: string[] = sb?.policies && sb.policies.length > 0 ? [...sb.policies] : [];
  _log(`policyPresets from registry: [${policyPresets.join(",")}]`);

  const manifest: RebuildManifest = {
    version: MANIFEST_VERSION,
    sandboxName,
    timestamp,
    agentType: agentName,
    agentVersion: sb?.agentVersion || null,
    expectedVersion: agent.expectedVersion,
    stateDirs,
    stateFiles,
    dir,
    backupPath,
    blueprintDigest: computeBlueprintDigest(),
    policyPresets,
    ...(providedName !== null ? { name: providedName } : {}),
  };

  const backedUpDirs: string[] = [];
  const failedDirs: string[] = [];
  const backedUpFiles: string[] = [];
  const failedFiles: string[] = [];

  if (stateDirs.length === 0 && stateFiles.length === 0) {
    _log("WARNING: Agent manifest declares no state_dirs or state_files — nothing to back up");
    writeManifest(backupPath, manifest);
    return { success: true, manifest, backedUpDirs, failedDirs, backedUpFiles, failedFiles };
  }

  // SSH+tar single-roundtrip download
  _log("Getting SSH config via openshell sandbox ssh-config");
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("FAILED: Could not get SSH config");
    return {
      success: false,
      manifest,
      backedUpDirs,
      failedDirs: [...stateDirs],
      backedUpFiles,
      failedFiles: stateFiles.map((f) => f.path),
    };
  }
  _log(`SSH config obtained (${sshConfig.length} bytes)`);

  const configFile = writeTempSshConfig(sshConfig);
  try {
    if (stateDirs.length > 0) {
      // Build tar command that only includes existing directories.
      // First, check which declared state dirs actually exist in the sandbox,
      // then additionally discover per-agent `workspace-*` directories produced
      // by multi-agent OpenClaw deployments (see issue #1260) so they get
      // snapshotted alongside the manifest-declared dirs. `awk '!seen[$0]++'`
      // dedupes while preserving order.
      const existCheckCmd = stateDirs
        .map((d) => `[ -d ${shellQuote(`${dir}/${d}`)} ] && printf '%s\\n' ${shellQuote(d)}`)
        .join("; ");
      const workspaceGlobCmd = `for d in ${shellQuote(dir)}/workspace-*/; do [ -d "$d" ] && basename "$d"; done 2>/dev/null`;
      const fullCheckCmd = `{ ${existCheckCmd}; ${workspaceGlobCmd}; } 2>/dev/null | awk '!seen[$0]++'`;
      _log(`Checking existing dirs via SSH: ${fullCheckCmd.substring(0, 100)}...`);
      const existResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), fullCheckCmd], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      _log(
        `Dir check: exit=${existResult.status}, stdout=${(existResult.stdout || "").trim().substring(0, 200)}, stderr=${(existResult.stderr || "").trim().substring(0, 200)}`,
      );
      const existingDirs = (existResult.stdout || "")
        .trim()
        .split("\n")
        .filter((d) => d.length > 0);
      _log(
        `Existing dirs in sandbox: [${existingDirs.join(",")}] (${existingDirs.length}/${stateDirs.length})`,
      );

      if (existResult.status !== 0) {
        _log(
          `FAILED: SSH dir check exited ${existResult.status} — cannot determine which dirs exist`,
        );
        return {
          success: false,
          manifest,
          backedUpDirs,
          failedDirs: [...stateDirs],
          backedUpFiles,
          failedFiles: stateFiles.map((f) => f.path),
        };
      }

      if (existingDirs.length === 0) {
        _log("No state dirs found in sandbox (all empty)");
      } else {
        // NC-2227-04: Pre-backup audit — reject symlinks, hardlinks, and special
        // files inside state dirs. A compromised agent could plant a symlink like
        // workspace/copy -> ../openclaw.json to exfiltrate config via backup.
        const auditCmd = existingDirs
          .map(
            (d) =>
              `find ${shellQuote(`${dir}/${d}`)} \\( -type l -o \\( -type f -a -links +1 \\) -o \\( ! -type f -a ! -type d \\) \\) -printf "%y %p\\n" 2>/dev/null`,
          )
          .join(" && ");
        _log(`Pre-backup audit: checking for symlinks, hard links, and special files`);
        const auditResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), auditCmd], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
        });
        if (auditResult.status !== 0) {
          const stderr = (auditResult.stderr || "").trim();
          const detail =
            stderr || auditResult.error?.message || `exit ${String(auditResult.status)}`;
          _log(`FAILED: Pre-backup audit command failed — ${detail}`);
          return {
            success: false,
            manifest,
            backedUpDirs,
            failedDirs: [...existingDirs],
            backedUpFiles,
            failedFiles: stateFiles.map((f) => f.path),
            error: `Pre-backup audit failed: ${detail}`,
          };
        }
        const auditOutput = (auditResult.stdout || "").trim();
        if (auditOutput.length > 0) {
          // Found symlinks or special files — log them and reject the backup
          const violations = auditOutput.split("\n").filter((l) => l.length > 0);
          _log(
            `SECURITY: Pre-backup audit found ${violations.length} unsafe entries: ${violations.slice(0, 5).join("; ")}`,
          );
          return {
            success: false,
            manifest,
            backedUpDirs,
            failedDirs: [...existingDirs],
            backedUpFiles,
            failedFiles: stateFiles.map((f) => f.path),
            error: `Pre-backup audit rejected: symlinks, hard links, or special files found in state dirs: ${violations.slice(0, 3).join("; ")}`,
          };
        }
        _log("Pre-backup audit passed — no symlinks, hard links, or special files found");

        // Download via SSH+tar
        // NC-2227-04: Removed -h flag (was following symlinks). State dirs are
        // now agent-writable and co-located with config — a compromised agent
        // could create symlinks to exfiltrate config contents via backup.
        const tarCmd = `tar -cf - -C ${shellQuote(dir)} -- ${existingDirs.map(shellQuote).join(" ")}`;
        _log(`Downloading via SSH+tar: ${tarCmd}`);
        const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), tarCmd], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
          maxBuffer: 256 * 1024 * 1024,
        });
        _log(
          `SSH+tar download: exit=${result.status}, stdout=${result.stdout ? result.stdout.length + " bytes" : "null"}, stderr=${(result.stderr?.toString() || "").substring(0, 200)}`,
        );

        if (result.status === 0 && result.stdout && result.stdout.length > 0) {
          // SECURITY: Validate tar entries, extract safely, audit symlinks
          const extractResult = safeTarExtract(result.stdout, backupPath);
          if (extractResult.success) {
            backedUpDirs.push(...existingDirs);
          } else {
            _log(`SECURITY: tar extraction blocked: ${extractResult.error}`);
            failedDirs.push(...existingDirs);
          }
        } else {
          failedDirs.push(...existingDirs);
        }
      }
    }

    for (const spec of stateFiles) {
      const result = backupStateFile(configFile, sandboxName, dir, spec, backupPath);
      if (result === "backed_up") {
        backedUpFiles.push(spec.path);
      } else if (result === "failed") {
        failedFiles.push(spec.path);
      }
    }
  } finally {
    try {
      require("node:fs").unlinkSync(configFile);
    } catch {
      /* ignore */
    }
  }

  // SECURITY: Strip credentials from the local backup
  sanitizeBackupDirectory(backupPath);

  // Record any discovered per-agent workspace-* directories in the manifest
  // alongside the manifest-declared state dirs, so restoreSandboxState()
  // finds them when filtering backupPath contents. Preserve declared order
  // and append newly-discovered workspace-* names that weren't already in
  // stateDirs. See issue #1260.
  const discoveredWorkspaces = backedUpDirs.filter(
    (d) => d.startsWith("workspace-") && !stateDirs.includes(d),
  );
  if (discoveredWorkspaces.length > 0) {
    manifest.stateDirs = [...stateDirs, ...discoveredWorkspaces];
    _log(
      `Manifest stateDirs extended with multi-agent workspaces: [${discoveredWorkspaces.join(",")}]`,
    );
  }

  writeManifest(backupPath, manifest);
  manifest.backupPath = backupPath;

  return {
    success: failedDirs.length === 0 && failedFiles.length === 0,
    manifest,
    backedUpDirs,
    failedDirs,
    backedUpFiles,
    failedFiles,
  };
}

// ── Restore ────────────────────────────────────────────────────────

/**
 * Restore state directories into a sandbox from a prior backup.
 */
export function restoreSandboxState(sandboxName: string, backupPath: string): RestoreResult {
  _log(`restoreSandboxState: sandbox=${sandboxName}, backupPath=${backupPath}`);
  const manifest = readManifest(backupPath);
  if (!manifest) {
    _log("FAILED: Could not read rebuild-manifest.json");
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
    };
  }

  const dir = manifest.dir || manifest.writableDir;
  if (!dir) {
    _log("FAILED: manifest has no dir or writableDir");
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
    };
  }
  const restoredDirs: string[] = [];
  const failedDirs: string[] = [];
  const restoredFiles: string[] = [];
  const failedFiles: string[] = [];

  // Find which backed-up directories actually exist locally
  const localDirs = manifest.stateDirs.filter((d) => existsSync(path.join(backupPath, d)));
  const stateFiles = normalizeStateFileSpecs(manifest.stateFiles ?? []);
  const localFiles = stateFiles.filter((f) => existsSync(path.join(backupPath, f.path)));
  _log(
    `Local backup dirs: [${localDirs.join(",")}] (${localDirs.length}/${manifest.stateDirs.length})`,
  );
  _log(
    `Local backup files: [${localFiles.map((f) => f.path).join(",")}] (${localFiles.length}/${stateFiles.length})`,
  );

  if (localDirs.length === 0 && localFiles.length === 0) {
    _log("No dirs or files to restore");
    return { success: true, restoredDirs, failedDirs, restoredFiles, failedFiles };
  }

  _log("Getting SSH config for restore");
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("FAILED: Could not get SSH config for restore");
    return {
      success: false,
      restoredDirs,
      failedDirs: [...localDirs],
      restoredFiles,
      failedFiles: localFiles.map((f) => f.path),
    };
  }

  const configFile = writeTempSshConfig(sshConfig);
  try {
    if (localDirs.length > 0) {
      // Upload via tar pipe
      // NC-2227-04: Removed -h flag from restore as well — no symlink following.
      const tarResult = spawnSync("tar", ["-cf", "-", "-C", backupPath, ...localDirs], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
        maxBuffer: 256 * 1024 * 1024,
      });

      if (tarResult.status !== 0 || !tarResult.stdout) {
        return {
          success: false,
          restoredDirs,
          failedDirs: [...localDirs],
          restoredFiles,
          failedFiles: localFiles.map((f) => f.path),
        };
      }

      // Remove existing state dirs before extracting so stale files from
      // later snapshots don't persist after restoring an earlier one.
      const rmCmd = localDirs.map((d) => `rm -rf -- ${shellQuote(`${dir}/${d}`)}`).join(" && ");
      _log(`Cleaning target dirs before restore: ${rmCmd}`);
      const rmResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), rmCmd], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      if (rmResult.status !== 0 || rmResult.error || rmResult.signal) {
        const stderr = (rmResult.stderr?.toString() || "").trim();
        const detail =
          stderr ||
          rmResult.error?.message ||
          (rmResult.signal ? `signal ${rmResult.signal}` : `exit ${String(rmResult.status)}`);
        _log(`FAILED: pre-restore cleanup failed: ${detail.substring(0, 200)}`);
        return {
          success: false,
          restoredDirs,
          failedDirs: [...localDirs],
          restoredFiles,
          failedFiles: localFiles.map((f) => f.path),
        };
      }

      const extractCmd = `tar --no-same-owner -xf - -C ${shellQuote(dir)}`;
      const sshResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), extractCmd], {
        input: tarResult.stdout,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      });

      if (sshResult.status === 0) {
        const restoredPaths = localDirs.map((d) => `${dir}/${d}`);

        // Best-effort only: OpenShell exec/SSH normally runs as the sandbox user,
        // which cannot chown even files it owns. The tar restore above runs as the
        // same user, so the real restore gate is whether the restored state dirs
        // are usable by that user.
        const chownCmd = `chown -R sandbox:sandbox -- ${restoredPaths.map(shellQuote).join(" ")} 2>/dev/null || true`;
        _log(`Best-effort ownership repair: ${chownCmd}`);
        const chownResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), chownCmd], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
        });
        if (chownResult.error || chownResult.signal) {
          const detail =
            chownResult.error?.message ||
            (chownResult.signal ? `signal ${chownResult.signal}` : "unknown error");
          _log(
            `WARNING: post-restore ownership repair did not complete: ${detail.substring(0, 200)}`,
          );
        }

        const usabilityCmd = restoredPaths
          .map(
            (p) =>
              `[ -d ${shellQuote(p)} ] && [ ! -L ${shellQuote(p)} ] && [ -r ${shellQuote(p)} ] && [ -w ${shellQuote(p)} ]`,
          )
          .join(" && ");
        _log(`Verifying restored state usability: ${usabilityCmd}`);
        const usabilityResult = spawnSync(
          "ssh",
          [...sshArgs(configFile, sandboxName), usabilityCmd],
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30000,
          },
        );
        if (usabilityResult.status === 0 && !usabilityResult.error && !usabilityResult.signal) {
          restoredDirs.push(...localDirs);
        } else {
          const stderr = (usabilityResult.stderr?.toString() || "").trim();
          const detail =
            stderr ||
            usabilityResult.error?.message ||
            (usabilityResult.signal
              ? `signal ${usabilityResult.signal}`
              : `exit ${String(usabilityResult.status)}`);
          _log(`FAILED: restored state usability check failed: ${detail.substring(0, 200)}`);
          failedDirs.push(...localDirs);
        }
      } else {
        failedDirs.push(...localDirs);
      }
    }

    for (const spec of localFiles) {
      if (restoreStateFile(configFile, sandboxName, dir, spec, backupPath)) {
        restoredFiles.push(spec.path);
      } else {
        failedFiles.push(spec.path);
      }
    }
  } finally {
    try {
      require("node:fs").unlinkSync(configFile);
    } catch {
      /* ignore */
    }
  }

  return {
    success: failedDirs.length === 0 && failedFiles.length === 0,
    restoredDirs,
    failedDirs,
    restoredFiles,
    failedFiles,
  };
}

// ── Manifest ───────────────────────────────────────────────────────

function writeManifest(backupPath: string, manifest: RebuildManifest): void {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  chmodSync(manifestPath, 0o600);
}

function readManifest(backupPath: string): RebuildManifest | null {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = parseJson<unknown>(readFileSync(manifestPath, "utf-8"));
    if (!isRebuildManifest(parsed)) return null;
    const manifest = parsed as RebuildManifest & { dir?: string; writableDir?: string };
    const dir = manifest.dir ?? manifest.writableDir;
    if (!dir) return null;
    return {
      ...manifest,
      dir,
      stateFiles: normalizeStateFileSpecs(manifest.stateFiles ?? []),
      blueprintDigest: manifest.blueprintDigest ?? null,
    };
  } catch {
    return null;
  }
}

// ── Listing ────────────────────────────────────────────────────────

/**
 * List available backups for a sandbox, newest first, each enriched with a
 * virtual `snapshotVersion` number.
 *
 * Version numbers are position-based (v1 = oldest by timestamp, vN = newest)
 * and computed fresh on every call — they are NOT persisted, so deleting a
 * snapshot will re-number everything newer than it.
 */
export function listBackups(sandboxName: string): SnapshotEntry[] {
  const dir = path.join(REBUILD_BACKUPS_DIR, sandboxName);
  if (!existsSync(dir)) return [];

  const rawEntries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());

  const manifests: RebuildManifest[] = [];
  for (const entry of rawEntries) {
    const m = readManifest(path.join(dir, entry.name));
    if (m) manifests.push(m);
  }

  // Assign version numbers by timestamp-ascending position (v1 = oldest).
  const asc = [...manifests].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const numbered: SnapshotEntry[] = asc.map((m, i) => ({
    ...m,
    snapshotVersion: i + 1,
  }));

  // Return newest-first for display.
  return numbered.reverse();
}

/**
 * Get the most recent backup for a sandbox, or null.
 */
export function getLatestBackup(sandboxName: string): SnapshotEntry | null {
  const backups = listBackups(sandboxName);
  return backups[0] || null;
}

export interface SnapshotMatchResult {
  match: SnapshotEntry | null;
}

/**
 * Resolve a user-supplied snapshot selector to a single backup.
 *
 * Selector precedence:
 *   1. `v<N>` — exact (virtual) snapshotVersion match (case-insensitive)
 *   2. exact user-assigned name match
 *   3. exact timestamp match
 */
export function findBackup(sandboxName: string, selector: string): SnapshotMatchResult {
  const backups = listBackups(sandboxName);

  const versionMatch = VERSION_SELECTOR_RE.exec(selector);
  if (versionMatch) {
    const wanted = Number.parseInt(versionMatch[1], 10);
    const hit = backups.find((b) => b.snapshotVersion === wanted);
    return { match: hit ?? null };
  }

  const byName = backups.find((b) => b.name === selector);
  if (byName) return { match: byName };

  const byExactTimestamp = backups.find((b) => b.timestamp === selector);
  if (byExactTimestamp) return { match: byExactTimestamp };

  return { match: null };
}

// ── CLI argv parser ────────────────────────────────────────────────
//
// Argument parser for `nemoclaw <name> snapshot restore [selector] [--to <dst>]`.
export interface RestoreArgs {
  ok: true;
  targetSandbox: string;
  selector: string | null;
}

export interface RestoreArgsError {
  ok: false;
  error: string;
}

export type RestoreArgsResult = RestoreArgs | RestoreArgsError;

export function parseRestoreArgs(
  sandboxName: string,
  subArgs: readonly string[],
): RestoreArgsResult {
  const positional: string[] = [];
  let targetSandbox = sandboxName;
  for (let i = 1; i < subArgs.length; i++) {
    const token = subArgs[i];
    if (token === "--to") {
      const value = subArgs[i + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: "--to requires a target sandbox name." };
      }
      targetSandbox = value;
      i++;
    } else {
      positional.push(token);
    }
  }
  return {
    ok: true,
    targetSandbox,
    selector: positional[0] ?? null,
  };
}
