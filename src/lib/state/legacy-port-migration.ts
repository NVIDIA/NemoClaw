// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { isErrnoException } from "../core/errno";
import { isObjectRecord } from "../core/json-types";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../core/ports";
import {
  openRegularFileNoFollow,
  type OpenRegularFile,
} from "../adapters/fs/regular-file";
import { resolveGatewayPortFromName } from "../onboard/gateway-binding";
import {
  assertGatewayStatePathSafe,
  type GatewayRegistryDocument,
  type GatewayRegistryEntry,
  readGatewayRegistryFile,
  registryEntryGatewayPort,
} from "./gateway-registry";
import {
  classifyOnboardLockContents,
  createOnboardLockRecord,
  listRetainedSandboxRecoveryRecords,
  MAX_ONBOARD_LOCK_BYTES,
  retainedSandboxRecoveryFile,
  type OnboardLockDisposition,
  type OnboardLockRecord,
  type RetainedSandboxRecoveryRecord,
} from "./onboard-session/index";
import {
  reclaimLockFileGenerationSync,
  type LockFileGeneration,
} from "./lock-generation/storage";
import { nemoclawStateRoot, resolveHome } from "./state-root";

const MIGRATION_LOCK = ".gateway-state-migration.lock";
const MIGRATION_INTENT = ".gateway-state-migration";
const MIGRATION_INTENT_METADATA = "intent.json";
const MIGRATION_INTENT_REMAINING_RECOVERY = "remaining-retained-sandbox-recovery.json";
const MIGRATION_INTENT_SELECTED_REGISTRY = "selected-registry.json";
const MIGRATION_INTENT_SELECTED_RECOVERY = "selected-retained-sandbox-recovery.json";
const MIGRATION_INTENT_REMAINING_REGISTRY = "remaining-registry.json";
const MIGRATION_INTENT_VERSION = 1;
const MAX_MIGRATION_LOCK_BYTES = 4 * 1024;
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
  "ollama-proxy-port",
  "ollama-proxy-token",
  "onboard-failures",
  "openrouter-runtime-adapter.pid",
  "state",
  "usage-notice.json",
] as const;
const SESSION_BOUND_ENTRIES = ["credentials.json"] as const;
const HOST_SHARED_BUNDLE_ENTRIES = [
  "ollama-auth-proxy.pid",
  "ollama-proxy-port",
  "ollama-proxy-token",
] as const;
type LegacyBundleEntry = (typeof LEGACY_BUNDLE_ENTRIES)[number];
const LEGACY_BUNDLE_ENTRY_SET: ReadonlySet<string> = new Set(LEGACY_BUNDLE_ENTRIES);
const HOST_SHARED_BUNDLE_ENTRY_SET: ReadonlySet<string> = new Set(HOST_SHARED_BUNDLE_ENTRIES);
const MIGRATABLE_BUNDLE_ENTRIES: readonly LegacyBundleEntry[] = LEGACY_BUNDLE_ENTRIES.filter(
  (entry) => !HOST_SHARED_BUNDLE_ENTRY_SET.has(entry),
);

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
  selectedRecovery: RetainedRecoveryDocument | null;
  remainingRecovery: RetainedRecoveryDocument | null;
}

