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
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "child_process";
import { parse as parseYaml } from "yaml";

import {
  captureSandboxSshConfigCommand,
  isOpenShellSandboxPolicyCredentialFree,
  resolveOpenshellSandboxSshHost,
} from "../adapters/openshell/client.js";
import { buildSelectedOpenShellSubprocessEnv } from "../adapters/openshell/command-argv.js";
import { resolveOpenshell } from "../adapters/openshell/resolve.js";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts.js";
import type { AgentMcpAdapter } from "../agent/defs.js";
import { loadAgent } from "../agent/defs.js";
import { isObjectRecord } from "../core/json-types.js";
import { GATEWAY_PORT } from "../core/ports.js";
import { shellQuote } from "../runner.js";
import {
  createTempSshConfig,
  runWithTempSshConfigCleanup,
  runWithTempSshConfigCleanupAsync,
  type TempSshConfigRunResult,
} from "../sandbox/temp-ssh-config.js";
import {
  CREDENTIAL_PLACEHOLDER,
  isConfigValue,
  isCredentialField,
  isDependencyLockfile,
  isSensitiveFile,
  npmConfigContainsCredentialDirective,
  sanitizeEnvFileContent,
  stripCredentials,
  textContainsCredential,
  textContainsHighConfidenceCredential,
  valueLooksLikeSecret,
} from "../security/credential-filter.js";
import { inspectMcpDeniedToolSelectors } from "../security/mcp-denied-tool-selector.js";
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
import { inspectExtractedDcodeSessionsDatabase } from "./snapshot/dcode-session-credential-scan.js";
import { withoutOpenClawSqliteMachineAuthority } from "./snapshot/openclaw-sqlite-sanitizer.js";
import { nemoclawStateRoot } from "./state-root.js";
import { runTarListing, type TarArchiveSource, type TarListingSource } from "./tar-listing.js";

const HOME_DIR = path.resolve(process.env.HOME || os.homedir());
const REBUILD_BACKUPS_DIR = path.join(nemoclawStateRoot(HOME_DIR, GATEWAY_PORT), "rebuild-backups");

