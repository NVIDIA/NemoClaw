// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import { isObjectRecord } from "../core/json-types";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../core/ports";
import { resolveGatewayPortFromName } from "../onboard/gateway-binding";
import {
  assertGatewayStatePathSafe,
  type GatewayRegistryDocument,
  type GatewayRegistryEntry,
  readGatewayRegistryFile,
  registryEntryGatewayPort,
} from "./gateway-registry";
import { nemoclawStateRoot, resolveHome } from "./state-root";

const MIGRATION_LOCK = ".gateway-state-migration.lock";
const MIGRATION_INTENT = ".gateway-state-migration";
const MIGRATION_INTENT_METADATA = "intent.json";
const MIGRATION_INTENT_SELECTED_REGISTRY = "selected-registry.json";
const MIGRATION_INTENT_REMAINING_REGISTRY = "remaining-registry.json";
const MIGRATION_INTENT_VERSION = 1;
const MIGRATION_LOCK_STALE_MS = 10_000;
const STALE_MIGRATION_INTENT_PATTERN =
  /^\.gateway-state-migration\.(?:preparing|completed)\.[1-9][0-9]*\.[1-9][0-9]*$/;
const MAX_MIGRATABLE_JSON_BYTES = 16 * 1024 * 1024;
const LEGACY_BUNDLE_ENTRIES = [
  "backups",
  "blueprints",
  "credentials.json",
  "model-router-venv",
  "mounts",
  "ollama-auth-proxy.pid",
  "ollama-proxy-token",
  "onboard-failures",
  "openrouter-runtime-adapter.pid",
  "state",
  "usage-notice.json",
] as const;
const SESSION_BOUND_ENTRIES = ["credentials.json"] as const;
type LegacyBundleEntry = (typeof LEGACY_BUNDLE_ENTRIES)[number];
const LEGACY_BUNDLE_ENTRY_SET: ReadonlySet<string> = new Set(LEGACY_BUNDLE_ENTRIES);

export interface LegacyPortMigrationResult {
  migratedSandboxNames: string[];
  migratedSession: boolean;
  warnings: string[];
}

interface LegacyPortMigrationIntentMetadata {
  version: typeof MIGRATION_INTENT_VERSION;
  gatewayPort: number;
  selectedSandboxNames: string[];
  sandboxBackupNames: string[];
  moveSession: boolean;
  bundleEntries: LegacyBundleEntry[];
  warnAmbiguousSession: boolean;
  rewriteLegacyRegistry: boolean;
}

interface LegacyPortMigrationIntent {
  intentDir: string;
  metadata: LegacyPortMigrationIntentMetadata;
  selectedRegistry: GatewayRegistryDocument;
  remainingRegistry: GatewayRegistryDocument | null;
}

function migrationError(message: string): Error {
  return new Error(`Cannot safely migrate legacy NemoClaw state for this gateway port: ${message}`);
}

