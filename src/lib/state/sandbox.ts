// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Whole native home/workspace handoff for rebuild and recreation.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "child_process";

import {
  captureSandboxSshConfigCommand,
  isOpenShellSandboxPolicyCredentialFree,
  resolveOpenshellSandboxSshHost,
} from "../adapters/openshell/client.js";
import { buildSelectedOpenShellSubprocessEnv } from "../adapters/openshell/command-argv.js";
import { resolveOpenshell } from "../adapters/openshell/resolve.js";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts.js";
import type { AgentMcpAdapter, AgentStateFile } from "../agent/defs.js";
import { loadAgent } from "../agent/defs.js";
import { isObjectRecord } from "../core/json-types.js";
import { GATEWAY_PORT } from "../core/ports.js";
import { shellQuote } from "../runner.js";
import { createTempSshConfig } from "../sandbox/temp-ssh-config.js";
import { inspectMcpDeniedToolSelectors } from "../security/mcp-denied-tool-selector.js";
import { isAllowedStateSymlink, type CapturedOpenClawState } from "./state-directory-restore.js";
import {
  extractPreservedEnvAssignments,
  HERMES_PRESERVED_ENV_INVENTORY,
  type PreservedEnvFile,
  type PreservedEnvInventory,
  validatePreservedEnvFiles,
} from "./preserved-env/index.js";
import {
  cloneSandboxRuntimeSnapshot,
  type SandboxRuntimeSnapshot,
} from "./registry/runtime-snapshot.js";
import type {
  SandboxHostLocalInferenceProvenance,
  SandboxWorkloadReceipt,
} from "./registry/types.js";
import { cloneSandboxWorkloadReceipt } from "./registry/workload.js";
import * as registry from "./registry.js";
import { isSshTransportFailure } from "./ssh-transport.js";
import { nemoclawStateRoot } from "./state-root.js";
import { runTarListing, type TarArchiveSource, type TarListingSource } from "./tar-listing.js";

const HOME_DIR = path.resolve(process.env.HOME || os.homedir());
const REBUILD_BACKUPS_DIR = path.join(nemoclawStateRoot(HOME_DIR, GATEWAY_PORT), "rebuild-backups");

const MANIFEST_VERSION = 2;
const NATIVE_STATE_ARCHIVE = "native-home.tar";
const NATIVE_STATE_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
export const STATE_DIRECTORY_CAPTURE_MAX_BYTES = 256 * 1024 * 1024;
export const MANAGED_REBUILD_RESTORE_AUTHORITY_ERROR =
  "managed rebuild restore requires exact content and runtime authority";
export const HOST_LOCAL_INFERENCE_REBUILD_RESTORE_AUTHORITY_ERROR =
  "host-local inference rebuild restore requires exact content and runtime authority";

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
  /** Directories verified as safe to restore. Absent on older manifests. */
  backedUpDirs?: string[];
  /** Declared directories that could not be backed up. Absent on older manifests. */
  failedBackupDirs?: string[];
  /** False when the retained files are incomplete and must not be selected for restore. */
  backupComplete?: boolean;
  stateFiles?: StateFileSpec[];
  /**
   * Opaque copy of the OpenShell-owned native home/workspace. Version 2
   * manifests always use this instead of a per-agent state inventory.
   */
  nativeState?: {
    root: string;
    archive: typeof NATIVE_STATE_ARCHIVE;
    sha256: string;
  };
  /** Single config/state directory */
  dir: string;
  /** @deprecated Old field name for `dir` — retained for backward compat with pre-consolidation backups. */
  writableDir?: string;
  backupPath: string;
  blueprintDigest: string | null;
  /** Bounded live-policy handoff retained only while a rebuild transaction is recoverable. */
  rebuildPolicyHandoff?: {
    file: string;
    sha256: string;
    /** Cleanup-only identity; retired handoffs cannot be consumed for recovery. */
    retired?: boolean;
  };
  /** Source-derived MCP state, including an explicit empty observation, retained during recovery. */
  rebuildMcpHandoff?: {
    entries: RebuildMcpHandoffEntry[];
    runtimeSelection: OpenShellRuntimeSelection;
    /** Cleanup-only identity; retired handoffs cannot be consumed for recovery. */
    retired?: boolean;
  };
  /** Digest-bound Hermes operator config retained only while rebuild recovery is possible. */
  hermesOperatorConfigHandoff?: {
    file: string;
    sha256: string;
    /** Keys captured or classified as dropped before the handoff was written. */
    keys?: string[];
    /** Cleanup-only identity; retired handoffs cannot be consumed for recovery. */
    retired?: boolean;
  };
  /** Allowlisted non-secret environment assignments captured for image recreation. */
  preservedEnv?: PreservedEnvFile[];
  /**
   * Provider-neutral runtime and acceleration state captured before the
   * filesystem copy. Required when `workload` is a managed-image receipt.
   */
  runtimeSnapshot?: SandboxRuntimeSnapshot;
  /**
   * Exact immutable managed workload/profile authority associated with this
   * snapshot. Older and explicit Dockerfile snapshots omit this field.
   */
  workload?: SandboxWorkloadReceipt;
  /** Exact provider-neutral authority for out-of-sandbox inference. */
  hostLocalInferenceReceipt?: string;
  /** Explicit hidden-lifecycle provenance paired with the exact receipt. */
  hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  instances?: InstanceBackup[];
}

export interface RebuildMcpHandoffEntry {
  server: string;
  agent: string;
  adapter?: AgentMcpAdapter;
  url: string;
  env: string[];
  denyTools?: string[];
  trustedPrivateHost?: string;
  allowedIps?: string[];
  providerName?: string;
  providerId?: string;
  policyName: string;
  source?: "native" | "legacy" | "legacy-registry" | "policy";
}

export type SnapshotEntry = RebuildManifest;

