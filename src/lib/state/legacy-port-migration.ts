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

export interface LegacyPortMigrationResult {
  migratedSandboxNames: string[];
  migratedSession: boolean;
  warnings: string[];
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

function movePath(home: string, source: string, destination: string): boolean {
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
  if (fs.existsSync(destination)) {
    throw migrationError(`${destination} already exists; refusing to overwrite it`);
  }
  ensureRealDirectory(home, path.dirname(destination));
  fs.renameSync(source, destination);
  return true;
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
): void {
  for (const sandboxName of sandboxNames) {
    preflightMovePath(
      home,
      path.join(sharedRoot, "rebuild-backups", sandboxName),
      path.join(selectedRoot, "rebuild-backups", sandboxName),
    );
  }
}

function migrateSandboxBackups(
  home: string,
  sharedRoot: string,
  selectedRoot: string,
  sandboxNames: readonly string[],
): void {
  for (const sandboxName of sandboxNames) {
    movePath(
      home,
      path.join(sharedRoot, "rebuild-backups", sandboxName),
      path.join(selectedRoot, "rebuild-backups", sandboxName),
    );
  }
}

function acquireDirectoryLock(home: string, lock: string): string {
  ensureRealDirectory(home, path.dirname(lock));
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "owner"), String(process.pid), { mode: 0o600 });
    return lock;
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw migrationError(`another state operation owns ${lock}; retry after it completes`);
    }
    throw error;
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
  if (gatewayPort === DEFAULT_GATEWAY_PORT) return result;

  const sharedRoot = nemoclawStateRoot(home, DEFAULT_GATEWAY_PORT);
  const selectedRoot = nemoclawStateRoot(home, gatewayPort);
  const legacyRegistryFile = path.join(sharedRoot, "sandboxes.json");
  const selectedRegistryFile = path.join(selectedRoot, "sandboxes.json");
  const legacyRegistry = readGatewayRegistryFile(home, legacyRegistryFile);
  const legacySessionFile = path.join(sharedRoot, "onboard-session.json");
  const legacySession = readJsonNoFollow(home, legacySessionFile);
  if (!legacyRegistry && legacySession === null) return result;

  const lock = acquireDirectoryLock(home, path.join(sharedRoot, MIGRATION_LOCK));
  const registryLocks: string[] = [];
  try {
    registryLocks.push(acquireDirectoryLock(home, `${legacyRegistryFile}.lock`));
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

    const entriesToMove: readonly string[] = wholeLegacyBundleBelongsToSelected
      ? LEGACY_BUNDLE_ENTRIES
      : sessionBelongsToSelected
        ? SESSION_BOUND_ENTRIES
        : [];
    if (sessionBelongsToSelected) {
      const activeLock = path.join(sharedRoot, "onboard.lock");
      if (fs.existsSync(activeLock)) {
        throw migrationError(
          `legacy onboarding lock ${activeLock} is present; finish or stop that run first`,
        );
      }
      preflightMovePath(home, legacySessionFile, path.join(selectedRoot, "onboard-session.json"));
    }
    preflightSandboxBackups(home, sharedRoot, selectedRoot, selectedNames);
    for (const entry of entriesToMove) {
      preflightMovePath(home, path.join(sharedRoot, entry), path.join(selectedRoot, entry));
    }

    registryLocks.push(acquireDirectoryLock(home, `${selectedRegistryFile}.lock`));
    const existingSelected = readGatewayRegistryFile(home, selectedRegistryFile);
    const selectedRegistry = mergeSelectedRegistry(
      currentLegacy,
      selectedEntries,
      existingSelected,
      gatewayPort,
    );
    writeJsonAtomic(home, selectedRegistryFile, selectedRegistry);

    migrateSandboxBackups(home, sharedRoot, selectedRoot, selectedNames);

    if (sessionBelongsToSelected) {
      result.migratedSession = movePath(
        home,
        legacySessionFile,
        path.join(selectedRoot, "onboard-session.json"),
      );
    } else if (session !== null && recordedSessionPort === null && selectedNames.length > 0) {
      result.warnings.push(
        `Left ambiguous ${legacySessionFile} in place because it has no recorded gateway identity.`,
      );
    }

    for (const entry of entriesToMove) {
      movePath(home, path.join(sharedRoot, entry), path.join(selectedRoot, entry));
    }

    const movedEntries = new Set(entriesToMove);
    const entriesLeftAmbiguous = LEGACY_BUNDLE_ENTRIES.filter(
      (entry) => !movedEntries.has(entry) && fs.existsSync(path.join(sharedRoot, entry)),
    );
    if (selectedNames.length > 0 && entriesLeftAmbiguous.length > 0) {
      result.warnings.push(
        `Left ambiguous legacy state under ${sharedRoot}: ${entriesLeftAmbiguous.join(", ")}. Review ownership before migrating or removing it; NemoClaw did not copy it into ${selectedRoot}.`,
      );
    }

    if (currentLegacy && selectedNames.length > 0) {
      const remainingRegistry = registryWithSandboxes(
        currentLegacy,
        remainingEntries,
        currentLegacy.defaultSandbox,
      );
      writeJsonAtomic(home, legacyRegistryFile, remainingRegistry);
    }
    result.migratedSandboxNames = selectedNames;
    return result;
  } finally {
    for (const registryLock of registryLocks.reverse()) {
      fs.rmSync(registryLock, { recursive: true, force: true });
    }
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