const MANIFEST_VERSION = 2;
const NATIVE_STATE_ARCHIVE = "native-home.tar";
export const NATIVE_STATE_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
const NATIVE_STATE_CAPTURE_RESERVE_BYTES = 64 * 1024 * 1024;
const NATIVE_STATE_CAPTURE_MAX_BYTES = Number.MAX_SAFE_INTEGER - 1;
const NATIVE_STATE_CREDENTIAL_SCAN_MAX_BYTES = 16 * 1024 * 1024;
// These paths are NemoClaw control-plane state, not native agent state. The
// target image regenerates config.json and its root-owned blueprint cache. The
// OpenClaw doctor marker and warm-up sessions are transient lifecycle state.
// Hermes' PID and lock files identify processes in one sandbox generation;
// restoring them over the replacement gateway makes a healthy process appear
// stale to authenticated lifecycle commands.
const NATIVE_STATE_CAPTURE_TAR_EXCLUDES = [
  "--exclude='./.nemoclaw/config.json'",
  "--exclude='./.nemoclaw/blueprints'",
  "--exclude='./.openclaw/.nemoclaw-post-upgrade-doctor'",
  "--exclude='./.openclaw/agents/main/sessions/nemoclaw-onboard-warmup-*'",
  "--exclude='./.openclaw/state/openclaw.sqlite'",
  "--exclude='./.openclaw/state/openclaw.sqlite-journal'",
  "--exclude='./.openclaw/state/openclaw.sqlite-shm'",
  "--exclude='./.openclaw/state/openclaw.sqlite-wal'",
  "--exclude='./.openclaw-data/state/openclaw.sqlite'",
  "--exclude='./.openclaw-data/state/openclaw.sqlite-journal'",
  "--exclude='./.openclaw-data/state/openclaw.sqlite-shm'",
  "--exclude='./.openclaw-data/state/openclaw.sqlite-wal'",
  "--exclude='./.hermes/gateway.pid'",
  "--exclude='./.hermes/runtime/gateway.pid'",
  "--exclude='./.hermes/runtime/gateway.lock'",
].join(" ");
const OPENCLAW_SQLITE_COPY_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const root = process.argv[1];
const relative = process.argv[2];
const output = process.argv[3];
const parts = relative.split("/");
let cursor = root;
for (let index = 0; index < parts.length; index += 1) {
  cursor = path.join(cursor, parts[index]);
  let stat;
  try {
    stat = fs.lstatSync(cursor);
  } catch (error) {
    if (error && error.code === "ENOENT") process.exit(0);
    throw error;
  }
  const final = index === parts.length - 1;
  if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error("unsafe OpenClaw database path");
  }
}
const sourceStat = fs.lstatSync(cursor);
for (const suffix of ["-journal", "-shm", "-wal"]) {
  try {
    const companion = fs.lstatSync(cursor + suffix);
    if (companion.isSymbolicLink() || !companion.isFile()) {
      throw new Error("unsafe OpenClaw database companion");
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
const database = new DatabaseSync(cursor, {
  allowExtension: false,
  readOnly: true,
  timeout: 2_000,
});
try {
  database.prepare("VACUUM INTO ?").run(output);
} finally {
  database.close();
}
fs.chmodSync(output, sourceStat.mode & 0o777);
fs.utimesSync(output, sourceStat.atime, sourceStat.mtime);
`;
const OPENCLAW_SQLITE_CAPTURE_TARGETS = [
  { archivePath: ".openclaw/state/openclaw.sqlite", stageName: "modern" },
  { archivePath: ".openclaw-data/state/openclaw.sqlite", stageName: "legacy" },
] as const;
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
  /**
   * Opaque copy of the OpenShell-owned native home/workspace. Version 2
   * manifests always use this instead of a per-agent state inventory.
   */
  nativeState?: {
    root: string;
    archive: typeof NATIVE_STATE_ARCHIVE;
    sha256: string;
  };
  backupPath: string;
  blueprintDigest: string | null;
  /** False while strict recovery metadata is still being retained. */
  backupComplete?: boolean;
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
  /** Absolute wall-clock deadline shared with lifecycle cleanup. */
  deadlineMs?: number;
  /** Retain an incomplete private backup for bounded caller cleanup. */
  deferSanitizationDeadlineCleanup?: boolean;
  /** Publish the manifest as incomplete until strict recovery metadata is retained. */
  deferCompletionPublication?: boolean;
  /**
   * Internal deterministic capture bound used by tests. Production capture
   * derives its bound from free space in the private backup filesystem.
   */
  nativeStateCaptureMaxBytes?: number;
  /**
   * Internal provider-owned complete native-state source for a stopped
   * sandbox. The directory is already a private validated extraction.
   */
  nativeStateSource?: {
    root: string;
    directory: string;
    assertCurrent(): void;
  };
}

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
  if (!isObjectRecord(value)) return false;
  const allowedKeys = new Set([
    "agentType",
    "agentVersion",
    "backupComplete",
    "backupPath",
    "blueprintDigest",
    "expectedVersion",
    "hostLocalInferenceProvenance",
    "hostLocalInferenceReceipt",
    "nativeState",
    "rebuildMcpHandoff",
    "rebuildPolicyHandoff",
    "runtimeSnapshot",
    "sandboxName",
    "timestamp",
    "version",
    "workload",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
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
    (value.backupComplete === undefined || typeof value.backupComplete === "boolean") &&
    typeof value.backupPath === "string" &&
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
    (value.runtimeSnapshot === undefined || runtimeSnapshot !== undefined) &&
    (value.workload === undefined || workload !== undefined) &&
    (value.hostLocalInferenceReceipt === undefined ||
      (typeof hostLocalInferenceReceipt === "string" && hostLocalInferenceReceipt.length > 0)) &&
    validHostLocalInferenceProvenance &&
    (workload?.kind !== "managed-image" || runtimeSnapshot !== undefined)
  );
}

// ── Safe tar extraction ──────────────────────────────────────────

/** Normalize a host path for safe comparison. */
function normalizeHostPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Check whether candidatePath is within rootPath after normalization. */
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
 * Mirrors the pattern from config-io.ts (PR #2290).
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
 * Reject archive layouts that create a symlink and then extract another
 * member through that path. Standalone symlinks remain native state, including
 * absolute links and links whose targets are outside the native root; only a
 * later archive write through the link is unsafe at the host extraction
 * boundary.
 */
export function rejectSymlinkExtractionTraversal(
  tarArchive: TarListingSource,
  entries: readonly string[],
): string[] {
  const symlinks: Array<{ entry: string; index: number }> = [];
  let index = 0;
  const listingFailure = runTarListing(tarArchive, ["-tvf", "-"], "tar symlink listing", (line) => {
    const entry = entries[index];
    if (entry === undefined) return;
    if (line.startsWith("l")) symlinks.push({ entry, index });
    index += 1;
  });
  if (listingFailure) return [listingFailure];
  if (index !== entries.length) return ["tar symlink listing did not match archive inventory"];

  const normalizedEntries = entries.map((entry) =>
    path.posix.normalize(entry.replace(/^\.\//u, "")).replace(/\/$/u, ""),
  );
  const violations: string[] = [];
  for (const symlink of symlinks) {
    const linkPath = normalizedEntries[symlink.index];
    if (!linkPath || linkPath === ".") {
      violations.push(`unsafe symlink entry: ${symlink.entry}`);
      continue;
    }
    for (let later = symlink.index + 1; later < normalizedEntries.length; later += 1) {
      const candidate = normalizedEntries[later];
      if (candidate === linkPath || candidate?.startsWith(`${linkPath}/`)) {
        violations.push(
          `archive member '${entries[later]}' would extract through symlink '${symlink.entry}'`,
        );
        break;
      }
    }
  }
  return violations;
}

/**
 * Reject hard-link targets that tar would resolve through an earlier archive
 * symlink. The check runs before extraction so the host never asks tar to
 * resolve a container-controlled link target.
 */
export function rejectHardLinkExtractionTraversal(
  tarArchive: TarListingSource,
  entries: readonly string[],
): string[] {
  const symlinks: Array<{ path: string; index: number; entry: string }> = [];
  const hardLinks: Array<{ target: string; index: number; entry: string }> = [];
  const violations: string[] = [];
  let index = 0;
  const listingFailure = runTarListing(tarArchive, ["-tvf", "-"], "tar link listing", (line) => {
    const entry = entries[index];
    if (entry === undefined) return;
    const normalizedEntry = path.posix.normalize(entry.replace(/^\.\//u, "")).replace(/\/$/u, "");
    if (line.startsWith("l")) {
      symlinks.push({ path: normalizedEntry, index, entry });
    } else if (line.startsWith("h") || / link to /u.test(line)) {
      const marker = line.lastIndexOf(" link to ");
      if (marker < 0) {
        violations.push(`uninspectable hard link: ${entry}`);
      } else {
        hardLinks.push({
          target: line.slice(marker + " link to ".length).trim(),
          index,
          entry,
        });
      }
    }
    index += 1;
  });
  if (listingFailure) return [listingFailure];
  if (index !== entries.length) return ["tar link listing did not match archive inventory"];

  for (const hardLink of hardLinks) {
    const target = path.posix.normalize(hardLink.target.replace(/^\.\//u, "")).replace(/\/$/u, "");
    if (
      hardLink.target.startsWith("/") ||
      target === ".." ||
      target.startsWith("../") ||
      target.includes("\0")
    ) {
      violations.push(`unsafe hard-link target '${hardLink.target}' in '${hardLink.entry}'`);
      continue;
    }
    const symlink = symlinks.find(
      (candidate) =>
        candidate.index < hardLink.index &&
        (target === candidate.path || target.startsWith(`${candidate.path}/`)),
    );
    if (symlink) {
      violations.push(
        `hard-link target '${hardLink.target}' in '${hardLink.entry}' resolves through symlink '${symlink.entry}'`,
      );
    }
  }
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

// ── Helpers ────────────────────────────────────────────────────────

export function getSshConfig(
  sandboxName: string,
  runtimeOptions: {
    env?: NodeJS.ProcessEnv;
    gatewayName?: string;
    replaceEnv?: boolean;
    timeoutMs?: number;
  } = {},
): string | null {
  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const result = captureSandboxSshConfigCommand(openshellBinary, sandboxName, {
    ...runtimeOptions,
    ignoreError: true,
    timeout: runtimeOptions.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS,
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

/** Probe only the SSH transport, bounded by one absolute deadline. */
export function probeSandboxSshReachable(sandboxName: string, deadlineMs: number): boolean {
  const configTimeoutMs = remainingBackupTimeoutMs(deadlineMs, OPENSHELL_PROBE_TIMEOUT_MS);
  if (configTimeoutMs === null) return false;
  const sshConfig = getSshConfig(sandboxName, { timeoutMs: configTimeoutMs });
  if (!sshConfig) return false;

  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-readiness-");
  const sshPhase = runWithTempSshConfigCleanup(tempSshConfig, () => {
    const probeTimeoutMs = remainingBackupTimeoutMs(deadlineMs, OPENSHELL_PROBE_TIMEOUT_MS);
    if (probeTimeoutMs === null) return false;
    const result = spawnSync("ssh", [...sshArgs(tempSshConfig.file, sandboxName), ":"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: probeTimeoutMs,
    });
    return result.status === 0 && !result.error && !result.signal;
  });
  if (sshPhase.cleanupError) throw sshPhase.cleanupError;
  return sshPhase.result;
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

/** Normalize provider and workload authority before snapshot publication. */
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
  timeoutMs = 30_000,
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
      timeout: timeoutMs,
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

function structuredContentIsCredentialFree(fileName: string, raw: string): boolean {
  let value: unknown;
  try {
    value = fileName.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  } catch {
    return false;
  }
  if (value === null || value === undefined) return true;
  if (!isConfigValue(value)) return false;
  if (typeof value === "string" && valueLooksLikeSecret(value)) return false;
  return isDeepStrictEqual(stripCredentials(value), value);
}

function dependencyPackageManifestIsCredentialFree(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isConfigValue(value)) return false;
  const inspect = (candidate: unknown, parentField?: string): boolean => {
    if (typeof candidate === "string") {
      return (
        !dependencyStringContainsCredential(candidate) &&
        (!parentField ||
          !isDependencyCredentialField(parentField) ||
          !valueLooksLikeSecret(candidate))
      );
    }
    if (Array.isArray(candidate)) return candidate.every((child) => inspect(child));
    if (candidate && typeof candidate === "object") {
      return Object.entries(candidate).every(([key, child]) => inspect(child, key));
    }
    return true;
  };
  return inspect(value);
}

type ExtractedNativeCredentialCandidate =
  | { kind: "content"; content: Buffer }
  | { kind: "oversize" };

function readExtractedNativeCredentialCandidate(
  scanRoot: string,
  entry: string,
): ExtractedNativeCredentialCandidate | null {
  const candidatePath = path.resolve(scanRoot, entry);
  if (!isWithinRoot(candidatePath, scanRoot)) return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      candidatePath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return null;
    if (opened.size > NATIVE_STATE_CREDENTIAL_SCAN_MAX_BYTES) return { kind: "oversize" };
    return { kind: "content", content: readFileSync(descriptor) };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

const TAR_BLOCK_BYTES = 512;
const NATIVE_CREDENTIAL_SCAN_CHUNK_BYTES = 64 * 1024;
const NATIVE_CREDENTIAL_SCAN_OVERLAP_CHARS = 4096;
const NATIVE_TAR_METADATA_MAX_BYTES = 1024 * 1024;

const DEPENDENCY_NAME_MAP_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "packages",
]);

function isDependencyCredentialField(key: string): boolean {
  const normalized = key.replace(/^_+/u, "");
  return normalized.toLowerCase() === "auth" || isCredentialField(normalized);
}

function dependencyStringContainsCredential(value: string): boolean {
  const candidates = value.match(/https?:\/\/[^\s"'<>]+/gu) ?? [];
  let nonUrlContent = value;
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (
        url.password ||
        (url.username && textContainsHighConfidenceCredential(decodeURIComponent(url.username)))
      )
        return true;
      for (const [key, queryValue] of url.searchParams) {
        if (queryValue && isDependencyCredentialField(key)) return true;
      }
      nonUrlContent = nonUrlContent.replace(candidate, "");
    } catch {
      // Package managers own malformed dependency URL validation. The bounded
      // detector below still rejects high-confidence credential material.
    }
  }
  return textContainsHighConfidenceCredential(nonUrlContent);
}

function dependencyValueContainsCredential(value: unknown, parentField?: string): boolean {
  if (typeof value === "string") return dependencyStringContainsCredential(value);
  if (Array.isArray(value)) return value.some((entry) => dependencyValueContainsCredential(entry));
  if (value === null || typeof value !== "object") return false;

  const keysAreDependencyNames =
    parentField !== undefined && DEPENDENCY_NAME_MAP_FIELDS.has(parentField);
  for (const [key, child] of Object.entries(value)) {
    if (
      !keysAreDependencyNames &&
      isDependencyCredentialField(key) &&
      child !== null &&
      child !== undefined &&
      child !== ""
    ) {
      return true;
    }
    if (dependencyValueContainsCredential(child, key)) return true;
  }
  return false;
}

function yarnV1LockfileContainsCredentialOrIsMalformed(raw: string): boolean {
  if (raw.includes("\uFFFD") || !/^# yarn lockfile v1\r?$/mu.test(raw)) return true;
  let selectorSeen = false;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      if (!line.endsWith(":")) return true;
      selectorSeen = true;
      continue;
    }
    if (!selectorSeen || /\t/u.test(line)) return true;
    const property = /^ {2}([A-Za-z_][A-Za-z0-9_-]*)(?::|\s+)(.*)$/u.exec(line);
    if (property) {
      if (isDependencyCredentialField(property[1]!) && property[2]!.trim()) return true;
      continue;
    }
    if (/^ {4,}(?:"[^"]+"|'[^']+'|\S+)\s+(?:"[^"]*"|'[^']*'|\S+)$/u.test(line)) continue;
    return true;
  }
  return !selectorSeen;
}

function dependencyLockfileContainsCredential(name: string, raw: string): boolean {
  if (dependencyStringContainsCredential(raw)) return true;
  try {
    const parsed: unknown = name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    return dependencyValueContainsCredential(parsed);
  } catch {
    if (name === "yarn.lock") return yarnV1LockfileContainsCredentialOrIsMalformed(raw);
    // A recognized lockfile must be structurally inspectable before its opaque
    // contents can cross the host-side persistence boundary.
    return true;
  }
}

function tarHeaderString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  return header
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8");
}

function tarHeaderSize(header: Buffer): number | null {
  const field = header.subarray(124, 136);
  if ((field[0] ?? 0) & 0x80) {
    let value = BigInt((field[0] ?? 0) & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  const text = field.toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]*$/u.test(text)) return null;
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readArchiveRange(descriptor: number, position: number, length: number): Buffer | null {
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, result, read, length - read, position + read);
    if (count === 0) return null;
    read += count;
  }
  return result;
}

function paxMetadata(
  payload: Buffer,
): { readonly path: string | null; readonly sparse: boolean } | undefined {
  let cursor = 0;
  let archivePath: string | null = null;
  let sparse = false;
  while (cursor < payload.byteLength) {
    const separator = payload.indexOf(0x20, cursor);
    if (separator < 0) return undefined;
    const length = Number.parseInt(payload.subarray(cursor, separator).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.byteLength) {
      return undefined;
    }
    const record = payload.subarray(separator + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(0, equals);
      if (key === "path") archivePath = record.slice(equals + 1);
      if (key.startsWith("GNU.sparse.")) sparse = true;
    }
    cursor += length;
  }
  return { path: archivePath, sparse };
}

function writeArchiveRange(descriptor: number, position: number, content: Buffer): boolean {
  let written = 0;
  while (written < content.byteLength) {
    const count = writeSync(
      descriptor,
      content,
      written,
      content.byteLength - written,
      position + written,
    );
    if (count === 0) return false;
    written += count;
  }
  return true;
}

function withoutHermesMachineLocalApiKey(payload: Buffer): Buffer {
  const source = payload.toString("latin1");
  const sanitized = source.replace(
    /^[\t ]*(?:export[\t ]+)?API_SERVER_KEY[\t ]*=[^\r\n]*(?:\r?\n|$)/gmu,
    (line) => {
      const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
      return `${" ".repeat(line.length - newline.length)}${newline}`;
    },
  );
  return sanitized === source ? payload : Buffer.from(sanitized, "latin1");
}

type NativeStructuredAuthorityKind = "openclaw-config" | "credential-json" | "credential-yaml";

function nativeStructuredAuthorityKind(
  normalized: string,
  fileName: string,
): NativeStructuredAuthorityKind | null {
  if (/^\.openclaw\/openclaw\.json(?:\.last-good|\.bak\.[^/]*)?$/u.test(normalized)) {
    return "openclaw-config";
  }
  if (
    isSensitiveFile(fileName) ||
    /^\.(?:openclaw|openclaw-data)\/(?:devices|identity)\/(?:device(?:-auth)?|paired|pending)\.json$/u.test(
      normalized,
    ) ||
    (!fileName.startsWith("._") &&
      /^\.(?:openclaw|openclaw-data)\/credentials\/.+\.json$/u.test(normalized))
  ) {
    return "credential-json";
  }
  if (
    normalized === ".hermes/config.yaml" ||
    normalized === ".hermes/config.yml" ||
    /^\.hermes\/backups\/config\/config\.ya?ml\.[^/]+$/u.test(normalized)
  ) {
    return "credential-yaml";
  }
  return null;
}

const OMIT_STRIPPED_CREDENTIAL = Symbol("omit stripped credential");

function withoutStrippedCredentialFields(value: unknown): unknown {
  if (value === CREDENTIAL_PLACEHOLDER) return OMIT_STRIPPED_CREDENTIAL;
  if (Array.isArray(value)) {
    return value.map((child) => {
      const sanitized = withoutStrippedCredentialFields(child);
      return sanitized === OMIT_STRIPPED_CREDENTIAL ? null : sanitized;
    });
  }
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const sanitized = withoutStrippedCredentialFields(child);
      return sanitized === OMIT_STRIPPED_CREDENTIAL ? [] : [[key, sanitized]];
    }),
  );
}

function sanitizedStructuredAuthority(
  payload: Buffer,
  size: number,
  normalized: string,
  kind: NativeStructuredAuthorityKind,
): Buffer | string {
  let config: unknown;
  try {
    config =
      kind === "credential-yaml"
        ? parseYaml(payload.toString("utf8"))
        : JSON.parse(payload.toString("utf8"));
  } catch {
    return `the machine-local configuration at '${normalized}' is not valid structured data`;
  }
  if (!isConfigValue(config)) {
    return `the machine-local configuration at '${normalized}' is not a plain configuration value`;
  }

  let sanitized: unknown = config;
  if (kind === "openclaw-config") {
    if (!isObjectRecord(config)) {
      return `the OpenClaw configuration at '${normalized}' is not an object`;
    }
    const gateway = config.gateway;
    if (isObjectRecord(gateway) && Object.hasOwn(gateway, "auth")) {
      sanitized = structuredClone(config);
      const sanitizedGateway = (sanitized as Record<string, unknown>).gateway;
      if (isObjectRecord(sanitizedGateway)) delete sanitizedGateway.auth;
    }
  } else if (
    kind === "credential-json" &&
    /^(?:\.openclaw|\.openclaw-data)\/identity\/device\.json$/u.test(normalized)
  ) {
    // The complete native-home archive keeps the path but cannot retain the
    // machine-local private key. Leave an explicit, narrowly recognized
    // startup placeholder instead of a partial identity that OpenClaw would
    // correctly reject as corrupt legacy state.
    sanitized = { nemoclawSanitizedDeviceIdentity: 1 };
  } else {
    sanitized = stripCredentials(config);
  }
  if (isDeepStrictEqual(sanitized, config)) return payload;

  let serialized = Buffer.from(JSON.stringify(sanitized), "utf8");
  if (serialized.byteLength > size && kind !== "openclaw-config") {
    const compact = withoutStrippedCredentialFields(sanitized);
    serialized = Buffer.from(
      JSON.stringify(compact === OMIT_STRIPPED_CREDENTIAL ? null : compact),
      "utf8",
    );
  }
  if (serialized.byteLength > size) {
    return `the machine-local configuration at '${normalized}' cannot be sanitized in place`;
  }
  const replacement = Buffer.alloc(size, 0x20);
  serialized.copy(replacement);
  return replacement;
}

/**
 * Remove machine-local runtime authority from the private archive copy. The
 * live native tree is never modified, and all other native state is retained.
 * Keeping each tar member at its original byte length makes this a bounded,
 * single-copy operation. Replacement startup creates fresh local authority.
 */
export function sanitizeMachineLocalArchiveConfig(archivePath: string): string | null {
  const hermesTarget = ".hermes/.env";
  const openClawDatabaseTargets = new Set([
    ".openclaw/state/openclaw.sqlite",
    ".openclaw-data/state/openclaw.sqlite",
  ]);
  const openClawDatabaseCompanions = new Set(
    [...openClawDatabaseTargets].flatMap((target) => [
      `${target}-journal`,
      `${target}-shm`,
      `${target}-wal`,
    ]),
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(archivePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const archiveSize = fstatSync(descriptor).size;
    let offset = 0;
    let nextPath: string | null = null;
    const found = new Set<string>();
    while (offset < archiveSize) {
      const header = readArchiveRange(descriptor, offset, TAR_BLOCK_BYTES);
      if (!header) return "could not read the native archive";
      if (header.every((byte) => byte === 0)) return null;
      const size = tarHeaderSize(header);
      if (size === null) return "the native archive has an invalid member size";
      const dataOffset = offset + TAR_BLOCK_BYTES;
      const nextOffset = dataOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      if (!Number.isSafeInteger(nextOffset) || nextOffset > archiveSize) {
        return "the native archive is truncated";
      }
      const type = String.fromCharCode(header[156] ?? 0);
      const name = tarHeaderString(header, 0, 100);
      const prefix = tarHeaderString(header, 345, 155);
      const headerPath = prefix ? `${prefix}/${name}` : name;
      if (type === "x" || type === "g" || type === "L") {
        if (size > NATIVE_TAR_METADATA_MAX_BYTES) return "the native archive metadata is too large";
        const metadata = readArchiveRange(descriptor, dataOffset, size);
        if (!metadata) return "could not read the native archive metadata";
        if (type === "x" || type === "g") {
          const parsed = paxMetadata(metadata);
          if (parsed === undefined) return "the native archive has invalid PAX metadata";
          if (type === "x" && parsed.path !== null) nextPath = parsed.path;
        } else {
          nextPath = metadata.toString("utf8").replace(/\0.*$/su, "");
          if (!nextPath) return "the native archive has an invalid GNU long path";
        }
      } else {
        const entry = nextPath ?? headerPath;
        nextPath = null;
        const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
        if (openClawDatabaseCompanions.has(normalized)) {
          return `the native archive contains the transient OpenClaw database companion '${normalized}'`;
        }
        const fileName = path.posix.basename(normalized).toLowerCase();
        const structuredKind = nativeStructuredAuthorityKind(normalized, fileName);
        if (
          structuredKind ||
          normalized === hermesTarget ||
          openClawDatabaseTargets.has(normalized)
        ) {
          if (found.has(normalized)) {
            return `the native archive contains duplicate machine-local configuration at '${normalized}'`;
          }
          found.add(normalized);
          if (type !== "0" && type !== "\0" && type !== "7") {
            return `the machine-local configuration at '${normalized}' is not a regular archive member`;
          }
          if (size > NATIVE_STATE_CREDENTIAL_SCAN_MAX_BYTES) {
            return `the machine-local configuration at '${normalized}' is too large to sanitize safely`;
          }
          const payload = readArchiveRange(descriptor, dataOffset, size);
          if (!payload) return `could not read the machine-local configuration at '${normalized}'`;
          let replacement: Buffer;
          if (normalized === hermesTarget) {
            replacement = withoutHermesMachineLocalApiKey(payload);
          } else if (openClawDatabaseTargets.has(normalized)) {
            const sanitized = withoutOpenClawSqliteMachineAuthority(payload);
            if (typeof sanitized === "string") return sanitized;
            replacement = sanitized;
          } else {
            const sanitized = sanitizedStructuredAuthority(
              payload,
              size,
              normalized,
              structuredKind!,
            );
            if (typeof sanitized === "string") return sanitized;
            replacement = sanitized;
          }
          if (replacement !== payload) {
            if (!writeArchiveRange(descriptor, dataOffset, replacement)) {
              return `could not sanitize the machine-local configuration at '${normalized}'`;
            }
          }
        }
      }
      offset = nextOffset;
    }
    return offset === archiveSize ? null : "the native archive is malformed";
  } catch (error) {
    return `could not sanitize machine-local configuration: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function shouldSkipNativeRawCredentialScan(fileName: string): boolean {
  return isDependencyLockfile(fileName);
}

type DcodeSessionsDatabaseEntryRole = "database" | "sidecar" | null;

const DCODE_SESSIONS_DATABASE_ENTRY = ".deepagents/.state/sessions.db";
const DCODE_SESSIONS_DATABASE_SIDECARS = new Set(["-journal", "-shm", "-wal"]);

function dcodeSessionsDatabaseEntryRole(entry: string): DcodeSessionsDatabaseEntryRole {
  const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
  if (normalized === DCODE_SESSIONS_DATABASE_ENTRY) return "database";
  for (const suffix of DCODE_SESSIONS_DATABASE_SIDECARS) {
    if (normalized === `${DCODE_SESSIONS_DATABASE_ENTRY}${suffix}`) return "sidecar";
  }
  return null;
}

function isBundledProviderProfileSchema(entry: string): boolean {
  const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
  return /^\.nemoclaw\/blueprints\/[^/]+\/provider-profiles\/[^/]+\.(?:json|ya?ml)$/u.test(
    normalized,
  );
}

const NATIVE_DEPENDENCY_TREE_SEGMENTS = new Set([".venv", "node_modules", "site-packages", "venv"]);

function isNativeDependencyTreeEntry(entry: string): boolean {
  const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
  const segments = normalized.split("/");
  return (
    normalized.startsWith(".hermes/lazy-packages/") ||
    segments.some((segment) => NATIVE_DEPENDENCY_TREE_SEGMENTS.has(segment))
  );
}

function shouldScanNativeOpaqueAssignments(
  entry: string,
  fileName: string,
  providerProfileSchema: boolean,
): boolean {
  const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
  return (
    providerProfileSchema ||
    nativeStructuredAuthorityKind(normalized, fileName) !== null ||
    fileName === ".env" ||
    fileName.endsWith(".env") ||
    /^\.openclaw\/agents\/[^/]+\/(?:history|session)\.log$/u.test(normalized)
  );
}

function scanNativeTarFilePayload(
  descriptor: number,
  position: number,
  size: number,
  opaqueAssignments: boolean,
  npmConfig: boolean,
  providerProfileSchema: boolean,
  privateKeyHeader: boolean,
  dependencyBinary: boolean,
): boolean | null {
  const chunk = Buffer.allocUnsafe(NATIVE_CREDENTIAL_SCAN_CHUNK_BYTES);
  let remaining = size;
  let offset = position;
  let overlap = "";
  while (remaining > 0) {
    const requested = Math.min(remaining, chunk.byteLength);
    const count = readSync(descriptor, chunk, 0, requested, offset);
    if (count === 0) return null;
    if (dependencyBinary && offset === position && chunk.subarray(0, count).includes(0)) {
      return false;
    }
    const raw = overlap + chunk.subarray(0, count).toString("utf8");
    if (npmConfig && npmConfigContainsCredentialDirective(raw)) return true;
    // Provider profiles describe whether injected material is secret with a
    // boolean schema field. Mask only that declaration; an opaque string in
    // the same field (or any other credential assignment) still fails closed.
    const credentialScanInput = providerProfileSchema
      ? raw.replace(
          /^([ \t]*(?:"secret"|secret)[ \t]*:[ \t]*)(?:true|false)([ \t]*,?[ \t]*(?:#.*)?)$/gimu,
          "$1unused$2",
        )
      : raw;
    if (
      textContainsCredential(credentialScanInput, {
        opaqueAssignments,
        privateKeyHeader,
      })
    ) {
      return true;
    }
    overlap = raw.slice(-NATIVE_CREDENTIAL_SCAN_OVERLAP_CHARS);
    offset += count;
    remaining -= count;
  }
  return false;
}

function nativeArchiveRawCredentialViolation(archivePath: string): string | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const archiveSize = fstatSync(descriptor).size;
    let offset = 0;
    let nextPath: string | null = null;
    while (offset < archiveSize) {
      const header = readArchiveRange(descriptor, offset, TAR_BLOCK_BYTES);
      if (!header) return "native state credential scan";
      if (header.every((byte) => byte === 0)) return null;
      const size = tarHeaderSize(header);
      if (size === null) return "native state credential scan";
      const dataOffset = offset + TAR_BLOCK_BYTES;
      const dataEnd = dataOffset + size;
      const nextOffset = dataOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      if (!Number.isSafeInteger(dataEnd) || nextOffset > archiveSize) {
        return "native state credential scan";
      }
      const type = String.fromCharCode(header[156] ?? 0);
      // Sparse formats can expand a small archive payload into an arbitrarily
      // large logical file and bypass the bounded raw-byte credential scan.
      if (type === "S") return "native state sparse archive entry";
      const name = tarHeaderString(header, 0, 100);
      const prefix = tarHeaderString(header, 345, 155);
      const headerPath = prefix ? `${prefix}/${name}` : name;
      if (type === "x" || type === "g" || type === "L") {
        if (size > NATIVE_TAR_METADATA_MAX_BYTES) return "native state credential scan";
        const metadata = readArchiveRange(descriptor, dataOffset, size);
        if (!metadata) return "native state credential scan";
        if (type === "x" || type === "g") {
          const parsed = paxMetadata(metadata);
          if (parsed === undefined) return "native state credential scan";
          if (parsed.sparse) return "native state sparse archive entry";
          if (type === "x" && parsed.path !== null) nextPath = parsed.path;
        } else {
          nextPath = metadata.toString("utf8").replace(/\0.*$/su, "");
          if (!nextPath) return "native state credential scan";
        }
      } else {
        const entry = nextPath ?? headerPath;
        nextPath = null;
        if (type === "0" || type === "\0" || type === "7") {
          const fileName = path.posix.basename(entry).toLowerCase();
          if (
            !shouldSkipNativeRawCredentialScan(fileName) &&
            dcodeSessionsDatabaseEntryRole(entry) === null
          ) {
            // Dependency source is not a credential authority and generated
            // bundles can contain accidental token-shaped bytes. Package
            // manifests still receive a structure-aware scan below.
            const providerProfileSchema = isBundledProviderProfileSchema(entry);
            const dependencyTree = isNativeDependencyTreeEntry(entry);
            const violation = scanNativeTarFilePayload(
              descriptor,
              dataOffset,
              size,
              shouldScanNativeOpaqueAssignments(entry, fileName, providerProfileSchema),
              fileName === ".npmrc",
              providerProfileSchema,
              !dependencyTree,
              dependencyTree,
            );
            if (violation === null) return "native state credential scan";
            if (violation) return entry;
          }
        }
      }
      offset = nextOffset;
    }
    return offset === archiveSize ? null : "native state credential scan";
  } catch {
    return "native state credential scan";
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function nativeArchiveCredentialViolation(
  archivePath: string,
  entries: readonly string[],
): string | null {
  const rawViolation = nativeArchiveRawCredentialViolation(archivePath);
  if (rawViolation) return rawViolation;
  const candidates: Array<{
    entry: string;
    fileName: string;
    isDependencyPackage: boolean;
    dcodeSessionsDatabaseRole: DcodeSessionsDatabaseEntryRole;
    isEnv: boolean;
    isLockfile: boolean;
  }> = [];
  for (const entry of new Set(entries)) {
    if (entry.endsWith("/")) continue;
    const fileName = path.posix.basename(entry).toLowerCase();
    const isLockfile = isDependencyLockfile(fileName);
    const segments = path.posix.normalize(entry.replace(/^\.\//u, "")).split("/");
    const isDependencyPackage = fileName === "package.json" && segments.includes("node_modules");
    const dcodeSessionsDatabaseRole = dcodeSessionsDatabaseEntryRole(entry);
    const isSensitive = isSensitiveFile(fileName);
    const isEnv = fileName === ".env" || fileName.endsWith(".env");
    if (
      !isLockfile &&
      !isDependencyPackage &&
      dcodeSessionsDatabaseRole === null &&
      !isEnv &&
      !isSensitive
    ) {
      continue;
    }
    candidates.push({
      entry,
      fileName,
      isDependencyPackage,
      dcodeSessionsDatabaseRole,
      isEnv,
      isLockfile,
    });
  }
  if (candidates.length === 0) return null;
  const dcodeSessionsDatabase = candidates.find(
    ({ dcodeSessionsDatabaseRole }) => dcodeSessionsDatabaseRole === "database",
  );
  const orphanedDcodeSessionsDatabaseSidecar = candidates.find(
    ({ dcodeSessionsDatabaseRole }) => dcodeSessionsDatabaseRole === "sidecar",
  );
  if (!dcodeSessionsDatabase && orphanedDcodeSessionsDatabaseSidecar) {
    return orphanedDcodeSessionsDatabaseSidecar.entry;
  }

  const temporary = mkdtempSync(path.join(path.dirname(archivePath), ".native-scan-"));
  const scanRoot = path.join(temporary, "root");
  const memberList = path.join(temporary, "members");
  let archiveDescriptor: number | null = null;
  try {
    mkdirSync(scanRoot, { mode: 0o700 });
    writeFileSync(memberList, Buffer.from(`${candidates.map(({ entry }) => entry).join("\0")}\0`), {
      mode: 0o600,
    });
    archiveDescriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const extracted = spawnSync(
      "tar",
      ["--no-same-owner", "--no-recursion", "--null", "-xf", "-", "-C", scanRoot, "-T", memberList],
      {
        stdio: [archiveDescriptor, "pipe", "pipe"],
        timeout: NATIVE_STATE_CAPTURE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    closeSync(archiveDescriptor);
    archiveDescriptor = null;
    if (extracted.status !== 0 || extracted.error || extracted.signal) {
      return candidates[0]?.entry ?? "native state credential scan";
    }
    for (const candidate of candidates) {
      if (candidate.dcodeSessionsDatabaseRole === "sidecar") continue;
      if (candidate.dcodeSessionsDatabaseRole === "database") {
        const containsCredential = inspectExtractedDcodeSessionsDatabase(scanRoot, candidate.entry);
        if (containsCredential !== false) return candidate.entry;
        continue;
      }
      const extractedCandidate = readExtractedNativeCredentialCandidate(scanRoot, candidate.entry);
      if (!extractedCandidate) {
        return candidate.entry;
      }
      if (extractedCandidate.kind === "oversize") {
        if (candidate.isLockfile || candidate.isDependencyPackage) return candidate.entry;
        continue;
      }
      const raw = extractedCandidate.content.toString("utf8");
      if (
        (candidate.isLockfile && dependencyLockfileContainsCredential(candidate.fileName, raw)) ||
        (candidate.isDependencyPackage && !dependencyPackageManifestIsCredentialFree(raw)) ||
        (!candidate.isLockfile && candidate.isEnv && sanitizeEnvFileContent(raw) !== raw) ||
        (!candidate.isLockfile &&
          !candidate.isDependencyPackage &&
          !candidate.isEnv &&
          !structuredContentIsCredentialFree(candidate.fileName, raw))
      ) {
        return candidate.entry;
      }
    }
    return null;
  } finally {
    if (archiveDescriptor !== null) closeSync(archiveDescriptor);
    rmSync(temporary, { recursive: true, force: true });
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

type OpenedNativeArchive = { descriptor: number; entries: string[] } | { error: string };

function copyNativeArchiveToPrivateDescriptor(
  sourceDescriptor: number,
  stagingDirectory: string,
  nativeRoot: string,
): {
  descriptor: number;
  sha256: string;
  entries: string[];
  violations: string[];
} {
  const temporaryRoot = mkdtempSync(path.join(stagingDirectory, ".native-restore-"));
  const privatePath = path.join(temporaryRoot, "archive.tar");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      privatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(descriptor, buffer, written, bytesRead - written, position + written);
      }
      position += bytesRead;
    }
    const validation = validateTarEntries({ filePath: privatePath }, nativeRoot);
    const symlinkViolations = validation.safe
      ? rejectSymlinkExtractionTraversal({ filePath: privatePath }, validation.entries)
      : [];
    const hardLinkTraversalViolations = validation.safe
      ? rejectHardLinkExtractionTraversal({ filePath: privatePath }, validation.entries)
      : [];
    const result = {
      descriptor,
      sha256: hash.digest("hex"),
      entries: validation.entries,
      violations: [...validation.violations, ...symlinkViolations, ...hardLinkTraversalViolations],
    };
    descriptor = null;
    return result;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function openValidatedNativeArchive(
  archivePath: string,
  expectedSha256: string,
  nativeRoot: string,
): OpenedNativeArchive {
  let sourceDescriptor: number | null = null;
  let restoreDescriptor: number | null = null;
  const identityError = "Native home/workspace archive identity does not match its manifest";
  try {
    sourceDescriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceIdentity = fstatSync(sourceDescriptor);
    if (!sourceIdentity.isFile()) return { error: identityError };
    const privateArchive = copyNativeArchiveToPrivateDescriptor(
      sourceDescriptor,
      path.dirname(archivePath),
      nativeRoot,
    );
    restoreDescriptor = privateArchive.descriptor;
    if (
      fstatSync(restoreDescriptor).size !== sourceIdentity.size ||
      privateArchive.sha256 !== expectedSha256
    ) {
      return { error: identityError };
    }
    const finalIdentity = fstatSync(sourceDescriptor);
    if (
      finalIdentity.dev !== sourceIdentity.dev ||
      finalIdentity.ino !== sourceIdentity.ino ||
      finalIdentity.size !== sourceIdentity.size ||
      finalIdentity.mtimeMs !== sourceIdentity.mtimeMs ||
      finalIdentity.ctimeMs !== sourceIdentity.ctimeMs
    ) {
      return { error: identityError };
    }
    if (privateArchive.violations.length > 0) {
      return {
        error: `Native home/workspace archive is unsafe: ${privateArchive.violations.join("; ")}`,
      };
    }
    const descriptor = restoreDescriptor;
    restoreDescriptor = null;
    return { descriptor, entries: privateArchive.entries };
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z0-9_]+$/.test(error.code)
        ? ` (${error.code})`
        : "";
    return {
      error: `Native home/workspace archive is missing or unreadable${code}`,
    };
  } finally {
    if (sourceDescriptor !== null) closeSync(sourceDescriptor);
    if (restoreDescriptor !== null) closeSync(restoreDescriptor);
  }
}

/**
 * Inspect a digest-bound native-state archive through a private extraction.
 * The temporary tree is removed before this function returns.
 */
function rejectNativeStateInspection(message: string): never {
  throw new Error(message);
}

export function inspectNativeSandboxState<T>(
  backupPath: string,
  inspect: (nativeRoot: string) => T,
  member?: string,
): T {
  const manifest = readManifest(backupPath);
  if (!manifest?.nativeState || manifest.version !== MANIFEST_VERSION) {
    rejectNativeStateInspection(
      "Backup does not contain a supported complete native home/workspace archive",
    );
  }
  const archivePath = path.join(backupPath, manifest.nativeState.archive);
  const openedArchive = openValidatedNativeArchive(
    archivePath,
    manifest.nativeState.sha256,
    manifest.nativeState.root,
  );
  if ("error" in openedArchive) rejectNativeStateInspection(openedArchive.error);
  const temporary = mkdtempSync(path.join(backupPath, ".native-inspect-"));
  const extractionRoot = path.join(temporary, "root");
  try {
    mkdirSync(extractionRoot, { mode: 0o700 });
    let tarArguments = ["--no-same-owner", "-xf", "-", "-C", extractionRoot];
    if (member !== undefined) {
      const normalizedMember = path.posix.normalize(member.replace(/^\.\//u, ""));
      if (
        normalizedMember === "." ||
        path.posix.isAbsolute(normalizedMember) ||
        normalizedMember === ".." ||
        normalizedMember.startsWith("../")
      ) {
        throw new Error("Native home/workspace inspection member is invalid");
      }
      const matchingEntries = openedArchive.entries.filter((entry) => {
        const normalizedEntry = path.posix
          .normalize(entry.replace(/^\.\//u, ""))
          .replace(/\/$/u, "");
        return (
          normalizedEntry === normalizedMember || normalizedEntry.startsWith(`${normalizedMember}/`)
        );
      });
      if (matchingEntries.length === 0) {
        mkdirSync(path.join(extractionRoot, normalizedMember), {
          recursive: true,
          mode: 0o700,
        });
        return inspect(extractionRoot);
      }
      const memberList = path.join(temporary, "members");
      writeFileSync(memberList, Buffer.from(`${matchingEntries.join("\0")}\0`), { mode: 0o600 });
      tarArguments = [
        "--no-same-owner",
        "--no-recursion",
        "--null",
        "-xf",
        "-",
        "-C",
        extractionRoot,
        "-T",
        memberList,
      ];
    }
    const result = spawnSync("tar", tarArguments, {
      stdio: [openedArchive.descriptor, "pipe", "pipe"],
      timeout: NATIVE_STATE_CAPTURE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error || result.signal) {
      const detail =
        result.error?.message ??
        (result.signal
          ? `signal ${result.signal}`
          : result.stderr?.toString().trim() || `exit ${String(result.status)}`);
      throw new Error(
        `Native home/workspace archive could not be extracted for inspection: ${detail.substring(0, 240)}`,
      );
    }
    return inspect(extractionRoot);
  } finally {
    closeSync(openedArchive.descriptor);
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function nativeStateCaptureMaxBytes(
  backupPath: string,
  override?: number,
  concurrentCopies = 1,
): number {
  if (!Number.isSafeInteger(concurrentCopies) || concurrentCopies <= 0) {
    throw new Error("Native state capture concurrent-copy count must be a positive integer");
  }
  if (override !== undefined) {
    if (
      !Number.isSafeInteger(override) ||
      override <= 0 ||
      override > NATIVE_STATE_CAPTURE_MAX_BYTES
    ) {
      throw new Error(
        `Native state capture limit must be an integer between 1 and ${NATIVE_STATE_CAPTURE_MAX_BYTES}`,
      );
    }
  }
  const stats = statfsSync(backupPath, { bigint: true });
  const available = stats.bavail * stats.bsize;
  const reserve = BigInt(NATIVE_STATE_CAPTURE_RESERVE_BYTES);
  const bounded = available > reserve ? available - reserve : 0n;
  const configuredMaximum = BigInt(override ?? NATIVE_STATE_CAPTURE_MAX_BYTES);
  const maximumPerCopy = configuredMaximum / BigInt(concurrentCopies);
  const availablePerCopy = bounded / BigInt(concurrentCopies);
  return Number(availablePerCopy > maximumPerCopy ? maximumPerCopy : availablePerCopy);
}

function capturePreparedNativeState(
  source: NonNullable<BackupOptions["nativeStateSource"]>,
  archiveDescriptor: number,
  maxBytes: number,
  timeoutMs: number,
): ReturnType<typeof spawnSync> {
  source.assertCurrent();
  const sourceStat = lstatSync(source.directory);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Prepared stopped native state root is not a directory");
  }
  const sqliteStage = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-sqlite-copy-"));
  try {
    const materializationStartedAt = Date.now();
    for (const target of OPENCLAW_SQLITE_CAPTURE_TARGETS) {
      const remainingMs = timeoutMs - (Date.now() - materializationStartedAt);
      if (remainingMs <= 0) throw new Error("Prepared native-state SQLite capture timed out");
      const result = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "-e",
          OPENCLAW_SQLITE_COPY_SCRIPT,
          source.directory,
          target.archivePath,
          path.join(sqliteStage, target.stageName),
        ],
        { stdio: "ignore", timeout: remainingMs },
      );
      if (result.status !== 0 || result.error || result.signal) {
        throw new Error("Could not materialize a consistent private OpenClaw database copy");
      }
    }
    const remainingMs = timeoutMs - (Date.now() - materializationStartedAt);
    if (remainingMs <= 0) throw new Error("Prepared native-state SQLite capture timed out");
    // GNU tar can emit each hard-linked file as independent archive content
    // without following symbolic links (`--hard-dereference` is hard-link-only).
    // BSD tar cannot, so stage a metadata-preserving private copy there; cp does
    // not preserve hard-link identity unless explicitly requested to do so.
    return spawnSync(
      "bash",
      [
        "-o",
        "pipefail",
        "-c",
        [
          "source=$1",
          "sqlite_stage=$2",
          "if tar --hard-dereference -cf - --files-from /dev/null >/dev/null 2>&1; then",
          `  set -- tar -C "$source" --hard-dereference ${NATIVE_STATE_CAPTURE_TAR_EXCLUDES} '--transform=s|^modern$|./.openclaw/state/openclaw.sqlite|' '--transform=s|^legacy$|./.openclaw-data/state/openclaw.sqlite|' -cf - .`,
          '  [ ! -f "$sqlite_stage/modern" ] || set -- "$@" -C "$sqlite_stage" modern',
          '  [ ! -f "$sqlite_stage/legacy" ] || set -- "$@" -C "$sqlite_stage" legacy',
          '  "$@"',
          "else",
          '  stage=$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-stopped-native-capture.XXXXXX")',
          "  trap 'rm -rf -- \"$stage\"' EXIT HUP INT TERM",
          '  cp -RpP "$source/." "$stage/"',
          '  rm -f -- "$stage/.nemoclaw/config.json"',
          '  rm -rf -- "$stage/.nemoclaw/blueprints"',
          '  rm -f -- "$stage/.openclaw/.nemoclaw-post-upgrade-doctor"',
          '  rm -rf -- "$stage"/.openclaw/agents/main/sessions/nemoclaw-onboard-warmup-*',
          '  rm -f -- "$stage/.openclaw/state/openclaw.sqlite"*',
          '  rm -f -- "$stage/.openclaw-data/state/openclaw.sqlite"*',
          '  if [ -f "$sqlite_stage/modern" ]; then mkdir -p "$stage/.openclaw/state"; cp -p "$sqlite_stage/modern" "$stage/.openclaw/state/openclaw.sqlite"; fi',
          '  if [ -f "$sqlite_stage/legacy" ]; then mkdir -p "$stage/.openclaw-data/state"; cp -p "$sqlite_stage/legacy" "$stage/.openclaw-data/state/openclaw.sqlite"; fi',
          '  rm -f -- "$stage/.hermes/gateway.pid"',
          '  rm -f -- "$stage/.hermes/runtime/gateway.pid"',
          '  rm -f -- "$stage/.hermes/runtime/gateway.lock"',
          '  tar -C "$stage" -cf - -- .',
          "fi",
        ].join("\n") + ' | head -c "$NEMOCLAW_NATIVE_CAPTURE_LIMIT_PLUS_ONE"',
        "nemoclaw-stopped-native-capture",
        source.directory,
        sqliteStage,
      ],
      {
        env: {
          ...process.env,
          NEMOCLAW_NATIVE_CAPTURE_LIMIT_PLUS_ONE: String(maxBytes + 1),
        },
        stdio: ["ignore", archiveDescriptor, "pipe"],
        timeout: remainingMs,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    rmSync(sqliteStage, { recursive: true, force: true });
  }
}

function remainingBackupTimeoutMs(
  deadlineMs: number | undefined,
  maximumMs: number,
): number | null {
  if (deadlineMs === undefined) return maximumMs;
  const remainingMs = Math.floor(deadlineMs - Date.now());
  return remainingMs > 0 ? Math.min(maximumMs, remainingMs) : null;
}

function backupDeadlineExpired(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now());
}

function withSshCleanupResult<T extends BackupResult | RestoreResult>({
  result,
  cleanupError,
}: TempSshConfigRunResult<T>): T {
  return cleanupError
    ? {
        ...result,
        success: false,
        ...("unreachable" in result ? { unreachable: false } : {}),
        error: [result.error, `${cleanupError.message}. Remove that directory before retrying.`]
          .filter(Boolean)
          .join(" "),
      }
    : result;
}

/** Capture one opaque archive of the OpenShell-owned native home/workspace. */
function backupNativeSandboxState(sandboxName: string, options: BackupOptions): BackupResult {
  if (backupDeadlineExpired(options.deadlineMs)) {
    return nativeStateFailure("Sandbox backup deadline expired before backup started", true);
  }
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

  let temporary: ReturnType<typeof createTempSshConfig> | null = null;
  const capture = (): BackupResult => {
    let rootResult: { root: string } | { error: string; unreachable: boolean };
    if (options.nativeStateSource) {
      const root = options.nativeStateSource.root;
      rootResult =
        path.posix.isAbsolute(root) && root === path.posix.normalize(root) && root !== "/"
          ? { root }
          : {
              error: "Prepared stopped native state has an invalid persistence root",
              unreachable: false,
            };
    } else {
      const sshConfigTimeoutMs = remainingBackupTimeoutMs(
        options.deadlineMs,
        OPENSHELL_PROBE_TIMEOUT_MS,
      );
      if (sshConfigTimeoutMs === null) {
        rmSync(backupPath, { recursive: true, force: true });
        return nativeStateFailure("Sandbox backup deadline expired before SSH discovery", true);
      }
      const sshConfig = getSshConfig(sandboxName, { timeoutMs: sshConfigTimeoutMs });
      if (!sshConfig) {
        rmSync(backupPath, { recursive: true, force: true });
        return nativeStateFailure("Could not get SSH configuration for native state capture", true);
      }
      temporary = createTempSshConfig(sshConfig, "nemoclaw-native-state-");
      const rootTimeoutMs = remainingBackupTimeoutMs(options.deadlineMs, 30_000);
      if (rootTimeoutMs === null) {
        rmSync(backupPath, { recursive: true, force: true });
        return nativeStateFailure("Sandbox backup deadline expired before native-root discovery");
      }
      rootResult = resolveNativeStateRoot(temporary.file, sandboxName, undefined, rootTimeoutMs);
    }
    if ("error" in rootResult) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(rootResult.error, rootResult.unreachable);
    }
    let maxBytes: number;
    try {
      maxBytes = nativeStateCaptureMaxBytes(backupPath, options.nativeStateCaptureMaxBytes);
    } catch (error) {
      rmSync(backupPath, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      return nativeStateFailure(
        `Could not determine a safe native home/workspace capture limit: ${detail}`,
      );
    }
    if (maxBytes === 0) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native home/workspace capture has no space available after the ${NATIVE_STATE_CAPTURE_RESERVE_BYTES}-byte safety reserve. Free backup-disk space and retry.`,
      );
    }

    const archivePath = path.join(backupPath, NATIVE_STATE_ARCHIVE);
    const archiveFd = openSync(
      archivePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let result: ReturnType<typeof spawnSync>;
    try {
      const captureTimeoutMs = remainingBackupTimeoutMs(
        options.deadlineMs,
        NATIVE_STATE_CAPTURE_TIMEOUT_MS,
      );
      if (captureTimeoutMs === null) {
        rmSync(backupPath, { recursive: true, force: true });
        return nativeStateFailure("Sandbox backup deadline expired before native-state capture");
      }
      if (options.nativeStateSource) {
        result = capturePreparedNativeState(
          options.nativeStateSource,
          archiveFd,
          maxBytes,
          captureTimeoutMs,
        );
      } else {
        if (!temporary) throw new Error("Native state SSH configuration is unavailable");
        // The SSH command runs as the sandbox user. Freeze every other process
        // owned by that user before reading the complete native tree. Materialize
        // any OpenClaw database plus committed WAL state into a private standalone
        // copy, then stream that copy with the other process-quiescent files.
        // Keep the SSH ancestry live so the archive can stream, and always resume
        // processes through the EXIT trap, including tar failures and signals.
        const command = [
          "set -eu",
          `root=${shellQuote(rootResult.root)}`,
          '{ [ -d "$root" ] && [ ! -L "$root" ]; } || exit 20',
          'db_stage=$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-openclaw-sqlite-copy.XXXXXX")',
          "uid=$(id -u)",
          "self=$$",
          'ancestors=" $self "',
          "cursor=$PPID",
          'while [ "$cursor" -gt 1 ] 2>/dev/null; do ancestors="$ancestors$cursor "; parent=""; { while IFS=":" read -r key value; do if [ "$key" = "PPid" ]; then set -- $value; parent=${1:-}; break; fi; done; } 2>/dev/null < "/proc/$cursor/status" || break; cursor=$parent; [ -n "$cursor" ] || break; done',
          'collect_candidates() { candidates=""; for proc in /proc/[0-9]*; do pid=${proc##*/}; case "$ancestors" in *" $pid "*) continue ;; esac; owner=""; while IFS=":" read -r key value; do if [ "$key" = "Uid" ]; then set -- $value; owner=${1:-}; break; fi; done 2>/dev/null < "$proc/status" || :; [ "$owner" = "$uid" ] && candidates="$candidates $pid"; done; }',
          'stopped=""',
          'resume() { [ -z "$stopped" ] || kill -CONT $stopped 2>/dev/null || :; rm -rf -- "$db_stage"; }',
          "trap resume EXIT HUP INT TERM",
          "quiesce_pass=0",
          'while :; do collect_candidates; newly_stopped=""; for pid in $candidates; do case " $stopped " in *" $pid "*) ;; *) if kill -STOP "$pid" 2>/dev/null; then stopped="$stopped $pid"; newly_stopped=1; fi ;; esac; done; [ -n "$newly_stopped" ] || break; quiesce_pass=$((quiesce_pass + 1)); [ "$quiesce_pass" -lt 10 ] || exit 21; done',
          'for pid in $stopped; do attempts=0; while [ -r "/proc/$pid/status" ]; do state=""; { while IFS=":" read -r key value; do if [ "$key" = "State" ]; then set -- $value; state=${1:-}; break; fi; done; } 2>/dev/null < "/proc/$pid/status" || break; case "$state" in T*) break ;; esac; attempts=$((attempts + 1)); [ "$attempts" -lt 100 ] || exit 21; sleep 0.01; done; done',
          "collect_candidates",
          'for pid in $candidates; do case " $stopped " in *" $pid "*) ;; *) exit 21 ;; esac; done',
          'if [ -e "$root/.openclaw/state/openclaw.sqlite" ] || [ -L "$root/.openclaw/state/openclaw.sqlite" ] || [ -e "$root/.openclaw-data/state/openclaw.sqlite" ] || [ -L "$root/.openclaw-data/state/openclaw.sqlite" ]; then command -v node >/dev/null 2>&1 || exit 22; node --no-warnings -e ' +
            shellQuote(OPENCLAW_SQLITE_COPY_SCRIPT) +
            ' "$root" .openclaw/state/openclaw.sqlite "$db_stage/modern" || exit 22; node --no-warnings -e ' +
            shellQuote(OPENCLAW_SQLITE_COPY_SCRIPT) +
            ' "$root" .openclaw-data/state/openclaw.sqlite "$db_stage/legacy" || exit 22; fi',
          // Expand hard links into independent file content without following
          // symbolic links; GNU tar's --hard-dereference is hard-link-only.
          `set -- tar -C "$root" --hard-dereference ${NATIVE_STATE_CAPTURE_TAR_EXCLUDES} '--transform=s|^modern$|./.openclaw/state/openclaw.sqlite|' '--transform=s|^legacy$|./.openclaw-data/state/openclaw.sqlite|' -cf - .`,
          '[ ! -f "$db_stage/modern" ] || set -- "$@" -C "$db_stage" modern',
          '[ ! -f "$db_stage/legacy" ] || set -- "$@" -C "$db_stage" legacy',
          '"$@"',
        ].join("; ");
        result = spawnSync(
          "bash",
          [
            "-o",
            "pipefail",
            "-c",
            '"$@" | head -c "$NEMOCLAW_NATIVE_CAPTURE_LIMIT_PLUS_ONE"',
            "nemoclaw-native-capture",
            "ssh",
            ...sshArgs(temporary.file, sandboxName),
            command,
          ],
          {
            env: {
              ...process.env,
              NEMOCLAW_NATIVE_CAPTURE_LIMIT_PLUS_ONE: String(maxBytes + 1),
            },
            stdio: ["ignore", archiveFd, "pipe"],
            timeout: captureTimeoutMs,
            maxBuffer: 1024 * 1024,
          },
        );
      }
    } catch (error) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native home/workspace capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      closeSync(archiveFd);
    }
    const archiveSize = statSync(archivePath).size;
    if (archiveSize > maxBytes) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native home/workspace capture exceeded the ${maxBytes}-byte backup-space limit. Free backup-disk space or reduce the native home, then retry.`,
      );
    }
    if (result.status !== 0 || result.error || result.signal || archiveSize === 0) {
      const detail =
        result.error?.message ??
        (result.signal
          ? `signal ${result.signal}`
          : result.stderr?.toString().trim() || `exit ${String(result.status)}`);
      rmSync(backupPath, { recursive: true, force: true });
      const changedDuringRead =
        !options.nativeStateSource &&
        result.status === 1 &&
        /file changed as we read it/iu.test(result.stderr?.toString() ?? "");
      return nativeStateFailure(
        changedDuringRead
          ? "Native home/workspace capture changed while it was read after quiescing; no backup was published. Retry after stopping the sandbox."
          : `Native home/workspace capture failed: ${detail.substring(0, 240)}`,
        !options.nativeStateSource && isSshTransportFailure(result),
      );
    }
    if (backupDeadlineExpired(options.deadlineMs)) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure("Native home/workspace capture exceeded the backup deadline");
    }
    // Reject sparse encodings with the bounded raw parser before invoking the
    // platform tar. GNU tar and bsdtar diagnose malformed or unsupported sparse
    // fixtures differently, but the security boundary must be deterministic.
    const rawArchiveViolation = nativeArchiveRawCredentialViolation(archivePath);
    if (rawArchiveViolation === "native state sparse archive entry") {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(`Native state archive validation failed: ${rawArchiveViolation}`);
    }
    const validation = validateTarEntries({ filePath: archivePath }, rootResult.root);
    if (!validation.safe) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native state archive validation failed: ${validation.violations.join("; ")}`,
      );
    }
    const symlinkTraversalViolations = rejectSymlinkExtractionTraversal(
      { filePath: archivePath },
      validation.entries,
    );
    if (symlinkTraversalViolations.length > 0) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native state archive validation failed: ${symlinkTraversalViolations.join("; ")}`,
      );
    }
    const hardLinkViolations = rejectHardLinks({ filePath: archivePath });
    if (hardLinkViolations.length > 0) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Native state archive validation failed: ${hardLinkViolations.join("; ")}`,
      );
    }
    const sanitationFailure = sanitizeMachineLocalArchiveConfig(archivePath);
    if (sanitationFailure) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(`Native state archive sanitation failed: ${sanitationFailure}`);
    }
    const credentialViolation = nativeArchiveCredentialViolation(archivePath, validation.entries);
    if (credentialViolation) {
      rmSync(backupPath, { recursive: true, force: true });
      return nativeStateFailure(
        `Rebuild was aborted because the native state archive contains credential-bearing or uninspectable content at '${credentialViolation}'. Move credentials to supported OpenShell credential storage and retry.`,
      );
    }
    if (backupDeadlineExpired(options.deadlineMs)) {
      if (!options.deferSanitizationDeadlineCleanup) {
        rmSync(backupPath, { recursive: true, force: true });
        return nativeStateFailure("Native archive validation exceeded the backup deadline");
      }
      const incompleteManifest: RebuildManifest = {
        version: MANIFEST_VERSION,
        sandboxName,
        timestamp,
        agentType: agentName,
        agentVersion: sandbox?.agentVersion || null,
        expectedVersion: agent.expectedVersion,
        nativeState: {
          root: rootResult.root,
          archive: NATIVE_STATE_ARCHIVE,
          sha256: sha256File(archivePath),
        },
        backupPath,
        blueprintDigest: computeBlueprintDigest(),
        backupComplete: false,
        ...authority,
      };
      writeManifest(backupPath, incompleteManifest);
      return {
        ...nativeStateFailure("Native archive validation exceeded the backup deadline"),
        manifest: incompleteManifest,
      };
    }

    const manifest: RebuildManifest = {
      version: MANIFEST_VERSION,
      sandboxName,
      timestamp,
      agentType: agentName,
      agentVersion: sandbox?.agentVersion || null,
      expectedVersion: agent.expectedVersion,
      nativeState: {
        root: rootResult.root,
        archive: NATIVE_STATE_ARCHIVE,
        sha256: sha256File(archivePath),
      },
      backupPath,
      blueprintDigest: computeBlueprintDigest(),
      backupComplete: options.deferCompletionPublication !== true,
      ...authority,
    };
    const publicationError = validateSnapshotPublication(backupPath, () => {
      if (backupDeadlineExpired(options.deadlineMs)) {
        throw new Error("sandbox backup deadline expired");
      }
      options.nativeStateSource?.assertCurrent();
      options.validateBeforePublish?.();
      if (backupDeadlineExpired(options.deadlineMs)) {
        throw new Error("sandbox backup deadline expired");
      }
    });
    if (publicationError) return nativeStateFailure(publicationError);
    try {
      writeManifest(backupPath, manifest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        rmSync(backupPath, { recursive: true, force: true });
      } catch (cleanupError) {
        return nativeStateFailure(
          `Could not publish the native home/workspace backup manifest: ${detail}. The incomplete backup remains at '${backupPath}' because cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      return nativeStateFailure(
        `Could not publish the native home/workspace backup manifest: ${detail}. The incomplete backup was removed.`,
      );
    }
    return {
      success: true,
      manifest,
      backedUpDirs: ["."],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
    };
  };
  return withSshCleanupResult(runWithTempSshConfigCleanup(() => temporary, capture));
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
    if (
      !manifest ||
      manifest.backupComplete === false ||
      path.resolve(manifest.backupPath) !== candidate
    )
      return null;
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
  if (
    !manifest?.nativeState ||
    manifest.version !== MANIFEST_VERSION ||
    manifest.backupComplete === false
  ) {
    return failure(
      "Backup does not contain a supported complete native home/workspace archive. Legacy selective backups require manual file recovery.",
    );
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
    const expectedRoot = manifest.nativeState.root;
    const restore = async (): Promise<RestoreResult> => {
      const rootResult = resolveNativeStateRoot(temporary.file, sandboxName, selectedEnv);
      if ("error" in rootResult) return failure(rootResult.error);
      if (rootResult.root !== expectedRoot) {
        return failure(
          `Backup native root '${expectedRoot}' does not match target root '${rootResult.root}'`,
        );
      }
      const mutationError = await validateSnapshotRestoreMutation(backupPath, options);
      if (mutationError) return failure(mutationError);

      const restoreScript = [
        "root=$1",
        '{ [ -d "$root" ] && [ ! -L "$root" ]; } || exit 20',
        'stage="$(mktemp -d "$root/.nemoclaw-native-restore.XXXXXX")"',
        "trap 'rm -rf -- \"$stage\"' EXIT HUP INT TERM",
        'tar --no-same-owner -xf - -C "$stage"',
        'if find "$stage" -type f -links +1 -print -quit | grep -q .; then echo "native restore archive contains a hard link" >&2; exit 21; fi',
        'mkdir -p -- "$stage/.nemoclaw" "$stage/.openclaw/agents/main/sessions" "$stage/.hermes/runtime"',
        'uid="$(id -u)"',
        "preserve_replacement_path() {",
        '  case "$1" in',
        "    .nemoclaw/config.json|.nemoclaw/blueprints|.openclaw/.nemoclaw-post-upgrade-doctor|.openclaw/agents/main/sessions/nemoclaw-onboard-warmup-*|.hermes/gateway.pid|.hermes/runtime/gateway.pid|.hermes/runtime/gateway.lock) return 0 ;;",
        "  esac",
        "  return 1",
        "}",
        "restore_dir() {",
        '  local source_dir="$1" target_dir="$2" target_item source_item name owner relative',
        '  for target_item in "$target_dir"/* "$target_dir"/.[!.]* "$target_dir"/..?*; do',
        '    { [ -e "$target_item" ] || [ -L "$target_item" ]; } || continue',
        '    [ "$target_item" = "$stage" ] && continue',
        '    name="${target_item##*/}"',
        '    source_item="$source_dir/$name"',
        '    relative="${target_item#"$root"/}"',
        '    if { [ ! -e "$source_item" ] && [ ! -L "$source_item" ]; }; then',
        '      preserve_replacement_path "$relative" && continue',
        '      owner="$(stat -c %u -- "$target_item")"',
        '      if [ "$owner" = "$uid" ] && [ -w "$target_dir" ]; then rm -rf -- "$target_item"; continue; fi',
        '      echo "native restore could not remove replacement-only state at: $target_item" >&2',
        "      exit 22",
        "    fi",
        '    owner="$(stat -c %u -- "$target_item")"',
        '    if [ -d "$target_item" ] && [ ! -L "$target_item" ] && [ -d "$source_item" ] && [ ! -L "$source_item" ]; then',
        '      restore_dir "$source_item" "$target_item"',
        '      rmdir -- "$source_item"',
        '    elif [ "$owner" = "$uid" ] && [ -w "$target_dir" ]; then',
        '      rm -rf -- "$target_item"',
        '    elif [ -f "$target_item" ] && [ ! -L "$target_item" ] && [ -f "$source_item" ] && [ ! -L "$source_item" ] && cmp -s -- "$source_item" "$target_item"; then',
        '      rm -f -- "$source_item"',
        '    elif [ -L "$target_item" ] && [ -L "$source_item" ] && [ "$(readlink -- "$source_item")" = "$(readlink -- "$target_item")" ]; then',
        '      rm -f -- "$source_item"',
        "    else",
        '      echo "native restore could not preserve archived state at: $target_item" >&2',
        "      exit 22",
        "    fi",
        "  done",
        '  for source_item in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do',
        '    { [ -e "$source_item" ] || [ -L "$source_item" ]; } || continue',
        '    if [ -w "$target_dir" ]; then',
        '      mv -- "$source_item" "$target_dir"/',
        "    else",
        '      echo "native restore could not preserve archived state below: $target_dir" >&2',
        "      exit 22",
        "    fi",
        "  done",
        "}",
        'restore_dir "$stage" "$root"',
      ].join("\n");
      // Restore the archive as the single agent-state source of truth. Keep
      // only the control-plane and generation-local paths excluded at capture;
      // replacement-only agent state is removed, while unsafe ownership or
      // writability conflicts fail instead of producing a mixed state tree.
      const command = `bash -ceu ${shellQuote(restoreScript)} -- ${shellQuote(rootResult.root)}`;
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
    };
    return withSshCleanupResult(await runWithTempSshConfigCleanupAsync(temporary, restore));
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

/** Persist a failed rebuild backup as nonselectable before bounded cleanup. */
export function markRebuildBackupIncomplete(manifest: RebuildManifest): RebuildManifest {
  const incomplete = { ...manifest, backupComplete: false };
  writeManifest(manifest.backupPath, incomplete);
  Object.assign(manifest, incomplete);
  return incomplete;
}

/** Publish a fully retained strict-recovery backup for restore selection. */
export function markRebuildBackupComplete(manifest: RebuildManifest): RebuildManifest {
  const complete = { ...manifest, backupComplete: true };
  writeManifest(manifest.backupPath, complete);
  Object.assign(manifest, complete);
  return complete;
}

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
  const next = {
    ...manifest,
    rebuildMcpHandoff: cloneRebuildMcpHandoff(handoff),
  };
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
      rebuildMcpHandoff: {
        ...cloneRebuildMcpHandoff(handoff),
        retired: true as const,
      },
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
    const manifest = parsed;
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

/**
 * Remove one completed rebuild backup without allowing a caller-controlled
 * path to escape the sandbox's timestamped backup directory.
 */
function removePathWithinDeadline(targetPath: string, deadlineMs?: number): boolean {
  if (deadlineMs === undefined) {
    rmSync(targetPath, { recursive: true, force: true });
  } else {
    const timeout = remainingBackupTimeoutMs(deadlineMs, 60_000);
    if (timeout === null) return false;
    const removal = spawnSync(
      process.execPath,
      ["-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", targetPath],
      {
        timeout,
        killSignal: "SIGKILL",
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      },
    );
    if (removal.status !== 0 || removal.error) return false;
  }
  return !existsSync(targetPath);
}

export function removeSandboxStateBackup(
  sandboxName: string,
  backupPath: string,
  deadlineMs?: number,
): boolean {
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
    return removePathWithinDeadline(candidateBackupPath, deadlineMs);
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
  if (persisted.backupComplete === false) {
    return { ok: false, reason: "latest backup is incomplete" };
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
      m.version === MANIFEST_VERSION &&
      m.nativeState !== undefined &&
      m.backupComplete !== false
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