export interface BackupOptions {
  /** Private, provider-verified source for OpenClaw recovery without container execution. */
  capturedOpenClawState?: CapturedOpenClawState;
  runtimeSnapshot?: SandboxRuntimeSnapshot;
  workload?: SandboxWorkloadReceipt;
  hostLocalInferenceReceipt?: string;
  hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  /**
   * Internal publication fence for provider-backed backups. The callback
   * runs after data capture and sanitization but before the manifest becomes
   * visible to restore and rebuild flows.
   */
  validateBeforePublish?: () => void;
  /**
   * Internal capture path for a declared state file that the sandbox-user SSH
   * transport cannot read. The caller must independently enforce path,
   * identity, and stable-read constraints before returning bytes.
   */
  captureStateFile?: StateFileCapture;
  /**
   * Internal privileged retry for state directories that the restricted tar
   * path classified as permission denied. The state layer owns the temporary
   * archive fd and validates the returned archive before publishing it.
   */
  captureStateDirectories?: StateDirectoryCapture;
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

export interface StateFileCaptureRequest {
  sandboxName: string;
  dir: string;
  spec: StateFileSpec;
}

export type StateFileCaptureResult =
  | { outcome: "backed_up"; data: Buffer }
  | { outcome: "missing" }
  | { outcome: "failed"; error?: string; unreachable?: boolean };

export interface StateDirectoryCaptureRequest {
  sandboxName: string;
  dir: string;
  dirs: readonly string[];
  /** Maximum archive bytes the privileged producer may write to the owned fd. */
  maxArchiveBytes: number;
}

export type StateDirectoryCaptureResult =
  | { outcome: "backed_up" }
  | { outcome: "failed"; error?: string; unreachable?: boolean };

export type StateFileCapture = (request: StateFileCaptureRequest) => StateFileCaptureResult | null;
export type StateDirectoryCapture = (
  request: StateDirectoryCaptureRequest,
  archiveFd: number,
) => StateDirectoryCaptureResult | null;

export interface BackupResult {
  success: boolean;
  // Only set once the backup has been written to disk — absent on
  // precondition failures like an invalid --name.
  manifest?: RebuildManifest;
  backedUpDirs: string[];
  failedDirs: string[];
  // Per-dir failure cause for entries in failedDirs, keyed by dir name.
  // Distinguishes "permission denied" (tar could not read the content) from
  // "absent after extraction" (tar succeeded but the dir never materialized)
  // so operators can tell an ownership problem from a missing dir (#6455).
  // Dirs failed for other reasons may be absent from this map.
  failedDirReasons?: Record<string, string>;
  // Set when the failure is a precondition (e.g. duplicate --name) rather
  // than a mid-backup error. CLI surfaces this to the user verbatim.
  error?: string;
  backedUpFiles: string[];
  failedFiles: string[];
  // Set when a failure stems from an SSH transport failure against a running
  // sandbox (see isSshTransportFailure), as opposed to an audit rejection or
  // a partial tar read error.
  unreachable?: boolean;
}

export interface RestoreResult {
  success: boolean;
  restoredDirs: string[];
  failedDirs: string[];
  restoredFiles: string[];
  failedFiles: string[];
  /** A safe, user-actionable explanation for a restore precondition failure. */
  error?: string;
}

export interface SnapshotRestoreAuthority {
  readonly schemaVersion: 1;
  readonly backupPath: string;
  readonly contentSha256: string;
}

export interface SnapshotRestoreOptions {
  /**
   * Content identity captured from the selected manifest and every backup
   * payload. The state layer revalidates it after local staging and before
   * the first remote filesystem mutation.
   */
  readonly authority?: SnapshotRestoreAuthority;
  /** Internal provider fence invoked at the same last-safe mutation edge. */
  readonly validateBeforeMutation?: () => void | Promise<void>;
}

export interface RecreatedSandboxRestoreOptions extends SnapshotRestoreOptions {
  /** Agent in the newly created target image, not the backup manifest agent. */
  targetAgentType: string;
  /** Exact OpenShell target frozen by the enclosing rebuild transaction. */
  runtimeSelection?: OpenShellRuntimeSelection;
}

interface InternalRestoreOptions {
  targetAgentType: string;
  runtimeSelection?: OpenShellRuntimeSelection;
  authority?: SnapshotRestoreAuthority;
  validateBeforeMutation?: () => void | Promise<void>;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStateFileSpec(value: unknown): value is StateFileSpec {
  return (
    isObjectRecord(value) &&
    typeof value.path === "string" &&
    (value.strategy === "copy" || value.strategy === "sqlite_backup") &&
    normalizeStateFileSpec({ path: value.path, strategy: value.strategy }) !== null
  );
}

function isInstanceBackup(value: unknown): value is InstanceBackup {
  if (!isObjectRecord(value) || !isStateDirArray(value.stateDirs)) return false;
  return (
    typeof value.instanceId === "string" &&
    typeof value.agentType === "string" &&
    typeof value.dataDir === "string" &&
    isBackedUpDirArray(value.backedUpDirs, value.stateDirs)
  );
}

function isHermesOperatorConfigInventoryKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

const REBUILD_MCP_ENTRY_KEYS = new Set([
  "adapter",
  "agent",
  "allowedIps",
  "denyTools",
  "env",
  "policyName",
  "providerId",
  "providerName",
  "server",
  "source",
  "trustedPrivateHost",
  "url",
]);
const REBUILD_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isRebuildMcpHandoffEntry(value: unknown): value is RebuildMcpHandoffEntry {
  if (
    !isObjectRecord(value) ||
    Object.keys(value).some((key) => !REBUILD_MCP_ENTRY_KEYS.has(key)) ||
    typeof value.server !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value.server) ||
    typeof value.agent !== "string" ||
    !REBUILD_MCP_NAME_PATTERN.test(value.agent) ||
    (value.adapter !== undefined &&
      value.adapter !== "openclaw-config" &&
      value.adapter !== "hermes-config" &&
      value.adapter !== "deepagents-config") ||
    typeof value.url !== "string" ||
    value.url.length > 4096 ||
    !Array.isArray(value.env) ||
    value.env.length > 1 ||
    !value.env.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) ||
    (value.denyTools !== undefined &&
      (() => {
        const inspection = inspectMcpDeniedToolSelectors(value.denyTools);
        return !inspection.ok || !inspection.canonical;
      })()) ||
    typeof value.policyName !== "string" ||
    !REBUILD_MCP_NAME_PATTERN.test(value.policyName) ||
    (value.trustedPrivateHost !== undefined &&
      (typeof value.trustedPrivateHost !== "string" ||
        value.trustedPrivateHost.length > 253 ||
        /[\r\n\0]/u.test(value.trustedPrivateHost))) ||
    (value.allowedIps !== undefined &&
      (!Array.isArray(value.allowedIps) ||
        value.allowedIps.length > 128 ||
        !value.allowedIps.every(
          (address) => typeof address === "string" && address.length > 0 && address.length <= 64,
        ))) ||
    (value.providerName !== undefined &&
      (typeof value.providerName !== "string" ||
        !REBUILD_MCP_NAME_PATTERN.test(value.providerName))) ||
    (value.providerId !== undefined &&
      (typeof value.providerId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value.providerId))) ||
    (value.source !== undefined &&
      value.source !== "native" &&
      value.source !== "legacy" &&
      value.source !== "legacy-registry" &&
      value.source !== "policy")
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isRebuildMcpRuntimeSelection(value: unknown): value is OpenShellRuntimeSelection {
  return (
    isObjectRecord(value) &&
    Object.keys(value).every(
      (key) => key === "gatewayName" || key === "workspace" || key === "localTlsDir",
    ) &&
    typeof value.gatewayName === "string" &&
    REBUILD_MCP_NAME_PATTERN.test(value.gatewayName) &&
    value.workspace === "default" &&
    (value.localTlsDir === undefined ||
      (typeof value.localTlsDir === "string" &&
        path.isAbsolute(value.localTlsDir) &&
        !/[\r\n\0]/u.test(value.localTlsDir)))
  );
}

function isRebuildMcpHandoff(
  value: unknown,
): value is NonNullable<RebuildManifest["rebuildMcpHandoff"]> {
  return (
    isObjectRecord(value) &&
    Object.keys(value).every(
      (key) => key === "entries" || key === "runtimeSelection" || key === "retired",
    ) &&
    Array.isArray(value.entries) &&
    value.entries.length <= 256 &&
    value.entries.every(isRebuildMcpHandoffEntry) &&
    new Set(value.entries.map((entry) => entry.server)).size === value.entries.length &&
    isRebuildMcpRuntimeSelection(value.runtimeSelection) &&
    (value.retired === undefined || value.retired === true)
  );
}

function isRebuildManifest(value: unknown): value is RebuildManifest {
  if (!isObjectRecord(value) || !isStateDirArray(value.stateDirs)) return false;
  const dir = typeof value.dir === "string" ? value.dir : value.writableDir;
  const runtimeSnapshot =
    value.runtimeSnapshot === undefined
      ? undefined
      : cloneSandboxRuntimeSnapshot(value.runtimeSnapshot);
  const workload =
    value.workload === undefined ? undefined : cloneSandboxWorkloadReceipt(value.workload as never);
  const hostLocalInferenceReceipt = registry.cloneSandboxHostLocalInferenceReceipt(
    value.hostLocalInferenceReceipt as string | null | undefined,
  );
  const hostLocalInferenceProvenance = registry.cloneSandboxHostLocalInferenceProvenance(
    value.hostLocalInferenceProvenance,
  );
  const validHostLocalInferenceProvenance = (() => {
    if (value.hostLocalInferenceProvenance === undefined) return true;
    if (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string")
      return false;
    try {
      registry.requireSandboxHostLocalInferenceProvenance(
        hostLocalInferenceProvenance,
        hostLocalInferenceReceipt,
      );
      return true;
    } catch {
      return false;
    }
  })();
  return (
    typeof value.version === "number" &&
    typeof value.sandboxName === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.agentType === "string" &&
    (value.agentVersion === null || typeof value.agentVersion === "string") &&
    (value.expectedVersion === null || typeof value.expectedVersion === "string") &&
    (value.backedUpDirs === undefined || isBackedUpDirArray(value.backedUpDirs, value.stateDirs)) &&
    (value.failedBackupDirs === undefined ||
      isBackedUpDirArray(value.failedBackupDirs, value.stateDirs)) &&
    (value.backupComplete === undefined || typeof value.backupComplete === "boolean") &&
    typeof dir === "string" &&
    typeof value.backupPath === "string" &&
    (value.stateFiles === undefined ||
      (Array.isArray(value.stateFiles) && value.stateFiles.every(isStateFileSpec))) &&
    (value.nativeState === undefined ||
      (isObjectRecord(value.nativeState) &&
        typeof value.nativeState.root === "string" &&
        path.posix.isAbsolute(value.nativeState.root) &&
        value.nativeState.root !== "/" &&
        value.nativeState.archive === NATIVE_STATE_ARCHIVE &&
        typeof value.nativeState.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.nativeState.sha256))) &&
    (value.version !== MANIFEST_VERSION || value.nativeState !== undefined) &&
    (value.blueprintDigest === undefined ||
      value.blueprintDigest === null ||
      typeof value.blueprintDigest === "string") &&
    (value.rebuildPolicyHandoff === undefined ||
      (isObjectRecord(value.rebuildPolicyHandoff) &&
        typeof value.rebuildPolicyHandoff.file === "string" &&
        typeof value.rebuildPolicyHandoff.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.rebuildPolicyHandoff.sha256) &&
        (value.rebuildPolicyHandoff.retired === undefined ||
          value.rebuildPolicyHandoff.retired === true) &&
        value.rebuildPolicyHandoff.file ===
          `rebuild-policy-handoff.${value.rebuildPolicyHandoff.sha256}.yaml`)) &&
    (value.rebuildMcpHandoff === undefined || isRebuildMcpHandoff(value.rebuildMcpHandoff)) &&
    (value.hermesOperatorConfigHandoff === undefined ||
      (value.agentType === "hermes" &&
        isObjectRecord(value.hermesOperatorConfigHandoff) &&
        typeof value.hermesOperatorConfigHandoff.file === "string" &&
        typeof value.hermesOperatorConfigHandoff.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.hermesOperatorConfigHandoff.sha256) &&
        (value.hermesOperatorConfigHandoff.keys === undefined ||
          (Array.isArray(value.hermesOperatorConfigHandoff.keys) &&
            value.hermesOperatorConfigHandoff.keys.length <= 4096 &&
            value.hermesOperatorConfigHandoff.keys.every(isHermesOperatorConfigInventoryKey))) &&
        (value.hermesOperatorConfigHandoff.retired === undefined ||
          value.hermesOperatorConfigHandoff.retired === true) &&
        value.hermesOperatorConfigHandoff.file ===
          `hermes-operator-config-handoff.${value.hermesOperatorConfigHandoff.sha256}.json`)) &&
    (value.preservedEnv === undefined ||
      (value.agentType === "hermes" &&
        validatePreservedEnvFiles(value.preservedEnv, HERMES_PRESERVED_ENV_INVENTORY))) &&
    (value.runtimeSnapshot === undefined || runtimeSnapshot !== undefined) &&
    (value.workload === undefined || workload !== undefined) &&
    (value.hostLocalInferenceReceipt === undefined ||
      (typeof hostLocalInferenceReceipt === "string" && hostLocalInferenceReceipt.length > 0)) &&
    validHostLocalInferenceProvenance &&
    (workload?.kind !== "managed-image" || runtimeSnapshot !== undefined) &&
    (value.instances === undefined ||
      (Array.isArray(value.instances) && value.instances.every((entry) => isInstanceBackup(entry))))
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
export function validateTarEntries(
  tarArchive: TarListingSource,
  targetDir: string,
): TarValidationResult {
  const entries: string[] = [];
  const listingFailure = runTarListing(tarArchive, ["-tf", "-"], "tar listing", (line) => {
    entries.push(line);
  });
  if (listingFailure) {
    return {
      safe: false,
      entries: [],
      violations: [listingFailure],
    };
  }

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

          // Allowed npm symlinks baked into managed or custom images. The
          // shared matcher checks both source shape and exact target so the
          // pre-backup and post-extraction audits enforce the same contract.
          // A recognized path with a tampered target falls through to the
          // normal containment check.
          const relFromDir = path.relative(dirPath, fullPath).split(path.sep).join("/");
          if (isAllowedStateSymlink(relFromDir, linkTarget)) {
            continue;
          }

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
export function rejectHardLinks(tarArchive: TarArchiveSource): string[] {
  const violations: string[] = [];
  const listingFailure = runTarListing(tarArchive, ["-tvf", "-"], "tar verbose listing", (line) => {
    // Both GNU tar and bsdtar prefix hard-link entries with 'h' in verbose mode
    // and include " link to " in the line.
    if (line.startsWith("h") || / link to /.test(line)) {
      violations.push(`hard link: ${line.trim()}`);
    }
  });
  if (listingFailure) return [listingFailure];

  return violations;
}

/**
 * SECURITY: Validate tar contents, extract with safety flags, then
 * audit for symlink escapes. Nukes the extraction on any violation.
 */
export function safeTarExtract(tarArchive: TarArchiveSource, targetDir: string): SafeExtractResult {
  // Phase 1a: Validate entry paths before extraction
  const validation = validateTarEntries(tarArchive, targetDir);
  if (!validation.safe) {
    return {
      success: false,
      error: `tar entry validation failed: ${validation.violations.join("; ")}`,
    };
  }

  // Phase 1b: Reject hard links (not detectable via tar -tf, require verbose listing)
  const hardLinkViolations = rejectHardLinks(tarArchive);
  if (hardLinkViolations.length > 0) {
    return {
      success: false,
      error: `hard link rejected: ${hardLinkViolations.join("; ")}`,
    };
  }

  // Phase 2: Extract with --no-same-owner to prevent ownership manipulation
  let archiveFd: number | null = null;
  let extractResult: ReturnType<typeof spawnSync>;
  try {
    extractResult = Buffer.isBuffer(tarArchive)
      ? spawnSync("tar", ["-xf", "-", "--no-same-owner", "-C", targetDir], {
          input: tarArchive,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60000,
        })
      : (() => {
          archiveFd = openSync(tarArchive.filePath, "r");
          return spawnSync("tar", ["-xf", "-", "--no-same-owner", "-C", targetDir], {
            stdio: [archiveFd, "pipe", "pipe"],
            timeout: 60000,
          });
        })();
  } finally {
    if (archiveFd !== null) closeSync(archiveFd);
  }

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

export function getSshConfig(
  sandboxName: string,
  runtimeOptions: {
    env?: NodeJS.ProcessEnv;
    gatewayName?: string;
    replaceEnv?: boolean;
  } = {},
): string | null {
  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const result = captureSandboxSshConfigCommand(openshellBinary, sandboxName, {
    ...runtimeOptions,
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return result.output;
}

function selectedSshConfigOptions(
  runtimeSelection?: OpenShellRuntimeSelection,
): Parameters<typeof getSshConfig>[1] {
  return runtimeSelection
    ? {
        env: buildSelectedOpenShellSubprocessEnv(runtimeSelection),
        gatewayName: runtimeSelection.gatewayName,
        replaceEnv: true,
      }
    : undefined;
}

export function sshArgs(configFile: string, sandboxName: string): string[] {
  const sshHost = resolveOpenshellSandboxSshHost(sandboxName, readFileSync(configFile, "utf8"));
  if (sshHost === null) {
    throw new Error(
      `OpenShell SSH config does not declare an exact host alias for sandbox '${sandboxName}'`,
    );
  }
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
    sshHost,
  ];
}

function computeBlueprintDigest(): string | null {
  // Look for blueprint.yaml relative to the agent-defs ROOT
  const candidates = [
    path.join(
      nemoclawStateRoot(process.env.HOME || "/tmp", GATEWAY_PORT),
      "blueprints",
      "0.1.0",
      "blueprint.yaml",
    ),
    path.join(__dirname, "..", "..", "nemoclaw-blueprint", "blueprint.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return null;
}

// ── Logging ────────────────────────────────────────────────────────

const _verbose = () => process.env.NEMOCLAW_REBUILD_VERBOSE === "1";

function _log(msg: string): void {
  if (_verbose()) console.error(`  [sandbox-state ${new Date().toISOString()}] ${msg}`);
}

function normalizeStateFilePath(filePath: string): string | null {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return null;
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

function isSafeStateDirPath(dirPath: string): boolean {
  if (!dirPath || dirPath.includes("\0") || path.isAbsolute(dirPath)) return false;
  const normalized = path.posix.normalize(dirPath.replace(/\\/g, "/"));
  return (
    normalized === dirPath &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function isStateDirArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every(isSafeStateDirPath);
}

function isBackedUpDirArray(value: unknown, stateDirs: string[]): value is string[] {
  const stateDirSet = new Set(stateDirs);
  return (
    isStringArray(value) &&
    value.every((dirName) => isSafeStateDirPath(dirName) && stateDirSet.has(dirName))
  );
}

function normalizeStateFileSpec(spec: AgentStateFile | StateFileSpec): StateFileSpec | null {
  const normalized = normalizeStateFilePath(spec.path);
  if (!normalized) return null;
  if (spec.strategy !== "copy" && spec.strategy !== "sqlite_backup") return null;
  return { path: normalized, strategy: spec.strategy };
}

function normalizeStateFileSpecsPreservingDuplicates(
  specs: readonly (AgentStateFile | StateFileSpec)[],
): StateFileSpec[] {
  return specs.flatMap((spec) => {
    const normalized = normalizeStateFileSpec(spec);
    return normalized ? [normalized] : [];
  });
}

/** Check privileged snapshot requests against the owning agent manifest. */
export function isDeclaredAgentStateFile(
  agentName: string,
  dir: string,
  spec: StateFileSpec,
): boolean {
  const agent = loadAgent(agentName);
  return (
    dir === agent.configPaths.dir &&
    ((agentName === "hermes" && spec.path === ".env" && spec.strategy === "copy") ||
      agent.stateFiles.some(
        (entry) => entry.path === spec.path && entry.strategy === spec.strategy,
      ))
  );
}

/** Check privileged directory requests against the owning agent manifest. */
export function areDeclaredAgentStateDirectories(
  agentName: string,
  dir: string,
  names: readonly string[],
): boolean {
  if (names.length === 0) return false;
  const agent = loadAgent(agentName);
  const allowed = new Set(agent.backupStateDirs);
  return (
    dir === agent.configPaths.dir &&
    names.every((name) => allowed.has(name) && /^[A-Za-z0-9._-]+$/.test(name))
  );
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

export function buildStateFileBackupCommand(dir: string, spec: StateFileSpec): string {
  const remotePath = stateFileRemotePath(dir, spec.path);
  const quotedRemotePath = shellQuote(remotePath);
  if (spec.strategy === "sqlite_backup") {
    return [
      `src=${quotedRemotePath}`,
      '[ ! -e "$src" ] && exit 2',
      '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe sqlite state file: $src" >&2; exit 10; }',
      '[ -r "$src" ] || { echo "permission denied: $src" >&2; exit 1; }',
      'hardlink_count="$(find "$src" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
      '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked sqlite state file rejected: $src" >&2; exit 11; }',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-backup.XXXXXX)"',
      "trap 'rm -f \"$tmp\"' EXIT",
      `/usr/bin/python3 -I -S -c ${shellQuote(SQLITE_BACKUP_PY)} "$src" "$tmp" && cat -- "$tmp"`,
    ].join("; ");
  }

  return [
    `src=${quotedRemotePath}`,
    '[ ! -e "$src" ] && exit 2',
    '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe state file: $src" >&2; exit 10; }',
    'hardlink_count="$(find "$src" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
    '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked state file rejected: $src" >&2; exit 11; }',
    'cat -- "$src"',
  ].join("; ");
}

type StateFileBackupOutcome = "backed_up" | "missing" | "failed";

function capturePreservedEnvFile(
  configFile: string,
  sandboxName: string,
  dir: string,
  inventory: PreservedEnvInventory,
  captureFallback?: StateFileCapture,
): {
  outcome: StateFileBackupOutcome;
  file?: PreservedEnvFile;
  unreachable: boolean;
} {
  const command = buildStateFileBackupCommand(dir, {
    path: inventory.path,
    strategy: "copy",
  });
  _log(`Capturing preserved environment assignments from ${inventory.path}`);
  const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), command], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 2) return { outcome: "missing", unreachable: false };
  let captured: StateFileCaptureResult | null = null;
  if (
    result.status === 1 &&
    !result.error &&
    !result.signal &&
    /permission denied/i.test(result.stderr?.toString() ?? "") &&
    captureFallback !== undefined
  ) {
    try {
      captured = captureFallback({
        sandboxName,
        dir,
        spec: { path: inventory.path, strategy: "copy" },
      });
    } catch (error) {
      captured = {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (captured?.outcome === "missing") return { outcome: "missing", unreachable: false };
  const data = captured?.outcome === "backed_up" ? captured.data : null;
  if ((result.status !== 0 || result.error || result.signal || !result.stdout) && data === null) {
    const detail =
      (captured?.outcome === "failed" ? captured.error : undefined) ||
      (result.stderr?.toString() || "").trim() ||
      result.error?.message ||
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    _log(`FAILED: preserved environment capture ${inventory.path}: ${detail.substring(0, 200)}`);
    return {
      outcome: "failed",
      unreachable:
        (captured?.outcome === "failed" && captured.unreachable === true) ||
        isSshTransportFailure(result),
    };
  }
  try {
    const assignments = extractPreservedEnvAssignments(
      (data ?? result.stdout).toString("utf8"),
      inventory,
    );
    _log(
      `Captured ${assignments.length} preserved environment ${assignments.length === 1 ? "key" : "keys"} from ${inventory.path}`,
    );
    return {
      outcome: "backed_up",
      file: { path: inventory.path, assignments },
      unreachable: false,
    };
  } catch (error) {
    _log(
      `FAILED: preserved environment capture ${inventory.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { outcome: "failed", unreachable: false };
  }
}

function capturePreservedEnvFiles(
  configFile: string,
  sandboxName: string,
  dir: string,
  inventories: readonly PreservedEnvInventory[],
  captureFallback?: StateFileCapture,
): { files: PreservedEnvFile[]; failedPaths: string[]; unreachable: boolean } {
  const files: PreservedEnvFile[] = [];
  const failedPaths: string[] = [];
  let unreachable = false;
  for (const inventory of inventories) {
    const result = capturePreservedEnvFile(
      configFile,
      sandboxName,
      dir,
      inventory,
      captureFallback,
    );
    if (result.outcome === "backed_up" && result.file) {
      files.push(result.file);
    } else if (result.outcome === "failed") {
      failedPaths.push(inventory.path);
      if (result.unreachable) unreachable = true;
    }
  }
  return { files, failedPaths, unreachable };
}

function captureAgentPreservedEnvFiles(
  agentName: string,
  configFile: string,
  sandboxName: string,
  dir: string,
  manifest: RebuildManifest,
  failedFiles: string[],
  captureFallback?: StateFileCapture,
): boolean {
  if (agentName !== "hermes") return false;
  const preserved = capturePreservedEnvFiles(
    configFile,
    sandboxName,
    dir,
    HERMES_PRESERVED_ENV_INVENTORY,
    captureFallback,
  );
  manifest.preservedEnv = preserved.files;
  failedFiles.push(...preserved.failedPaths);
  return preserved.unreachable;
}

function normalizeSnapshotBackupAuthority(options: BackupOptions): {
  readonly runtimeSnapshot?: SandboxRuntimeSnapshot;
  readonly workload?: SandboxWorkloadReceipt;
  readonly hostLocalInferenceReceipt?: string;
  readonly hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  readonly error?: string;
} {
  const runtimeSnapshot =
    options.runtimeSnapshot === undefined
      ? undefined
      : cloneSandboxRuntimeSnapshot(options.runtimeSnapshot);
  const workload =
    options.workload === undefined ? undefined : cloneSandboxWorkloadReceipt(options.workload);
  const hostLocalInferenceReceipt = registry.cloneSandboxHostLocalInferenceReceipt(
    options.hostLocalInferenceReceipt,
  );
  const hostLocalInferenceProvenance = registry.cloneSandboxHostLocalInferenceProvenance(
    options.hostLocalInferenceProvenance,
  );
  if (options.runtimeSnapshot !== undefined && runtimeSnapshot === undefined) {
    return {
      error: "snapshot runtime state is invalid or cannot be represented",
    };
  }
  if (options.workload !== undefined && workload === undefined) {
    return { error: "snapshot workload authority is invalid" };
  }
  if (
    options.hostLocalInferenceReceipt !== undefined &&
    typeof hostLocalInferenceReceipt !== "string"
  ) {
    return { error: "snapshot host-local inference authority is invalid" };
  }
  if (options.hostLocalInferenceProvenance !== undefined) {
    if (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string") {
      return { error: "snapshot host-local inference provenance is invalid" };
    }
    try {
      registry.requireSandboxHostLocalInferenceProvenance(
        hostLocalInferenceProvenance,
        hostLocalInferenceReceipt,
      );
    } catch {
      return { error: "snapshot host-local inference provenance is invalid" };
    }
  }
  if (workload?.kind === "managed-image" && runtimeSnapshot === undefined) {
    return { error: "managed snapshot is missing provider runtime state" };
  }
  return {
    ...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
    ...(workload === undefined ? {} : { workload }),
    ...(typeof hostLocalInferenceReceipt === "string" ? { hostLocalInferenceReceipt } : {}),
    ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
  };
}

function validateSnapshotPublication(
  backupPath: string,
  validateBeforePublish: BackupOptions["validateBeforePublish"],
): string | null {
  if (!validateBeforePublish) return null;
  try {
    validateBeforePublish();
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      rmSync(backupPath, { recursive: true, force: true });
      return `Snapshot authority changed during backup: ${detail}`;
    } catch (cleanupError) {
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return (
        `Snapshot authority changed during backup: ${detail}. ` +
        `The unpublished backup at '${backupPath}' could not be removed: ${cleanupDetail}`
      );
    }
  }
}
function nativeStateFailure(error: string, unreachable = false): BackupResult {
  return {
    success: false,
    backedUpDirs: [],
    failedDirs: ["."],
    backedUpFiles: [],
    failedFiles: [],
    error,
    ...(unreachable ? { unreachable: true } : {}),
  };
}

function resolveNativeStateRoot(
  configFile: string,
  sandboxName: string,
  selectedEnv?: NodeJS.ProcessEnv,
): { root: string } | { error: string; unreachable: boolean } {
  const probe = spawnSync(
    "ssh",
    [
      ...sshArgs(configFile, sandboxName),
      `set -eu; work=$(pwd -P); cd -- "$HOME"; home=$(pwd -P); printf '%s\\0%s\\0' "$home" "$work"`,
    ],
    {
      ...(selectedEnv ? { env: selectedEnv } : {}),
      encoding: null,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (probe.status !== 0 || probe.error || probe.signal || !Buffer.isBuffer(probe.stdout)) {
    const detail =
      probe.error?.message ??
      (probe.signal
        ? `signal ${probe.signal}`
        : probe.stderr?.toString().trim() || `exit ${String(probe.status)}`);
    return {
      error: `Could not resolve the OpenShell native home/workspace: ${detail}`,
      unreachable: isSshTransportFailure(probe),
    };
  }
  const fields = probe.stdout.toString("utf8").split("\0");
  if (fields.length !== 3 || fields[2] !== "") {
    return {
      error: "OpenShell returned a malformed native home/workspace identity",
      unreachable: false,
    };
  }
  const [home, workspace] = fields;
  const valid = (value: string): boolean =>
    path.posix.isAbsolute(value) &&
    value === path.posix.normalize(value) &&
    value !== "/" &&
    !/[\0-\x1f\x7f]/u.test(value) &&
    value !== "/.openshell" &&
    !value.startsWith("/.openshell/");
  if (!valid(home) || !valid(workspace)) {
    return {
      error:
        "OpenShell native home/workspace must be canonical absolute paths outside '/.openshell'",
      unreachable: false,
    };
  }
  if (workspace === home || workspace.startsWith(`${home}/`)) return { root: home };
  if (home.startsWith(`${workspace}/`)) return { root: workspace };
  return {
    error: `OpenShell native home '${home}' and workspace '${workspace}' do not share a safe persistence root`,
    unreachable: false,
  };
}

function sha256File(filePath: string): string {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return sha256Descriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sha256Descriptor(descriptor: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

type OpenedNativeArchive = { descriptor: number } | { error: string };

function openValidatedNativeArchive(
  archivePath: string,
  expectedSha256: string,
  nativeRoot: string,
): OpenedNativeArchive {
  let listingDescriptor: number | null = null;
  let restoreDescriptor: number | null = null;
  const identityError = "Native home/workspace archive identity does not match its manifest";
  try {
    listingDescriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    restoreDescriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const listingIdentity = fstatSync(listingDescriptor);
    const restoreIdentity = fstatSync(restoreDescriptor);
    if (
      !listingIdentity.isFile() ||
      !restoreIdentity.isFile() ||
      listingIdentity.dev !== restoreIdentity.dev ||
      listingIdentity.ino !== restoreIdentity.ino ||
      listingIdentity.size !== restoreIdentity.size ||
      sha256Descriptor(restoreDescriptor) !== expectedSha256
    ) {
      return { error: identityError };
    }
    const validation = validateTarEntries({ fileDescriptor: listingDescriptor }, nativeRoot);
    const finalIdentity = fstatSync(restoreDescriptor);
    if (
      finalIdentity.dev !== restoreIdentity.dev ||
      finalIdentity.ino !== restoreIdentity.ino ||
      finalIdentity.size !== restoreIdentity.size ||
      finalIdentity.mtimeMs !== restoreIdentity.mtimeMs ||
      finalIdentity.ctimeMs !== restoreIdentity.ctimeMs
    ) {
      return { error: identityError };
    }
    if (!validation.safe) {
      return {
        error: `Native home/workspace archive is unsafe: ${validation.violations.join("; ")}`,
      };
    }
    const descriptor = restoreDescriptor;
    restoreDescriptor = null;
    return { descriptor };
  } catch {
    return { error: "Native home/workspace archive is missing or unreadable" };
  } finally {
    if (listingDescriptor !== null) closeSync(listingDescriptor);
    if (restoreDescriptor !== null) closeSync(restoreDescriptor);
  }
}

/** Capture one opaque archive of the OpenShell-owned native home/workspace. */
function backupNativeSandboxState(sandboxName: string, options: BackupOptions): BackupResult {
  const sandbox = registry.getSandbox(sandboxName);
  const agentName = sandbox?.agent || "openclaw";
  const agent = loadAgent(agentName);
  const authority = normalizeSnapshotBackupAuthority(options);
  if (authority.error) return nativeStateFailure(authority.error);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(REBUILD_BACKUPS_DIR, sandboxName, timestamp);
  if (existsSync(backupPath))
    return nativeStateFailure(`Snapshot path '${backupPath}' already exists; retry the backup.`);
  rejectSymlinksOnPath(backupPath);
  mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  rejectSymlinksOnPath(backupPath);

  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    rmSync(backupPath, { recursive: true, force: true });
    return nativeStateFailure("Could not get SSH configuration for native state capture", true);
  }
  const temporary = createTempSshConfig(sshConfig, "nemoclaw-native-state-");
  const failedFiles: string[] = [];
  try {
    const rootResult = resolveNativeStateRoot(temporary.file, sandboxName);
    if ("error" in rootResult) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(rootResult.error, rootResult.unreachable);
    }
    const archivePath = path.join(backupPath, NATIVE_STATE_ARCHIVE);
    const archiveFd = openSync(
      archivePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let result: ReturnType<typeof spawnSync>;
    try {
      const command = `set -eu; root=${shellQuote(rootResult.root)}; [ -d "$root" ] && [ ! -L "$root" ]; exec tar -C "$root" -cf - -- .`;
      result = spawnSync("ssh", [...sshArgs(temporary.file, sandboxName), command], {
        stdio: ["ignore", archiveFd, "pipe"],
        timeout: NATIVE_STATE_CAPTURE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } finally {
      closeSync(archiveFd);
    }
    if (result.status !== 0 || result.error || result.signal || statSync(archivePath).size === 0) {
      const detail =
        result.error?.message ??
        (result.signal
          ? `signal ${result.signal}`
          : result.stderr?.toString().trim() || `exit ${String(result.status)}`);
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native home/workspace capture failed: ${detail.substring(0, 240)}`,
        isSshTransportFailure(result),
      );
    }
    const validation = validateTarEntries({ filePath: archivePath }, rootResult.root);
    if (!validation.safe) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native state archive validation failed: ${validation.violations.join("; ")}`,
      );
    }

    const manifest: RebuildManifest = {
      version: MANIFEST_VERSION,
      sandboxName,
      timestamp,
      agentType: agentName,
      agentVersion: sandbox?.agentVersion || null,
      expectedVersion: agent.expectedVersion,
      stateDirs: [],
      backedUpDirs: [],
      failedBackupDirs: [],
      backupComplete: true,
      stateFiles: [],
      nativeState: {
        root: rootResult.root,
        archive: NATIVE_STATE_ARCHIVE,
        sha256: sha256File(archivePath),
      },
      dir: rootResult.root,
      backupPath,
      blueprintDigest: computeBlueprintDigest(),
      ...(agentName === "hermes" ? { preservedEnv: [] } : {}),
      ...authority,
    };
    captureAgentPreservedEnvFiles(
      agentName,
      temporary.file,
      sandboxName,
      agent.configPaths.dir,
      manifest,
      failedFiles,
      options.captureStateFile,
    );
    if (failedFiles.length > 0) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Failed to capture rebuild environment metadata: ${failedFiles.join(", ")}`,
      );
    }
    const publicationError = validateSnapshotPublication(backupPath, options.validateBeforePublish);
    if (publicationError) return nativeStateFailure(publicationError);
    writeManifest(backupPath, manifest);
    return {
      success: true,
      manifest,
      backedUpDirs: ["."],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
    };
  } finally {
    try {
      temporary.cleanup();
    } catch {
      /* ignore */
    }
  }
}

export function backupSandboxState(sandboxName: string, options: BackupOptions = {}): BackupResult {
  return backupNativeSandboxState(sandboxName, options);
}
// ── Restore ────────────────────────────────────────────────────────

function snapshotManifestAuthority(manifest: RebuildManifest): RebuildManifest {
  return {
    ...manifest,
    backupPath: path.resolve(manifest.backupPath),
  };
}

function hashSnapshotTree(backupPath: string): string {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("snapshot hashing requires O_NOFOLLOW support");
  }
  const openFlags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
  const hash = createHash("sha256");
  const visit = (directory: string, relativeDirectory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(
        relativeDirectory.split(path.sep).join(path.posix.sep),
        entry.name,
      );
      if (entry.isDirectory()) {
        hash.update(JSON.stringify(["directory", relativePath]), "utf8");
        visit(fullPath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        hash.update(JSON.stringify(["symlink", relativePath, readlinkSync(fullPath)]), "utf8");
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`snapshot contains unsupported entry '${relativePath}'`);
      }
      const descriptor = openSync(fullPath, openFlags);
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile()) {
          throw new Error(`snapshot entry '${relativePath}' changed while it was opened`);
        }
        hash.update(JSON.stringify(["file", relativePath, opened.size]), "utf8");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = fstatSync(descriptor);
        const pathAfter = lstatSync(fullPath);
        if (
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          pathAfter.isSymbolicLink() ||
          !pathAfter.isFile() ||
          pathAfter.dev !== opened.dev ||
          pathAfter.ino !== opened.ino ||
          pathAfter.size !== opened.size ||
          pathAfter.mtimeMs !== opened.mtimeMs
        ) {
          throw new Error(`snapshot entry '${relativePath}' changed while it was read`);
        }
      } finally {
        closeSync(descriptor);
      }
    }
  };
  visit(backupPath, "");
  return hash.digest("hex");
}

/**
 * Bind a selected, validated manifest to all bytes that restore can consume.
 * Returns null for an unsafe path, malformed manifest, selection drift, or a
 * payload that changes while it is being hashed.
 */
export function captureSnapshotRestoreAuthority(
  backupPath: string,
  expectedManifest?: RebuildManifest,
): SnapshotRestoreAuthority | null {
  try {
    const root = path.resolve(REBUILD_BACKUPS_DIR);
    const candidate = path.resolve(backupPath);
    if (candidate === root || !isWithinRoot(candidate, root)) return null;
    rejectSymlinksOnPath(candidate);
    if (!lstatSync(path.join(candidate, "rebuild-manifest.json")).isFile()) return null;
    const manifest = readManifest(candidate);
    if (!manifest || path.resolve(manifest.backupPath) !== candidate) return null;
    if (
      expectedManifest &&
      !isDeepStrictEqual(
        snapshotManifestAuthority(manifest),
        snapshotManifestAuthority(expectedManifest),
      )
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      backupPath: candidate,
      contentSha256: hashSnapshotTree(candidate),
    };
  } catch {
    return null;
  }
}

export async function validateSnapshotRestoreMutation(
  backupPath: string,
  options: Pick<SnapshotRestoreOptions, "authority" | "validateBeforeMutation">,
): Promise<string | null> {
  const validateContent = (): string | null => {
    if (options.authority) {
      const current = captureSnapshotRestoreAuthority(backupPath);
      if (
        !current ||
        current.backupPath !== options.authority.backupPath ||
        current.contentSha256 !== options.authority.contentSha256
      ) {
        return "Selected snapshot content changed before filesystem mutation";
      }
    }
    return null;
  };
  const contentError = validateContent();
  if (contentError) return contentError;
  try {
    await options.validateBeforeMutation?.();
    return validateContent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Runtime authority changed before filesystem mutation: ${detail}`;
  }
}

/**
 * Restore state directories into a sandbox from a prior backup.
 */
export async function restoreSandboxState(
  sandboxName: string,
  backupPath: string,
  options: SnapshotRestoreOptions = {},
): Promise<RestoreResult> {
  const target = registry.getSandbox(sandboxName);
  if (!target) {
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
      error: `Could not resolve target sandbox '${sandboxName}' for state restore`,
    };
  }
  return restoreSandboxStateInternal(sandboxName, backupPath, {
    targetAgentType: String(target.agent || "openclaw"),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.validateBeforeMutation
      ? { validateBeforeMutation: options.validateBeforeMutation }
      : {}),
  });
}

export async function restoreRecreatedSandboxState(
  sandboxName: string,
  backupPath: string,
  options: RecreatedSandboxRestoreOptions,
): Promise<RestoreResult> {
  return restoreSandboxStateInternal(sandboxName, backupPath, {
    targetAgentType: options.targetAgentType,
    ...(options.runtimeSelection ? { runtimeSelection: options.runtimeSelection } : {}),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.validateBeforeMutation
      ? { validateBeforeMutation: options.validateBeforeMutation }
      : {}),
  });
}

async function restoreNativeSandboxState(
  sandboxName: string,
  backupPath: string,
  options: InternalRestoreOptions,
): Promise<RestoreResult> {
  const failure = (error: string): RestoreResult => ({
    success: false,
    restoredDirs: [],
    failedDirs: ["."],
    restoredFiles: [],
    failedFiles: [],
    error,
  });
  const manifest = readManifest(backupPath);
  if (!manifest?.nativeState || manifest.version !== MANIFEST_VERSION) {
    return failure("Backup does not contain a supported complete native home/workspace archive");
  }
  if (manifest.agentType !== options.targetAgentType) {
    return failure(
      `Backup agent '${manifest.agentType}' does not match target agent '${options.targetAgentType}'`,
    );
  }
  if (!options.authority || !options.validateBeforeMutation) {
    if (manifest.workload?.kind === "managed-image") {
      return failure(MANAGED_REBUILD_RESTORE_AUTHORITY_ERROR);
    }
    if (typeof manifest.hostLocalInferenceReceipt === "string") {
      return failure(HOST_LOCAL_INFERENCE_REBUILD_RESTORE_AUTHORITY_ERROR);
    }
  }
  const archivePath = path.join(backupPath, manifest.nativeState.archive);
  const openedArchive = openValidatedNativeArchive(
    archivePath,
    manifest.nativeState.sha256,
    manifest.nativeState.root,
  );
  if ("error" in openedArchive) return failure(openedArchive.error);
  const archiveFd = openedArchive.descriptor;

  try {
    const selectedEnv = options.runtimeSelection
      ? buildSelectedOpenShellSubprocessEnv(options.runtimeSelection)
      : undefined;
    const sshConfig = getSshConfig(sandboxName, selectedSshConfigOptions(options.runtimeSelection));
    if (!sshConfig) return failure(`Could not get SSH configuration for target '${sandboxName}'`);
    const temporary = createTempSshConfig(sshConfig, "nemoclaw-native-restore-");
    try {
      const rootResult = resolveNativeStateRoot(temporary.file, sandboxName, selectedEnv);
      if ("error" in rootResult) return failure(rootResult.error);
      if (rootResult.root !== manifest.nativeState.root) {
        return failure(
          `Backup native root '${manifest.nativeState.root}' does not match target root '${rootResult.root}'`,
        );
      }
      const mutationError = await validateSnapshotRestoreMutation(backupPath, options);
      if (mutationError) return failure(mutationError);

      const root = shellQuote(rootResult.root);
      const command = [
        "set -eu",
        `root=${root}`,
        '[ -d "$root" ] && [ ! -L "$root" ]',
        'find "$root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        'exec tar --no-same-owner -xf - -C "$root"',
      ].join("; ");
      const result = spawnSync("ssh", [...sshArgs(temporary.file, sandboxName), command], {
        ...(selectedEnv ? { env: selectedEnv } : {}),
        stdio: [archiveFd, "pipe", "pipe"],
        timeout: NATIVE_STATE_CAPTURE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error || result.signal) {
        const detail =
          result.error?.message ??
          (result.signal
            ? `signal ${result.signal}`
            : result.stderr?.toString().trim() || `exit ${String(result.status)}`);
        return failure(`Native home/workspace restore failed: ${detail.substring(0, 240)}`);
      }
      return {
        success: true,
        restoredDirs: ["."],
        failedDirs: [],
        restoredFiles: [],
        failedFiles: [],
      };
    } finally {
      try {
        temporary.cleanup();
      } catch {
        /* ignore */
      }
    }
  } finally {
    closeSync(archiveFd);
  }
}

async function restoreSandboxStateInternal(
  sandboxName: string,
  backupPath: string,
  options: InternalRestoreOptions,
): Promise<RestoreResult> {
  _log(`restoreSandboxState: sandbox=${sandboxName}, backupPath=${backupPath}`);
  return restoreNativeSandboxState(sandboxName, backupPath, options);
}
// ── Manifest ───────────────────────────────────────────────────────

type ManifestPublishOps = {
  write(filePath: string, contents: string, options: { mode: number; flag: "wx" }): void;
  rename(source: string, destination: string): void;
  remove(filePath: string, options: { force: true }): void;
};

const manifestPublishOps: ManifestPublishOps = {
  write: (filePath, contents, options) => writeFileSync(filePath, contents, options),
  rename: (source, destination) => renameSync(source, destination),
  remove: (filePath, options) => rmSync(filePath, options),
};

function writeManifest(
  backupPath: string,
  manifest: RebuildManifest,
  ops: ManifestPublishOps = manifestPublishOps,
): void {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  const tempPath = path.join(backupPath, `.rebuild-manifest.json.tmp.${String(process.pid)}`);
  let published = false;
  try {
    // A snapshot becomes recoverable only after its complete, private manifest
    // is atomically renamed into place.
    ops.write(tempPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    ops.rename(tempPath, manifestPath);
    published = true;
  } finally {
    if (!published) {
      try {
        ops.remove(tempPath, { force: true });
      } catch {
        // Preserve the publish failure; a same-directory temp file is never a snapshot.
      }
    }
  }
}

export const __test = { writeManifest, readManifest };

function readBoundRebuildHandoff(filePath: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (uid !== undefined && before.uid !== BigInt(uid)) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size > 8n * 1024n * 1024n
    ) {
      return null;
    }
    const content = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      return null;
    }
    return content;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Publish or replace the transaction-bound policy handoff beside its rebuild backup. */
export function writeRebuildPolicyHandoff(
  manifest: RebuildManifest,
  policyDocument: string,
): RebuildManifest {
  if (!policyDocument.trim()) throw new Error("Cannot persist an empty rebuild policy handoff");
  if (!isOpenShellSandboxPolicyCredentialFree(policyDocument)) {
    throw new Error("Cannot persist a credential-bearing rebuild policy handoff");
  }
  const sha256 = createHash("sha256").update(policyDocument).digest("hex");
  const file = `rebuild-policy-handoff.${sha256}.yaml`;
  const filePath = path.join(manifest.backupPath, file);
  let created = false;
  let published = false;
  try {
    try {
      writeFileSync(filePath, policyDocument, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readBoundRebuildHandoff(filePath);
      if (existing !== policyDocument) {
        throw new Error("Existing rebuild policy handoff does not match its content identity");
      }
    }
    const next = {
      ...manifest,
      rebuildPolicyHandoff: { file, sha256 },
    };
    writeManifest(manifest.backupPath, next);
    const previousFile = manifest.rebuildPolicyHandoff?.file;
    Object.assign(manifest, next);
    published = true;
    if (previousFile && previousFile !== file) {
      rmSync(path.join(manifest.backupPath, previousFile), { force: true });
    }
    return next;
  } catch (error) {
    // Roll back only a file that never became authoritative. Once the manifest
    // is published, removing the new file would strand recovery on a dangling
    // content identity if cleanup of the superseded handoff fails.
    if (created && !published) rmSync(filePath, { force: true });
    throw error;
  }
}

/** Read a transaction-bound policy only when its exact published digest still matches. */
export function readRebuildPolicyHandoff(manifest: RebuildManifest): string | null {
  const handoff = manifest.rebuildPolicyHandoff;
  if (!handoff || handoff.retired === true) return null;
  const content = readBoundRebuildHandoff(path.join(manifest.backupPath, handoff.file));
  if (content === null) return null;
  return createHash("sha256").update(content).digest("hex") === handoff.sha256 ? content : null;
}

function cloneRebuildMcpHandoff(
  handoff: NonNullable<RebuildManifest["rebuildMcpHandoff"]>,
): NonNullable<RebuildManifest["rebuildMcpHandoff"]> {
  return {
    entries: handoff.entries.map((entry) => ({
      ...entry,
      env: [...entry.env],
      ...(entry.denyTools ? { denyTools: [...entry.denyTools] } : {}),
      ...(entry.allowedIps ? { allowedIps: [...entry.allowedIps] } : {}),
    })),
    runtimeSelection: { ...handoff.runtimeSelection },
    ...(handoff.retired === true ? { retired: true as const } : {}),
  };
}

/** Publish source-derived MCP state only for a bounded rebuild recovery transaction. */
export function writeRebuildMcpHandoff(
  manifest: RebuildManifest,
  entries: readonly RebuildMcpHandoffEntry[],
  runtimeSelection: OpenShellRuntimeSelection,
): RebuildManifest {
  const handoff = { entries: [...entries], runtimeSelection };
  if (!isRebuildMcpHandoff(handoff)) {
    throw new Error("Cannot persist an invalid rebuild MCP recovery handoff");
  }
  const next = { ...manifest, rebuildMcpHandoff: cloneRebuildMcpHandoff(handoff) };
  writeManifest(manifest.backupPath, next);
  Object.assign(manifest, next);
  return next;
}

/** Read source-derived MCP recovery state only while its rebuild transaction is active. */
export function readRebuildMcpHandoff(
  manifest: RebuildManifest,
): NonNullable<RebuildManifest["rebuildMcpHandoff"]> | null {
  const handoff = manifest.rebuildMcpHandoff;
  return handoff && handoff.retired !== true && isRebuildMcpHandoff(handoff)
    ? cloneRebuildMcpHandoff(handoff)
    : null;
}

/** Retire and remove the bounded MCP recovery handoff from a completed rebuild. */
export function clearRebuildMcpHandoff(
  manifest: RebuildManifest,
  options: { retainRetirement?: boolean } = {},
): boolean {
  const handoff = manifest.rebuildMcpHandoff;
  if (!handoff) return true;
  if (handoff.retired !== true) {
    const retired = {
      ...manifest,
      rebuildMcpHandoff: { ...cloneRebuildMcpHandoff(handoff), retired: true as const },
    };
    try {
      writeManifest(manifest.backupPath, retired);
    } catch {
      return false;
    }
    Object.assign(manifest, retired);
  }
  if (options.retainRetirement === true) return true;
  const cleared = { ...manifest };
  delete cleared.rebuildMcpHandoff;
  try {
    writeManifest(manifest.backupPath, cleared);
  } catch {
    return false;
  }
  delete manifest.rebuildMcpHandoff;
  return true;
}

/** Retire recovery authority, retain cleanup identity, then delete the handoff artifact. */
export function clearRebuildPolicyHandoff(
  manifest: RebuildManifest,
  ops: {
    write?: typeof writeManifest;
    remove?: typeof rmSync;
    retainRetirement?: boolean;
  } = {},
): boolean {
  const handoff = manifest.rebuildPolicyHandoff;
  if (!handoff) return true;
  const write = ops.write ?? writeManifest;
  const remove = ops.remove ?? rmSync;
  if (handoff.retired !== true) {
    const retired = {
      ...manifest,
      rebuildPolicyHandoff: { ...handoff, retired: true as const },
    };
    try {
      write(manifest.backupPath, retired);
    } catch {
      return false;
    }
    Object.assign(manifest, retired);
  }
  try {
    remove(path.join(manifest.backupPath, handoff.file), { force: true });
  } catch {
    return false;
  }
  if (ops.retainRetirement === true) return true;
  const cleared = { ...manifest };
  delete cleared.rebuildPolicyHandoff;
  try {
    write(manifest.backupPath, cleared);
  } catch {
    return false;
  }
  delete manifest.rebuildPolicyHandoff;
  return true;
}

/** Retire recovery authority, then delete the Hermes operator config handoff. */
export function clearHermesOperatorConfigHandoff(
  manifest: RebuildManifest,
  ops: {
    write?: typeof writeManifest;
    remove?: typeof rmSync;
  } = {},
): boolean {
  const handoff = manifest.hermesOperatorConfigHandoff;
  if (!handoff) return true;
  const write = ops.write ?? writeManifest;
  const remove = ops.remove ?? rmSync;
  if (handoff.retired !== true) {
    const retired = {
      ...manifest,
      hermesOperatorConfigHandoff: { ...handoff, retired: true as const },
    };
    try {
      write(manifest.backupPath, retired);
    } catch {
      return false;
    }
    Object.assign(manifest, retired);
  }
  try {
    remove(path.join(manifest.backupPath, handoff.file), { force: true });
  } catch {
    return false;
  }
  const cleared = { ...manifest };
  delete cleared.hermesOperatorConfigHandoff;
  try {
    write(manifest.backupPath, cleared);
  } catch {
    return false;
  }
  delete manifest.hermesOperatorConfigHandoff;
  return true;
}

function readManifestPayload(backupPath: string): unknown | null {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return parseJson<unknown>(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function readManifest(backupPath: string): RebuildManifest | null {
  try {
    const parsed = readManifestPayload(backupPath);
    if (!isRebuildManifest(parsed)) return null;
    const manifest = parsed as RebuildManifest & {
      dir?: string;
      writableDir?: string;
    };
    const dir = manifest.dir ?? manifest.writableDir;
    if (!dir) return null;
    const runtimeSnapshot =
      manifest.runtimeSnapshot === undefined
        ? undefined
        : cloneSandboxRuntimeSnapshot(manifest.runtimeSnapshot);
    const workload =
      manifest.workload === undefined ? undefined : cloneSandboxWorkloadReceipt(manifest.workload);
    const hostLocalInferenceReceipt = registry.cloneSandboxHostLocalInferenceReceipt(
      manifest.hostLocalInferenceReceipt,
    );
    const hostLocalInferenceProvenance = registry.cloneSandboxHostLocalInferenceProvenance(
      manifest.hostLocalInferenceProvenance,
    );
    return {
      ...manifest,
      dir,
      // Preserve repeated normalized paths from this untrusted payload so the
      // restore contract can reject them instead of silently de-duplicating.
      stateFiles: normalizeStateFileSpecsPreservingDuplicates(manifest.stateFiles ?? []),
      blueprintDigest: manifest.blueprintDigest ?? null,
      ...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
      ...(workload === undefined ? {} : { workload }),
      ...(typeof hostLocalInferenceReceipt === "string" ? { hostLocalInferenceReceipt } : {}),
      ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
    };
  } catch {
    return null;
  }
}

// ── Listing ────────────────────────────────────────────────────────

export type RebuildRecoveryManifestValidation =
  | { ok: true; manifest: RebuildManifest }
  | { ok: false; reason: string };

function legacyStateFilesArePresent(backupPath: string, manifest: RebuildManifest): boolean {
  if (manifest.backupComplete !== undefined) return true;
  return (manifest.stateFiles ?? []).every((spec) => {
    try {
      return lstatSync(path.join(backupPath, spec.path)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Remove one completed rebuild backup without allowing a caller-controlled
 * path to escape the sandbox's timestamped backup directory.
 */
export function removeSandboxStateBackup(sandboxName: string, backupPath: string): boolean {
  const rebuildBackupsRoot = path.resolve(REBUILD_BACKUPS_DIR);
  const sandboxBackupRoot = path.resolve(rebuildBackupsRoot, sandboxName);
  const candidateBackupPath = path.resolve(backupPath);

  if (
    sandboxBackupRoot === rebuildBackupsRoot ||
    !isWithinRoot(sandboxBackupRoot, rebuildBackupsRoot) ||
    normalizeHostPath(path.dirname(candidateBackupPath)) !== normalizeHostPath(sandboxBackupRoot)
  ) {
    return false;
  }

  try {
    rejectSymlinksOnPath(candidateBackupPath);
    rmSync(candidateBackupPath, { recursive: true, force: true });
    return !existsSync(candidateBackupPath);
  } catch {
    return false;
  }
}

/**
 * Re-read and validate a prepared rebuild backup before a destructive recovery.
 *
 * `getLatestBackup()` validates the manifest schema. Recovery additionally pins
 * the backup to the target sandbox's own timestamped directory and requires the
 * persisted sandbox/agent identity to match the registry entry. This keeps an
 * installer recovery from deleting a sandbox based on a renamed, copied, or
 * otherwise mismatched manifest.
 */
export function validateRebuildRecoveryManifest(
  sandboxName: string,
  agentName: string | null | undefined,
  candidate: RebuildManifest,
): RebuildRecoveryManifestValidation {
  const expectedAgent = String(agentName || "openclaw").trim() || "openclaw";
  const sandboxBackupRoot = path.resolve(REBUILD_BACKUPS_DIR, sandboxName);
  const expectedBackupPath = path.resolve(sandboxBackupRoot, candidate.timestamp);
  const candidateBackupPath = path.resolve(candidate.backupPath);

  if (
    candidateBackupPath !== expectedBackupPath ||
    path.dirname(candidateBackupPath) !== sandboxBackupRoot ||
    path.basename(candidateBackupPath) !== candidate.timestamp
  ) {
    return {
      ok: false,
      reason: `backup path does not match '${sandboxName}' and timestamp '${candidate.timestamp}'`,
    };
  }

  const persisted = readManifest(candidateBackupPath);
  if (!persisted || persisted.version !== MANIFEST_VERSION) {
    return {
      ok: false,
      reason: "latest backup manifest is missing, malformed, or unsupported",
    };
  }
  if (persisted.sandboxName !== sandboxName) {
    return {
      ok: false,
      reason: `manifest sandbox '${persisted.sandboxName}' does not match '${sandboxName}'`,
    };
  }
  if (persisted.agentType !== expectedAgent) {
    return {
      ok: false,
      reason: `manifest agent '${persisted.agentType}' does not match registry agent '${expectedAgent}'`,
    };
  }
  if (
    persisted.timestamp !== candidate.timestamp ||
    path.resolve(persisted.backupPath) !== candidateBackupPath
  ) {
    return {
      ok: false,
      reason: "persisted backup identity changed during validation",
    };
  }

  return { ok: true, manifest: persisted };
}

/**
 * Confirm that a registry entry carries positive NemoClaw-managed image
 * provenance. Managed images built by current releases receive a non-empty
 * `nemoclawVersion` fingerprint, while custom images do not.
 *
 * `agentVersion` is not provenance: a live version probe can populate it for a
 * legacy custom image, and backup then copies that value into the manifest.
 * Pre-fingerprint entries therefore fail closed instead of inferring image
 * ownership from matching agent versions.
 */
export function hasPositiveManagedImageEvidence(
  sandbox: Pick<registry.SandboxEntry, "nemoclawVersion">,
): boolean {
  return typeof sandbox.nemoclawVersion === "string" && sandbox.nemoclawVersion.trim().length > 0;
}

/**
 * Decide whether prepared recovery may recreate a sandbox with NemoClaw's
 * managed image. Any recorded custom `--from` image fails closed. Otherwise,
 * current rows must carry a managed-image fingerprint and a pre-fingerprint
 * row may proceed only with per-row operator authorization.
 */
export function isManagedImageRecoveryAllowed(
  sandbox: Pick<registry.SandboxEntry, "nemoclawVersion" | "fromDockerfile">,
  allowLegacyManagedImageRecovery: boolean,
): boolean {
  const hasNoCustomImageEvidence =
    sandbox.fromDockerfile === undefined || sandbox.fromDockerfile === null;
  return (
    hasNoCustomImageEvidence &&
    (hasPositiveManagedImageEvidence(sandbox) || allowLegacyManagedImageRecovery)
  );
}

/** List complete recovery backups for a sandbox, newest first. */
export function listBackups(sandboxName: string): SnapshotEntry[] {
  const dir = path.join(REBUILD_BACKUPS_DIR, sandboxName);
  if (!existsSync(dir)) return [];

  const rawEntries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());

  const manifests: RebuildManifest[] = [];
  for (const entry of rawEntries) {
    const backupPath = path.join(dir, entry.name);
    const m = readManifest(backupPath);
    if (
      m &&
      m.backupComplete !== false &&
      (m.failedBackupDirs?.length ?? 0) === 0 &&
      legacyStateFilesArePresent(backupPath, m)
    ) {
      manifests.push(m);
    }
  }

  return manifests.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Get the most recent backup for a sandbox, or null.
 */
export function getLatestBackup(sandboxName: string): SnapshotEntry | null {
  const backups = listBackups(sandboxName);
  return backups[0] || null;
}