interface RetainedRecoveryDocument {
  schemaVersion: 1;
  unresolved: readonly RetainedSandboxRecoveryRecord[];
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

function retainedRecoveryDocument(
  records: readonly RetainedSandboxRecoveryRecord[],
): RetainedRecoveryDocument {
  return { schemaVersion: 1, unresolved: records };
}

function readRetainedRecoveryDocument(
  home: string,
  filePath: string,
): RetainedRecoveryDocument | null {
  if (!lstatNoFollow(home, filePath)) return null;
  let records: readonly RetainedSandboxRecoveryRecord[];
  try {
    records = listRetainedSandboxRecoveryRecords(filePath);
  } catch (error) {
    throw migrationError(
      `${filePath} is not valid retained sandbox recovery state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const record of records) {
    const gatewayPort = resolveGatewayPortFromName(record.gatewayName);
    if (gatewayPort === null || gatewayPort !== record.gatewayPort) {
      throw migrationError(
        `${filePath} record ${record.recordId} has conflicting gateway identity`,
      );
    }
  }
  return retainedRecoveryDocument(records);
}

function removeRetainedRecoveryFile(home: string, filePath: string): void {
  const stat = lstatNoFollow(home, filePath);
  if (!stat) return;
  if (!stat.isFile()) throw migrationError(`${filePath} is not a regular file`);
  fs.rmSync(filePath);
  fsyncDirectory(path.dirname(filePath));
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
  const selectedRecovery = readRetainedRecoveryDocument(
    home,
    path.join(intentDir, MIGRATION_INTENT_SELECTED_RECOVERY),
  );
  const remainingRecovery = readRetainedRecoveryDocument(
    home,
    path.join(intentDir, MIGRATION_INTENT_REMAINING_RECOVERY),
  );
  if (
    rawMetadata.rewriteLegacyRegistry !== selectedSandboxNames.length > 0 ||
    (rawMetadata.moveSession && rawMetadata.warnAmbiguousSession) ||
    (selectedSandboxNames.length === 0 && !rawMetadata.moveSession && !selectedRecovery) ||
    (selectedRecovery === null) !== (remainingRecovery === null)
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
  if (
    selectedRecovery?.unresolved.length === 0 ||
    selectedRecovery?.unresolved.some((record) => record.gatewayPort !== gatewayPort) ||
    remainingRecovery?.unresolved.some((record) => record.gatewayPort === gatewayPort)
  ) {
    throw migrationError("migration intent has inconsistent retained recovery ownership");
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
  if (
    selectedRecovery === null &&
    readRetainedRecoveryDocument(home, retainedSandboxRecoveryFile(sharedRoot))?.unresolved.some(
      (record) => record.gatewayPort === gatewayPort,
    )
  ) {
    throw migrationError(
      "published migration intent predates retained recovery partitioning; retained recovery remains safely in the shared root",
    );
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
    selectedRecovery,
    remainingRecovery,
  };
}

function createMigrationIntent(
  home: string,
  sharedRoot: string,
  metadata: LegacyPortMigrationIntentMetadata,
  selectedRegistry: GatewayRegistryDocument,
  remainingRegistry: GatewayRegistryDocument | null,
  selectedRecovery: RetainedRecoveryDocument | null,
  remainingRecovery: RetainedRecoveryDocument | null,
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
  if ((selectedRecovery === null) !== (remainingRecovery === null)) {
    throw migrationError("migration intent is missing its retained recovery partition");
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
    if (selectedRecovery && remainingRecovery) {
      writeJsonAtomic(
        home,
        path.join(preparingDir, MIGRATION_INTENT_SELECTED_RECOVERY),
        selectedRecovery,
      );
      writeJsonAtomic(
        home,
        path.join(preparingDir, MIGRATION_INTENT_REMAINING_RECOVERY),
        remainingRecovery,
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

  if (intent.selectedRecovery && intent.remainingRecovery) {
    writeJsonAtomic(home, retainedSandboxRecoveryFile(selectedRoot), intent.selectedRecovery);
    if (intent.remainingRecovery.unresolved.length > 0) {
      writeJsonAtomic(home, retainedSandboxRecoveryFile(sharedRoot), intent.remainingRecovery);
    } else {
      removeRetainedRecoveryFile(home, retainedSandboxRecoveryFile(sharedRoot));
    }
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
  const entriesLeftAmbiguous = MIGRATABLE_BUNDLE_ENTRIES.filter(
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

interface MigrationLockHandle {
  readonly file: OpenRegularFile;
  readonly generation: LockFileGeneration;
  readonly path: string;
}

function lockFileGeneration(file: OpenRegularFile): LockFileGeneration {
  const stat = file.stat();
  return { dev: stat.dev, ino: stat.ino, reclaimable: stat.isFile() };
}

function observeMigrationLockFile(
  lock: string,
): { disposition: OnboardLockDisposition; generation: LockFileGeneration } | null {
  let file: OpenRegularFile;
  try {
    file = openRegularFileNoFollow(lock);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const contents = file.readBytes(MAX_MIGRATION_LOCK_BYTES).toString("utf8");
    const stat = file.stat();
    return {
      disposition: classifyOnboardLockContents(contents, stat.mtimeMs),
      generation: { dev: stat.dev, ino: stat.ino, reclaimable: stat.isFile() },
    };
  } finally {
    file.close();
  }
}

function releaseMigrationLock(lock: MigrationLockHandle): void {
  lock.file.close();
  if (!reclaimLockFileGenerationSync(lock.path, lock.generation)) {
    throw migrationError(`migration lock ${lock.path} changed ownership before release`);
  }
  fsyncDirectory(path.dirname(lock.path));
}

function acquireMigrationLock(home: string, lock: string): MigrationLockHandle {
  const parent = path.dirname(lock);
  ensureRealDirectory(home, parent);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let file: OpenRegularFile;
    try {
      file = openRegularFileNoFollow(lock, { create: true, mode: 0o600, writable: true });
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const stat = lstatNoFollow(home, lock);
      if (stat === null) continue;
      if (stat.isDirectory()) {
        // Retirement: https://github.com/NVIDIA/NemoClaw/issues/10893. Remove
        // this fail-closed directory compatibility path once the minimum
        // supported direct-upgrade source release includes #10845.
        throw migrationError(`another state operation owns ${lock}; retry after it completes`);
      }
      if (attempt === 0 && stat.isFile()) {
        const observed = observeMigrationLockFile(lock);
        if (
          observed?.disposition.state === "stale" &&
          reclaimLockFileGenerationSync(lock, observed.generation)
        ) {
          fsyncDirectory(parent);
          continue;
        }
      }
      throw migrationError(`another state operation owns ${lock}; retry after it completes`);
    }

    let generation: LockFileGeneration | null = null;
    try {
      generation = lockFileGeneration(file);
      file.replaceUtf8(
        `${JSON.stringify(
          createOnboardLockRecord("nemoclaw gateway-state migration", new Date().toISOString()),
        )}\n`,
        0o600,
      );
      fsyncDirectory(parent);
      return { file, generation, path: lock };
    } catch (error) {
      file.close();
      if (generation !== null) reclaimLockFileGenerationSync(lock, generation);
      throw error;
    }
  }
  throw migrationError(`could not acquire ${lock}`);
}

function releaseMigrationStateLocks(
  migrationLock: MigrationLockHandle,
  registryLocks: readonly MigrationLockHandle[],
): void {
  let releaseError: unknown;
  for (const registryLock of [...registryLocks].reverse()) {
    try {
      releaseMigrationLock(registryLock);
    } catch (error) {
      releaseError ??= error;
    }
  }
  try {
    releaseMigrationLock(migrationLock);
  } catch (error) {
    releaseError ??= error;
  }
  if (releaseError !== undefined) throw releaseError;
}

type ObservedOnboardLockDisposition =
  | { readonly state: "clear" }
  | Exclude<OnboardLockDisposition, { readonly state: "stale" }>;

/**
 * Use the recorded holder because an interrupted run can leave a stale lock.
 * Treat an owner-less lock as active during its grace period because its writer
 * can still be updating it. Do not unlink stale locks here: the onboarding
 * writer verifies the inode before removal.
 */
function classifyOnboardLock(home: string, activeLock: string): ObservedOnboardLockDisposition {
  const stat = lstatNoFollow(home, activeLock);
  if (!stat) return { state: "clear" };
  if (!stat.isFile()) throw migrationError(`${activeLock} is not a regular file`);

  let lockFile;
  try {
    lockFile = openRegularFileNoFollow(activeLock);
  } catch (error) {
    // The writer released the lock between the stat above and this open.
    if (isErrnoException(error) && error.code === "ENOENT") return { state: "clear" };
    throw error;
  }
  let contents: string | null = null;
  let writtenAtMs: number | null = null;
  try {
    const beforeRead = lockFile.stat();
    const bytes = lockFile.readBytes(MAX_ONBOARD_LOCK_BYTES);
    const afterRead = lockFile.stat();
    if (
      beforeRead.size !== afterRead.size ||
      beforeRead.mtimeMs !== afterRead.mtimeMs ||
      beforeRead.ctimeMs !== afterRead.ctimeMs
    ) {
      return { state: "settling" };
    }
    writtenAtMs = afterRead.mtimeMs;
    contents = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof RangeError) {
      throw migrationError(
        `${activeLock} exceeds the ${String(MAX_ONBOARD_LOCK_BYTES)} byte onboarding lock limit`,
      );
    } else if (
      (isErrnoException(error) && error.code === "ENOENT") ||
      (error instanceof Error &&
        (error.message.startsWith("regular file changed") ||
          error.message.startsWith("short read from regular file")))
    ) {
      return { state: "settling" };
    } else {
      throw error;
    }
  } finally {
    lockFile.close();
  }

  if (writtenAtMs === null || contents === null) return { state: "settling" };
  const disposition = classifyOnboardLockContents(contents, writtenAtMs);
  return disposition.state === "stale" ? { state: "clear" } : disposition;
}

function describeOnboardLockHolder(record: OnboardLockRecord): string {
  const details = [
    record.command === null ? "" : `command ${JSON.stringify(record.command)}`,
    record.startedAt === null ? "" : `started ${record.startedAt}`,
  ].filter((detail) => detail !== "");
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

function assertOnboardStateUnlocked(home: string, stateRoots: readonly string[]): void {
  for (const stateRoot of stateRoots) {
    const activeLock = path.join(stateRoot, "onboard.lock");
    const disposition = classifyOnboardLock(home, activeLock);
    if (disposition.state === "held") {
      if (disposition.provenance !== "local") {
        const record = disposition.record;
        const recordedEnvironment = [
          record.hostIdentity === null
            ? null
            : `host ${JSON.stringify(record.hostIdentity)}`,
          record.pidNamespaceIdentity === null
            ? null
            : `PID namespace ${JSON.stringify(record.pidNamespaceIdentity)}`,
        ]
          .filter((detail): detail is string => detail !== null)
          .join(", ");
        const provenanceReason =
          disposition.provenance === "foreign"
            ? `belongs to a different environment${recordedEnvironment ? ` (${recordedEnvironment})` : ""}`
            : "has no verifiable host and PID-namespace provenance";
        throw migrationError(
          `onboarding lock ${activeLock} records PID ${String(record.pid)}` +
            `${describeOnboardLockHolder(record)} and ${provenanceReason}; verify in every ` +
            "environment sharing this state directory that no onboarding run is active, and " +
            "remove only this lock file if none is active, then retry",
        );
      }
      if (!disposition.identityVerified) {
        throw migrationError(
          `onboarding lock ${activeLock} records live PID ` +
            `${String(disposition.record.pid)}${describeOnboardLockHolder(disposition.record)}, ` +
            "but no process-start identity verifies that it is still the owner; verify no " +
            "onboarding run is active, and if none is active remove only this lock file, then retry",
        );
      }
      throw migrationError(
        `onboarding lock ${activeLock} is held by running process ` +
          `${String(disposition.record.pid)}${describeOnboardLockHolder(disposition.record)}; ` +
          "wait for that run to finish or stop that process, then retry",
      );
    }
    if (disposition.state === "settling") {
      throw migrationError(
        `onboarding lock ${activeLock} has no valid owner record; retry after 30 seconds`,
      );
    }
  }
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
    if (lstatNoFollow(home, migrationLock) || staleIntentDirectoriesExist) {
      const lock = acquireMigrationLock(home, migrationLock);
      try {
        if (staleIntentDirectoriesExist) {
          assertOnboardStateUnlocked(home, [sharedRoot]);
          removeStaleMigrationIntentDirectories(home, sharedRoot);
        }
      } finally {
        releaseMigrationLock(lock);
      }
    }
    return result;
  }

  const selectedRoot = nemoclawStateRoot(home, gatewayPort);
  const selectedRegistryFile = path.join(selectedRoot, "sandboxes.json");
  const legacyRegistry = readGatewayRegistryFile(home, legacyRegistryFile);
  const legacySessionFile = path.join(sharedRoot, "onboard-session.json");
  const legacySession = readJsonNoFollow(home, legacySessionFile);
  const legacyRecoveryFile = retainedSandboxRecoveryFile(sharedRoot);
  const legacyRecoveryExists = lstatNoFollow(home, legacyRecoveryFile) !== null;
  if (
    !pendingBeforeLock &&
    !legacyRegistry &&
    legacySession === null &&
    !legacyRecoveryExists &&
    !staleIntentDirectoriesExist
  ) {
    return result;
  }

  const lock = acquireMigrationLock(home, migrationLock);
  const registryLocks: MigrationLockHandle[] = [];
  try {
    // Onboard writers recheck the migration lock after claiming onboard.lock.
    // Checking both roots while this lock is held closes the opposite side of
    // the handshake and serializes session/recovery state with partitioning.
    assertOnboardStateUnlocked(home, [sharedRoot, selectedRoot]);
    removeStaleMigrationIntentDirectories(home, sharedRoot);
    registryLocks.push(acquireMigrationLock(home, `${legacyRegistryFile}.lock`));
    const pendingIntent = readMigrationIntent(home, sharedRoot);
    if (pendingIntent) {
      if (pendingIntent.metadata.gatewayPort !== gatewayPort) {
        throw migrationError(
          `a recoverable migration for gateway port ${String(pendingIntent.metadata.gatewayPort)} is pending; rerun with NEMOCLAW_GATEWAY_PORT=${String(pendingIntent.metadata.gatewayPort)}`,
        );
      }
      registryLocks.push(acquireMigrationLock(home, `${selectedRegistryFile}.lock`));
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
    const recovery = readRetainedRecoveryDocument(home, legacyRecoveryFile);
    const selectedRecoveryRecords =
      recovery?.unresolved.filter((record) => record.gatewayPort === gatewayPort) ?? [];
    const remainingRecoveryRecords =
      recovery?.unresolved.filter((record) => record.gatewayPort !== gatewayPort) ?? [];
    const selectedRecovery =
      selectedRecoveryRecords.length > 0 ? retainedRecoveryDocument(selectedRecoveryRecords) : null;
    const remainingRecovery = selectedRecovery
      ? retainedRecoveryDocument(remainingRecoveryRecords)
      : null;
    const recordedSessionPort =
      session === null ? null : sessionGatewayPort(session, registryPortsByName);
    const selectedNames = Object.keys(selectedEntries).sort();
    const sessionBelongsToSelected = recordedSessionPort === gatewayPort;
    const wholeLegacyBundleBelongsToSelected =
      selectedNames.length > 0 &&
      Object.keys(remainingEntries).length === 0 &&
      (session === null || sessionBelongsToSelected);

    if (selectedNames.length === 0 && !sessionBelongsToSelected && !selectedRecovery) return result;

    const entriesToMove: readonly LegacyBundleEntry[] = wholeLegacyBundleBelongsToSelected
      ? MIGRATABLE_BUNDLE_ENTRIES
      : sessionBelongsToSelected
        ? SESSION_BOUND_ENTRIES
        : [];
    let moveSession = false;
    if (sessionBelongsToSelected) {
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
    if (selectedRecovery) {
      preflightMovePath(home, legacyRecoveryFile, retainedSandboxRecoveryFile(selectedRoot));
    }

    registryLocks.push(acquireMigrationLock(home, `${selectedRegistryFile}.lock`));
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
      selectedRecovery,
      remainingRecovery,
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
    releaseMigrationStateLocks(lock, registryLocks);
  }
}
