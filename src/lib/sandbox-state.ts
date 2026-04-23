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
import { resolveOpenshell } from "./resolve-openshell.js";
import { captureOpenshellCommand } from "./openshell.js";
import { sanitizeConfigFile, isSensitiveFile } from "./credential-filter.js";

const REBUILD_BACKUPS_DIR = path.join(
  process.env.HOME || "/tmp",
  ".nemoclaw",
  "rebuild-backups",
);

const MANIFEST_VERSION = 1;

// ── Types ──────────────────────────────────────────────────────────

export interface RebuildManifest {
  version: number;
  sandboxName: string;
  timestamp: string;
  agentType: string;
  agentVersion: string | null;
  expectedVersion: string | null;
  stateDirs: string[];
  writableDir: string;
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
}

export interface RestoreResult {
  success: boolean;
  restoredDirs: string[];
  failedDirs: string[];
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
 * List tar entries and validate every path is within targetDir.
 * Rejects absolute paths, path traversal (..), and null bytes.
 */
export function validateTarEntries(
  tarBuffer: Buffer,
  targetDir: string,
): TarValidationResult {
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
      violations: [`tar listing failed (exit ${result.status}): ${(result.stderr || "").substring(0, 200)}`],
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
function auditExtractedSymlinks(
  dirPath: string,
  allowedRoots: string[],
): string[] {
  const violations: string[] = [];
  if (!existsSync(dirPath)) return violations;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(fullPath);
          const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
          const inAnyAllowedRoot = allowedRoots.some((root) =>
            isWithinRoot(resolvedTarget, root),
          );
          if (!inAnyAllowedRoot) {
            violations.push(`symlink escape: ${fullPath} -> ${linkTarget} (resolves to ${resolvedTarget})`);
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
  const lines = (result.stdout || "").trim().split("\n").filter((l) => l.length > 0);

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
export function safeTarExtract(
  tarBuffer: Buffer,
  targetDir: string,
): SafeExtractResult {
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
  const extractResult = spawnSync(
    "tar",
    ["-xf", "-", "--no-same-owner", "-C", targetDir],
    { input: tarBuffer, stdio: ["pipe", "pipe", "pipe"], timeout: 60000 },
  );

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

  const result = captureOpenshellCommand(
    openshellBinary,
    ["sandbox", "ssh-config", sandboxName],
    { ignoreError: true },
  );
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
    "-F", configFile,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
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
          try { require("node:fs").unlinkSync(fullPath); } catch { /* best effort */ }
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
          } catch { /* best effort */ }
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

// ── Backup ─────────────────────────────────────────────────────────

/**
 * Back up all state directories from a running sandbox.
 * Uses the agent manifest to determine which directories contain state.
 */
export function backupSandboxState(
  sandboxName: string,
  options: BackupOptions = {},
): BackupResult {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  const agent = loadAgent(agentName);
  const writableDir = agent.configPaths.writableDir;
  const stateDirs = agent.stateDirs;
  _log(`backupSandboxState: agent=${agentName}, writableDir=${writableDir}, stateDirs=[${stateDirs.join(",")}]`);

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
        error: validationError,
      };
    }
    const conflict = existingBackups.find((b) => b.name === providedName);
    if (conflict) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        error:
          `Snapshot name '${providedName}' already exists for '${sandboxName}' ` +
          `(at ${conflict.timestamp}). Pick a different name or delete the existing snapshot.`,
      };
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(REBUILD_BACKUPS_DIR, sandboxName, timestamp);
  mkdirSync(backupPath, { recursive: true, mode: 0o700 });

  // Capture applied policy presets from the registry so they can be
  // re-applied after rebuild. Presets live in the gateway policy engine,
  // not on the sandbox filesystem, so they are lost on destroy/recreate.
  const policyPresets: string[] = sb?.policies && sb.policies.length > 0
    ? [...sb.policies]
    : [];
  _log(`policyPresets from registry: [${policyPresets.join(",")}]`);

  const manifest: RebuildManifest = {
    version: MANIFEST_VERSION,
    sandboxName,
    timestamp,
    agentType: agentName,
    agentVersion: sb?.agentVersion || null,
    expectedVersion: agent.expectedVersion,
    stateDirs,
    writableDir,
    backupPath,
    blueprintDigest: computeBlueprintDigest(),
    policyPresets,
    ...(providedName !== null ? { name: providedName } : {}),
  };

  const backedUpDirs: string[] = [];
  const failedDirs: string[] = [];

  if (stateDirs.length === 0) {
    _log("WARNING: Agent manifest declares no state_dirs — nothing to back up");
    writeManifest(backupPath, manifest);
    return { success: true, manifest, backedUpDirs, failedDirs };
  }

  // SSH+tar single-roundtrip download
  _log("Getting SSH config via openshell sandbox ssh-config");
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("FAILED: Could not get SSH config");
    return { success: false, manifest, backedUpDirs, failedDirs: [...stateDirs] };
  }
  _log(`SSH config obtained (${sshConfig.length} bytes)`);