function ensureRealDirectory(home: string, dir: string): void {
  assertGatewayStatePathSafe(home, dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertGatewayStatePathSafe(home, dir);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw migrationError(`${dir} is not a directory`);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJsonAtomic(home: string, filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  ensureRealDirectory(home, dir);
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw migrationError(`${filePath} is a symbolic link`);
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  const temp = `${filePath}.migration.${String(process.pid)}.${String(Date.now())}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filePath);
    fsyncDirectory(dir);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort after an interrupted atomic write.
    }
  }
}

function readJsonNoFollow(home: string, filePath: string): unknown | null {
  assertGatewayStatePathSafe(home, path.dirname(filePath));
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    if (noFollow === 0 && fs.lstatSync(filePath).isSymbolicLink()) {
      throw migrationError(`${filePath} is a symbolic link`);
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw migrationError(`${filePath} is not a regular file`);
    if (stat.size > MAX_MIGRATABLE_JSON_BYTES) {
      throw migrationError(
        `${filePath} exceeds the ${String(MAX_MIGRATABLE_JSON_BYTES)} byte migration limit`,
      );
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw migrationError(`${filePath} is not valid JSON`);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function firstSandboxName(sandboxes: Record<string, GatewayRegistryEntry>): string | null {
  return Object.keys(sandboxes).sort()[0] ?? null;
}

function registryWithSandboxes(
  source: GatewayRegistryDocument | null,
  sandboxes: Record<string, GatewayRegistryEntry>,
  preferredDefault: string | null,
): GatewayRegistryDocument {
  const defaultSandbox =
    preferredDefault && Object.hasOwn(sandboxes, preferredDefault)
      ? preferredDefault
      : firstSandboxName(sandboxes);
  return {
    ...(source ?? {}),
    defaultSandbox,
    sandboxes,
  };
}

function mergeSelectedRegistry(
  legacy: GatewayRegistryDocument | null,
  selectedEntries: Record<string, GatewayRegistryEntry>,
  existing: GatewayRegistryDocument | null,
  gatewayPort: number,
): GatewayRegistryDocument {
  const merged = { ...(existing?.sandboxes ?? {}) };
  for (const [name, entry] of Object.entries(selectedEntries)) {
    const existingEntry = merged[name];
    if (existingEntry && JSON.stringify(existingEntry) !== JSON.stringify(entry)) {
      throw migrationError(`sandbox ${JSON.stringify(name)} differs between legacy and port state`);
    }
    merged[name] = entry;
  }
  for (const entry of Object.values(merged)) {
    if (registryEntryGatewayPort(entry) !== gatewayPort) {
      throw migrationError(
        `${path.join(nemoclawStateRoot("~", gatewayPort), "sandboxes.json")} contains a sandbox for another gateway`,
      );
    }
  }
  const preferred =
    existing?.defaultSandbox && Object.hasOwn(merged, existing.defaultSandbox)
      ? existing.defaultSandbox
      : (legacy?.defaultSandbox ?? null);
  return registryWithSandboxes(existing ?? legacy, merged, preferred);
}

function sessionGatewayPort(
  session: unknown,
  registryPortsByName: ReadonlyMap<string, number>,
): number | null {
  if (!isObjectRecord(session)) throw migrationError("onboard-session.json is not an object");
  const metadata = session.metadata;
  const gatewayName = isObjectRecord(metadata) ? metadata.gatewayName : undefined;
  const sandboxName = typeof session.sandboxName === "string" ? session.sandboxName : null;
  const rowPort = sandboxName ? (registryPortsByName.get(sandboxName) ?? null) : null;

  if (gatewayName !== undefined && typeof gatewayName !== "string") {
    throw migrationError("onboard-session.json has an invalid gatewayName");
  }
  const metadataPort =
    typeof gatewayName === "string" ? resolveGatewayPortFromName(gatewayName) : null;
  if (typeof gatewayName === "string" && metadataPort === null) {
    throw migrationError("onboard-session.json has an unrecognized gatewayName");
  }
  if (metadataPort !== null && rowPort !== null && metadataPort !== rowPort) {
    throw migrationError("onboard-session.json conflicts with its sandbox registry row");
  }
  return metadataPort ?? rowPort;
}

function lstatNoFollow(home: string, target: string): fs.Stats | null {
  assertGatewayStatePathSafe(home, target);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw migrationError(`${target} is a symbolic link`);
    return stat;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function resumeMovePath(home: string, source: string, destination: string): void {
  const sourceStat = lstatNoFollow(home, source);
  const destinationStat = lstatNoFollow(home, destination);
  if (sourceStat && destinationStat) {
    throw migrationError(`${destination} already exists; refusing to overwrite it`);
  }
  if (!sourceStat && !destinationStat) {
    throw migrationError(`both ${source} and its migration destination ${destination} are missing`);
  }
  if (!sourceStat) return;
  ensureRealDirectory(home, path.dirname(destination));
  fs.renameSync(source, destination);
  fsyncDirectory(path.dirname(source));
  fsyncDirectory(path.dirname(destination));
}

function preflightMovePath(home: string, source: string, destination: string): boolean {
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(source);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
  if (sourceStat.isSymbolicLink()) throw migrationError(`${source} is a symbolic link`);
  assertGatewayStatePathSafe(home, source);
  assertGatewayStatePathSafe(home, destination);
  try {
    fs.lstatSync(destination);
    throw migrationError(`${destination} already exists; refusing to overwrite it`);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  fs.accessSync(path.dirname(source), fs.constants.W_OK);
  ensureRealDirectory(home, path.dirname(destination));
  return true;
}

function preflightSandboxBackups(
  home: string,
  sharedRoot: string,
  selectedRoot: string,
  sandboxNames: readonly string[],
): string[] {
  const existing: string[] = [];
  for (const sandboxName of sandboxNames) {
    if (
      preflightMovePath(
        home,
        path.join(sharedRoot, "rebuild-backups", sandboxName),
        path.join(selectedRoot, "rebuild-backups", sandboxName),
      )
    ) {
      existing.push(sandboxName);
    }
  }
  return existing;
}

function migrateSandboxBackups(
  home: string,
  sharedRoot: string,
  selectedRoot: string,
  sandboxNames: readonly string[],
): void {
  for (const sandboxName of sandboxNames) {
    resumeMovePath(
      home,
      path.join(sharedRoot, "rebuild-backups", sandboxName),
      path.join(selectedRoot, "rebuild-backups", sandboxName),
    );
  }
}

function parseUniqueStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw migrationError(`${label} is not a unique string array`);
  }
  return value as string[];
}

function readMigrationIntent(home: string, sharedRoot: string): LegacyPortMigrationIntent | null {
  const intentDir = path.join(sharedRoot, MIGRATION_INTENT);
  const intentStat = lstatNoFollow(home, intentDir);
  if (!intentStat) return null;
  if (!intentStat.isDirectory()) throw migrationError(`${intentDir} is not a directory`);

  const rawMetadata = readJsonNoFollow(home, path.join(intentDir, MIGRATION_INTENT_METADATA));
  if (!isObjectRecord(rawMetadata)) {
    throw migrationError(`${path.join(intentDir, MIGRATION_INTENT_METADATA)} is not an object`);
  }
  const gatewayPort = rawMetadata.gatewayPort;
  if (
    rawMetadata.version !== MIGRATION_INTENT_VERSION ||
    typeof gatewayPort !== "number" ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535 ||
    gatewayPort === DEFAULT_GATEWAY_PORT ||
    typeof rawMetadata.moveSession !== "boolean" ||
    typeof rawMetadata.warnAmbiguousSession !== "boolean" ||
    typeof rawMetadata.rewriteLegacyRegistry !== "boolean"
  ) {
    throw migrationError(`${path.join(intentDir, MIGRATION_INTENT_METADATA)} is invalid`);
  }

  const selectedSandboxNames = parseUniqueStringArray(
    rawMetadata.selectedSandboxNames,
    "migration intent selectedSandboxNames",
  );
  const sandboxBackupNames = parseUniqueStringArray(
    rawMetadata.sandboxBackupNames,
    "migration intent sandboxBackupNames",
  );
  const rawBundleEntries = parseUniqueStringArray(
    rawMetadata.bundleEntries,
    "migration intent bundleEntries",
  );
  if (
    rawMetadata.rewriteLegacyRegistry !== selectedSandboxNames.length > 0 ||
    (rawMetadata.moveSession && rawMetadata.warnAmbiguousSession) ||
    (selectedSandboxNames.length === 0 && !rawMetadata.moveSession)
  ) {
    throw migrationError("migration intent has inconsistent ownership metadata");
  }
  for (const entry of rawBundleEntries) {
    if (!LEGACY_BUNDLE_ENTRY_SET.has(entry)) {
      throw migrationError(`migration intent contains unsupported bundle entry ${entry}`);
    }
  }
  const selectedNameSet = new Set(selectedSandboxNames);
  for (const sandboxName of sandboxBackupNames) {
    if (!selectedNameSet.has(sandboxName)) {
      throw migrationError(`migration intent backup ${sandboxName} is not a selected sandbox`);
    }
  }

  const selectedRegistryFile = path.join(intentDir, MIGRATION_INTENT_SELECTED_REGISTRY);
  const selectedRegistry = readGatewayRegistryFile(home, selectedRegistryFile);
  if (!selectedRegistry) throw migrationError(`${selectedRegistryFile} is missing`);
  for (const entry of Object.values(selectedRegistry.sandboxes)) {
    if (registryEntryGatewayPort(entry) !== gatewayPort) {
      throw migrationError(`${selectedRegistryFile} contains a sandbox for another gateway`);
    }
  }
  for (const sandboxName of selectedSandboxNames) {
    if (!Object.hasOwn(selectedRegistry.sandboxes, sandboxName)) {
      throw migrationError(`${selectedRegistryFile} is missing selected sandbox ${sandboxName}`);
    }
  }

  let remainingRegistry: GatewayRegistryDocument | null = null;
  if (rawMetadata.rewriteLegacyRegistry) {
    const remainingRegistryFile = path.join(intentDir, MIGRATION_INTENT_REMAINING_REGISTRY);
    remainingRegistry = readGatewayRegistryFile(home, remainingRegistryFile);
    if (!remainingRegistry) throw migrationError(`${remainingRegistryFile} is missing`);
    for (const entry of Object.values(remainingRegistry.sandboxes)) {
      if (registryEntryGatewayPort(entry) === gatewayPort) {
        throw migrationError(`${remainingRegistryFile} still contains a selected gateway sandbox`);
      }
    }
    for (const sandboxName of selectedSandboxNames) {
      if (Object.hasOwn(remainingRegistry.sandboxes, sandboxName)) {
        throw migrationError(
          `${remainingRegistryFile} still contains selected sandbox ${sandboxName}`,
        );
      }
    }
  }

  return {
    intentDir,
    metadata: {
      version: MIGRATION_INTENT_VERSION,
      gatewayPort,
      selectedSandboxNames,
      sandboxBackupNames,
      moveSession: rawMetadata.moveSession,
      bundleEntries: rawBundleEntries as LegacyBundleEntry[],
      warnAmbiguousSession: rawMetadata.warnAmbiguousSession,
      rewriteLegacyRegistry: rawMetadata.rewriteLegacyRegistry,
    },
    selectedRegistry,
    remainingRegistry,
  };
}

function createMigrationIntent(
  home: string,
  sharedRoot: string,
  metadata: LegacyPortMigrationIntentMetadata,
  selectedRegistry: GatewayRegistryDocument,
  remainingRegistry: GatewayRegistryDocument | null,
): LegacyPortMigrationIntent {
  const intentDir = path.join(sharedRoot, MIGRATION_INTENT);
  if (lstatNoFollow(home, intentDir)) {
    throw migrationError(
      `${intentDir} already exists; resume it before starting another migration`,
    );
  }
  if (metadata.rewriteLegacyRegistry && !remainingRegistry) {
    throw migrationError("migration intent is missing its remaining legacy registry");
  }

  ensureRealDirectory(home, sharedRoot);
  const preparingDir = `${intentDir}.preparing.${String(process.pid)}.${String(Date.now())}`;
  assertGatewayStatePathSafe(home, preparingDir);
  fs.mkdirSync(preparingDir, { mode: 0o700 });
  try {
    writeJsonAtomic(home, path.join(preparingDir, MIGRATION_INTENT_METADATA), metadata);
    writeJsonAtomic(
      home,
      path.join(preparingDir, MIGRATION_INTENT_SELECTED_REGISTRY),
      selectedRegistry,
    );
    if (remainingRegistry) {
      writeJsonAtomic(
        home,
        path.join(preparingDir, MIGRATION_INTENT_REMAINING_REGISTRY),
        remainingRegistry,
      );
    }
    fsyncDirectory(preparingDir);
    fs.renameSync(preparingDir, intentDir);
    fsyncDirectory(sharedRoot);
  } finally {
    fs.rmSync(preparingDir, { recursive: true, force: true });
  }

  const intent = readMigrationIntent(home, sharedRoot);
  if (!intent) throw migrationError(`failed to publish ${intentDir}`);
  return intent;
}

function removeMigrationIntent(home: string, sharedRoot: string, intentDir: string): void {
  const completedDir = `${intentDir}.completed.${String(process.pid)}.${String(Date.now())}`;
  assertGatewayStatePathSafe(home, completedDir);
  fs.renameSync(intentDir, completedDir);
  fsyncDirectory(sharedRoot);
  fs.rmSync(completedDir, { recursive: true, force: true });
  fsyncDirectory(sharedRoot);
}

function staleMigrationIntentNames(home: string, sharedRoot: string): string[] {
  const rootStat = lstatNoFollow(home, sharedRoot);
  if (!rootStat) return [];
  if (!rootStat.isDirectory()) throw migrationError(`${sharedRoot} is not a directory`);
  return fs
    .readdirSync(sharedRoot)
    .filter((name) => STALE_MIGRATION_INTENT_PATTERN.test(name))
    .sort();
}

function removeStaleMigrationIntentDirectories(home: string, sharedRoot: string): void {
  const staleNames = staleMigrationIntentNames(home, sharedRoot);
  for (const name of staleNames) {
    const candidate = path.join(sharedRoot, name);
    const stat = lstatNoFollow(home, candidate);
    if (!stat?.isDirectory()) {
      throw migrationError(`${candidate} is not a directory`);
    }
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  if (staleNames.length > 0) fsyncDirectory(sharedRoot);
}

function applyMigrationIntent(
  home: string,
  sharedRoot: string,
  selectedRoot: string,
  legacyRegistryFile: string,
  selectedRegistryFile: string,
  intent: LegacyPortMigrationIntent,
): LegacyPortMigrationResult {
  const result: LegacyPortMigrationResult = {
    migratedSandboxNames: [...intent.metadata.selectedSandboxNames],
    migratedSession: intent.metadata.moveSession,
    warnings: [],
  };

  if (intent.metadata.rewriteLegacyRegistry) {
    if (!intent.remainingRegistry) {
      throw migrationError("migration intent is missing its remaining legacy registry");
    }
    writeJsonAtomic(home, legacyRegistryFile, intent.remainingRegistry);
  }

  migrateSandboxBackups(home, sharedRoot, selectedRoot, intent.metadata.sandboxBackupNames);
  if (intent.metadata.moveSession) {
    resumeMovePath(
      home,
      path.join(sharedRoot, "onboard-session.json"),
      path.join(selectedRoot, "onboard-session.json"),
    );
  } else if (intent.metadata.warnAmbiguousSession) {
    result.warnings.push(
      `Left ambiguous ${path.join(sharedRoot, "onboard-session.json")} in place because it has no recorded gateway identity.`,
    );
  }

  for (const entry of intent.metadata.bundleEntries) {
    resumeMovePath(home, path.join(sharedRoot, entry), path.join(selectedRoot, entry));
  }

  const movedEntries = new Set<LegacyBundleEntry>(intent.metadata.bundleEntries);
  const entriesLeftAmbiguous = LEGACY_BUNDLE_ENTRIES.filter(
    (entry) => !movedEntries.has(entry) && lstatNoFollow(home, path.join(sharedRoot, entry)),
  );
  if (intent.metadata.selectedSandboxNames.length > 0 && entriesLeftAmbiguous.length > 0) {
    result.warnings.push(
      `Left ambiguous legacy state under ${sharedRoot}: ${entriesLeftAmbiguous.join(", ")}. Review ownership before migrating or removing it; NemoClaw did not copy it into ${selectedRoot}.`,
    );
  }

  writeJsonAtomic(home, selectedRegistryFile, intent.selectedRegistry);
  removeMigrationIntent(home, sharedRoot, intent.intentDir);
  return result;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

function existingLockIsStale(home: string, lock: string): boolean {
  const stat = lstatNoFollow(home, lock);
  if (!stat) return true;
  if (!stat.isDirectory()) throw migrationError(`${lock} is not a directory`);

  let ownerPid: number | null = null;
  try {
    const ownerFile = path.join(lock, "owner");
    const ownerStat = lstatNoFollow(home, ownerFile);
    if (ownerStat?.isFile()) {
      const parsed = Number.parseInt(fs.readFileSync(ownerFile, "utf8").trim(), 10);
      ownerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  if (ownerPid !== null) return !isProcessAlive(ownerPid);
  return Date.now() - stat.mtimeMs > MIGRATION_LOCK_STALE_MS;
}

function acquireDirectoryLock(home: string, lock: string): string {
  const parent = path.dirname(lock);
  ensureRealDirectory(home, parent);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(lock, "owner"), String(process.pid), { mode: 0o600 });
        fsyncDirectory(lock);
        fsyncDirectory(parent);
        return lock;
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      if (attempt === 0 && existingLockIsStale(home, lock)) {
        fs.rmSync(lock, { recursive: true, force: true });
        fsyncDirectory(parent);
        continue;
      }
      throw migrationError(`another state operation owns ${lock}; retry after it completes`);
    }
  }
  throw migrationError(`could not acquire ${lock}`);
}

/**
 * Partition pre-segregation state into the selected non-default gateway root.
 * Registry rows move only when their persisted canonical gateway identity is
 * unambiguous. Singleton state moves only when the session (or the entire
 * legacy registry) proves that it belongs to the selected gateway.
 */
export function migrateLegacyPortState(
  options: { gatewayPort?: number; home?: string } = {},
): LegacyPortMigrationResult {
  const gatewayPort = options.gatewayPort ?? GATEWAY_PORT;
  const home = path.resolve(options.home || resolveHome());
  const result: LegacyPortMigrationResult = {
    migratedSandboxNames: [],
    migratedSession: false,
    warnings: [],
  };
  const sharedRoot = nemoclawStateRoot(home, DEFAULT_GATEWAY_PORT);
  const legacyRegistryFile = path.join(sharedRoot, "sandboxes.json");
  const migrationLock = path.join(sharedRoot, MIGRATION_LOCK);
  const pendingBeforeLock = readMigrationIntent(home, sharedRoot);
  const staleIntentDirectoriesExist = staleMigrationIntentNames(home, sharedRoot).length > 0;

  if (gatewayPort === DEFAULT_GATEWAY_PORT) {
    if (pendingBeforeLock) {
      throw migrationError(
        `a recoverable migration for gateway port ${String(pendingBeforeLock.metadata.gatewayPort)} is pending; rerun a stateful command with NEMOCLAW_GATEWAY_PORT=${String(pendingBeforeLock.metadata.gatewayPort)} before using the default gateway`,
      );
    }
    if (lstatNoFollow(home, migrationLock)) {
      if (existingLockIsStale(home, migrationLock)) {
        fs.rmSync(migrationLock, { recursive: true, force: true });
        fsyncDirectory(sharedRoot);
      } else {
        throw migrationError(
          "another gateway-state migration is in progress; retry after it completes",
        );
      }
    }
    if (staleIntentDirectoriesExist) {
      const lock = acquireDirectoryLock(home, migrationLock);
      try {
        removeStaleMigrationIntentDirectories(home, sharedRoot);
      } finally {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    }
    return result;
  }

  const selectedRoot = nemoclawStateRoot(home, gatewayPort);
  const selectedRegistryFile = path.join(selectedRoot, "sandboxes.json");
  const legacyRegistry = readGatewayRegistryFile(home, legacyRegistryFile);
  const legacySessionFile = path.join(sharedRoot, "onboard-session.json");
  const legacySession = readJsonNoFollow(home, legacySessionFile);
  if (
    !pendingBeforeLock &&
    !legacyRegistry &&
    legacySession === null &&
    !staleIntentDirectoriesExist
  ) {
    return result;
  }

  const lock = acquireDirectoryLock(home, migrationLock);
  const registryLocks: string[] = [];
  try {
    removeStaleMigrationIntentDirectories(home, sharedRoot);
    registryLocks.push(acquireDirectoryLock(home, `${legacyRegistryFile}.lock`));
    const pendingIntent = readMigrationIntent(home, sharedRoot);
    if (pendingIntent) {
      if (pendingIntent.metadata.gatewayPort !== gatewayPort) {
        throw migrationError(
          `a recoverable migration for gateway port ${String(pendingIntent.metadata.gatewayPort)} is pending; rerun with NEMOCLAW_GATEWAY_PORT=${String(pendingIntent.metadata.gatewayPort)}`,
        );
      }
      registryLocks.push(acquireDirectoryLock(home, `${selectedRegistryFile}.lock`));
      return applyMigrationIntent(
        home,
        sharedRoot,
        selectedRoot,
        legacyRegistryFile,
        selectedRegistryFile,
        pendingIntent,
      );
    }

    // Re-read under the shared lock so classification and writes use one view.
    const currentLegacy = readGatewayRegistryFile(home, legacyRegistryFile);
    const registryPortsByName = new Map<string, number>();
    const selectedEntries: Record<string, GatewayRegistryEntry> = {};
    const remainingEntries: Record<string, GatewayRegistryEntry> = {};
    for (const [name, entry] of Object.entries(currentLegacy?.sandboxes ?? {})) {
      const rowPort = registryEntryGatewayPort(entry);
      registryPortsByName.set(name, rowPort);
      if (rowPort === gatewayPort) selectedEntries[name] = entry;
      else remainingEntries[name] = entry;
    }

    const session = readJsonNoFollow(home, legacySessionFile);
    const recordedSessionPort =
      session === null ? null : sessionGatewayPort(session, registryPortsByName);
    const selectedNames = Object.keys(selectedEntries).sort();
    const sessionBelongsToSelected = recordedSessionPort === gatewayPort;
    const wholeLegacyBundleBelongsToSelected =
      selectedNames.length > 0 &&
      Object.keys(remainingEntries).length === 0 &&
      (session === null || sessionBelongsToSelected);

    if (selectedNames.length === 0 && !sessionBelongsToSelected) return result;

    const entriesToMove: readonly LegacyBundleEntry[] = wholeLegacyBundleBelongsToSelected
      ? LEGACY_BUNDLE_ENTRIES
      : sessionBelongsToSelected
        ? SESSION_BOUND_ENTRIES
        : [];
    let moveSession = false;
    if (sessionBelongsToSelected) {
      const activeLock = path.join(sharedRoot, "onboard.lock");
      if (lstatNoFollow(home, activeLock)) {
        throw migrationError(
          `legacy onboarding lock ${activeLock} is present; finish or stop that run first`,
        );
      }
      moveSession = preflightMovePath(
        home,
        legacySessionFile,
        path.join(selectedRoot, "onboard-session.json"),
      );
    }
    const sandboxBackupNames = preflightSandboxBackups(
      home,
      sharedRoot,
      selectedRoot,
      selectedNames,
    );
    const bundleEntries: LegacyBundleEntry[] = [];
    for (const entry of entriesToMove) {
      if (preflightMovePath(home, path.join(sharedRoot, entry), path.join(selectedRoot, entry))) {
        bundleEntries.push(entry);
      }
    }

    registryLocks.push(acquireDirectoryLock(home, `${selectedRegistryFile}.lock`));
    const existingSelected = readGatewayRegistryFile(home, selectedRegistryFile);
    const selectedRegistry = mergeSelectedRegistry(
      currentLegacy,
      selectedEntries,
      existingSelected,
      gatewayPort,
    );
    const remainingRegistry =
      currentLegacy && selectedNames.length > 0
        ? registryWithSandboxes(currentLegacy, remainingEntries, currentLegacy.defaultSandbox)
        : null;
    const intent = createMigrationIntent(
      home,
      sharedRoot,
      {
        version: MIGRATION_INTENT_VERSION,
        gatewayPort,
        selectedSandboxNames: selectedNames,
        sandboxBackupNames,
        moveSession,
        bundleEntries,
        warnAmbiguousSession:
          session !== null && recordedSessionPort === null && selectedNames.length > 0,
        rewriteLegacyRegistry: remainingRegistry !== null,
      },
      selectedRegistry,
      remainingRegistry,
    );
    return applyMigrationIntent(
      home,
      sharedRoot,
      selectedRoot,
      legacyRegistryFile,
      selectedRegistryFile,
      intent,
    );
  } finally {
    for (const registryLock of registryLocks.reverse()) {
      fs.rmSync(registryLock, { recursive: true, force: true });
    }
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