  const configFile = writeTempSshConfig(sshConfig);
  try {
    // Build tar command that only includes existing directories
    // First, check which state dirs actually exist in the sandbox
    const existCheckCmd = stateDirs
      .map((d) => `[ -d "${writableDir}/${d}" ] && echo "${d}"`)
      .join("; ");
    _log(`Checking existing dirs via SSH: ${existCheckCmd.substring(0, 100)}...`);
    const existResult = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), existCheckCmd],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    );
    _log(`Dir check: exit=${existResult.status}, stdout=${(existResult.stdout || "").trim().substring(0, 200)}, stderr=${(existResult.stderr || "").trim().substring(0, 200)}`);
    const existingDirs = (existResult.stdout || "")
      .trim()
      .split("\n")
      .filter((d) => d.length > 0);
    _log(`Existing dirs in sandbox: [${existingDirs.join(",")}] (${existingDirs.length}/${stateDirs.length})`);

    if (existResult.status !== 0) {
      _log(`FAILED: SSH dir check exited ${existResult.status} — cannot determine which dirs exist`);
      return { success: false, manifest, backedUpDirs, failedDirs: [...stateDirs] };
    }

    if (existingDirs.length === 0) {
      _log("No state dirs found in sandbox (all empty)");
      writeManifest(backupPath, manifest);
      return { success: true, manifest, backedUpDirs, failedDirs };
    }

    // Download via SSH+tar
    const tarCmd = `tar -cf - -C ${writableDir} ${existingDirs.join(" ")}`;
    _log(`Downloading via SSH+tar: ${tarCmd}`);
    const result = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), tarCmd],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 256 * 1024 * 1024 },
    );
    _log(`SSH+tar download: exit=${result.status}, stdout=${result.stdout ? result.stdout.length + " bytes" : "null"}, stderr=${(result.stderr?.toString() || "").substring(0, 200)}`);

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
  } finally {
    try { require("node:fs").unlinkSync(configFile); } catch { /* ignore */ }
  }

  // SECURITY: Strip credentials from the local backup
  sanitizeBackupDirectory(backupPath);

  writeManifest(backupPath, manifest);
  manifest.backupPath = backupPath;

  return {
    success: failedDirs.length === 0,
    manifest,
    backedUpDirs,
    failedDirs,
  };
}

// ── Restore ────────────────────────────────────────────────────────

/**
 * Restore state directories into a sandbox from a prior backup.
 */
export function restoreSandboxState(
  sandboxName: string,
  backupPath: string,
): RestoreResult {
  _log(`restoreSandboxState: sandbox=${sandboxName}, backupPath=${backupPath}`);
  const manifest = readManifest(backupPath);
  if (!manifest) {
    _log("FAILED: Could not read rebuild-manifest.json");
    return { success: false, restoredDirs: [], failedDirs: ["manifest"] };
  }

  const writableDir = manifest.writableDir;
  const restoredDirs: string[] = [];
  const failedDirs: string[] = [];

  // Find which backed-up directories actually exist locally
  const localDirs = manifest.stateDirs.filter((d) =>
    existsSync(path.join(backupPath, d)),
  );
  _log(`Local backup dirs: [${localDirs.join(",")}] (${localDirs.length}/${manifest.stateDirs.length})`);

  if (localDirs.length === 0) {
    _log("No dirs to restore");
    return { success: true, restoredDirs, failedDirs };
  }

  _log("Getting SSH config for restore");
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("FAILED: Could not get SSH config for restore");
    return { success: false, restoredDirs, failedDirs: [...localDirs] };
  }

  const configFile = writeTempSshConfig(sshConfig);
  try {
    // Upload via tar pipe
    const tarResult = spawnSync(
      "tar",
      ["-cf", "-", "-C", backupPath, ...localDirs],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 256 * 1024 * 1024 },
    );

    if (tarResult.status !== 0 || !tarResult.stdout) {
      return { success: false, restoredDirs, failedDirs: [...localDirs] };
    }

    // Remove existing state dirs before extracting so stale files from
    // later snapshots don't persist after restoring an earlier one.
    const rmCmd = localDirs
      .map((d) => `rm -rf "${writableDir}/${d}"`)
      .join(" && ");
    _log(`Cleaning target dirs before restore: ${rmCmd}`);
    const rmResult = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), rmCmd],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    );
    if (rmResult.status !== 0) {
      _log(`WARNING: pre-restore cleanup failed (exit ${rmResult.status}): ${(rmResult.stderr?.toString() || "").substring(0, 200)}`);
    }

    const extractCmd = `tar -xf - -C ${writableDir}`;
    const sshResult = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), extractCmd],
      { input: tarResult.stdout, stdio: ["pipe", "pipe", "pipe"], timeout: 120000 },
    );

    if (sshResult.status === 0) {
      restoredDirs.push(...localDirs);

      // Fix ownership — treat failure as restore failure since wrong
      // ownership means the agent can't read its own state files.
      const openshellBinary = resolveOpenshell();
      if (openshellBinary) {
        _log(`Fixing ownership: chown -R sandbox:sandbox ${writableDir}`);
        const chownResult = spawnSync(openshellBinary, [
          "sandbox", "exec", sandboxName, "--",
          "chown", "-R", "sandbox:sandbox", writableDir,
        ], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
        if (chownResult.status !== 0) {
          _log(`WARNING: chown failed (exit ${chownResult.status}) — agent may not be able to read restored state`);
        }
      }
    } else {
      failedDirs.push(...localDirs);
    }
  } finally {
    try { require("node:fs").unlinkSync(configFile); } catch { /* ignore */ }
  }

  return {
    success: failedDirs.length === 0,
    restoredDirs,
    failedDirs,
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
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as RebuildManifest;
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

  const rawEntries = readdirSync(dir, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );

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
export function findBackup(
  sandboxName: string,
  selector: string,
): SnapshotMatchResult {
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
