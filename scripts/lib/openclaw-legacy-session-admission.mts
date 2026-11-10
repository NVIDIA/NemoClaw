// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type NativeFunction = (...args: unknown[]) => unknown;
type NativeLoader = (root: string, prefix: string, name: string) => Promise<NativeFunction>;

export type SessionInventoryStage =
  | "candidateExport"
  | "configuredExport"
  | "sqliteExport"
  | "stateExport"
  | "registryExport"
  | "registry"
  | "candidates"
  | "configured"
  | "stateDirectory"
  | "validation"
  | "configuredPaths"
  | "candidatePaths";

export class MixedLegacySessionsError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid legacy session inspection result");
  }
  return value as Record<string, unknown>;
}

function existsRegular(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe legacy session artifact");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Older Doctor imports can replace a populated SQLite session with stale JSON metadata. */
async function inspectSessionStore(
  store: string,
  sqlite: string,
  prepareSnapshot: NativeFunction,
): Promise<void> {
  if (store.endsWith(".sqlite") || !existsRegular(store) || !existsRegular(sqlite)) return;
  const descriptor = fs.openSync(store, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) {
      throw new Error("Unsafe legacy session index");
    }
    const entries = record(JSON.parse(fs.readFileSync(descriptor, "utf8")));
    if (Object.keys(entries).length === 0) return;
    const snapshot = record(
      await prepareSnapshot(sqlite, {
        preserveSourceArtifacts: true,
        allowLiveOwner: false,
        signal: AbortSignal.timeout(45_000),
      }),
    );
    if (typeof snapshot.location !== "string" || typeof snapshot.cleanup !== "function") {
      throw new Error("Invalid native session inspection snapshot");
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(snapshot.location, { readOnly: true });
      if (
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_nodes'").get() &&
        db.prepare("SELECT 1 FROM session_nodes LIMIT 1").get()
      ) {
        // Alias repair and recovery receipts can join differently named keys. Refuse the
        // mixed store rather than guessing which legacy rows can replace current metadata.
        throw new MixedLegacySessionsError(
          "Mixed legacy and SQLite sessions require reconciliation before migration",
        );
      }
    } finally {
      try {
        db?.close();
      } finally {
        if (snapshot.cleanup() !== true) throw new Error("Session inspection cleanup failed");
      }
    }
    const after = fs.lstatSync(store);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Legacy session index changed during inspection");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function resolveLegacySessionSources(
  bridgeRoot: string,
  config: Record<string, unknown>,
  loadNative: NativeLoader,
  observeStage?: (stage: SessionInventoryStage) => void,
): Promise<{ storePath: string; sqlitePath: string }[]> {
  const version = record(
    JSON.parse(fs.readFileSync(path.join(bridgeRoot, "package.json"), "utf8")),
  ).version;
  if (version !== "2026.9.5" && version !== "2026.9.7")
    throw new Error("Unreviewed session migration runtime");
  observeStage?.("candidateExport");
  const candidates = await loadNative(
    bridgeRoot,
    "targets-",
    "resolveAllAgentSessionStoreCandidateTargetsSync",
  );
  observeStage?.("configuredExport");
  const configured = await loadNative(bridgeRoot, "targets-", "resolveSessionStoreTargets");
  observeStage?.("sqliteExport");
  const resolveSqlite = await loadNative(
    bridgeRoot,
    "session-sqlite-target-",
    "resolveSqliteTargetFromSessionStorePath",
  );
  observeStage?.("stateExport");
  const stateDir = await loadNative(bridgeRoot, "paths-", "resolveStateDir");
  observeStage?.("registryExport");
  const inspectRegistry = await loadNative(
    bridgeRoot,
    "openclaw-agent-db-registry-listing-",
    "inspectOpenClawRegisteredAgentDatabases",
  );
  const inspectScope = await loadNative(
    bridgeRoot,
    "sqlite-readonly-worker-",
    "withSqliteReadOnlyWorkerScope",
  );
  observeStage?.("registry");
  // The ordinary registry reader rejects pre-bridge schemas. Inspect a native
  // snapshot instead, and carry its ownership facts through every resolver.
  const registeredDatabases = await inspectScope(
    () => inspectRegistry({ env: process.env, includeIncompatibleSchemaVersions: true }),
    { signal: AbortSignal.timeout(45_000) },
  );
  if (!Array.isArray(registeredDatabases)) throw new Error("Invalid native session registry");
  const options = { env: process.env, registeredDatabases };
  const sqlitePath = (value: unknown): string => {
    const target = record(value);
    const resolved = record(
      resolveSqlite(target.sqlitePath ?? target.storePath, {
        ...options,
        agentId: target.agentId,
      }),
    );
    if (typeof resolved.path !== "string") throw new Error("Invalid native session store path");
    return resolved.path;
  };
  observeStage?.("candidates");
  const targets = candidates(config, options);
  observeStage?.("configured");
  const configuredTargets = configured(config, { allAgents: true }, options);
  observeStage?.("stateDirectory");
  const state = stateDir(process.env);
  observeStage?.("validation");
  if (!Array.isArray(targets) || !Array.isArray(configuredTargets) || typeof state !== "string") {
    throw new Error("Invalid native session store inventory");
  }
  // Match both bridge Doctors' all-agent discovery, including the historical shared index.
  const sharedStore = path.join(state, "sessions", "sessions.json");
  observeStage?.("configuredPaths");
  const stores = [
    ...targets,
    ...configuredTargets.map((target) => ({
      ...record(target),
      sqlitePath: sqlitePath(target),
      storePath: sharedStore,
    })),
  ];
  observeStage?.("candidatePaths");
  return stores.map((value) => {
    const target = record(value);
    const sqlite = sqlitePath(target);
    if (typeof target.storePath !== "string" || typeof sqlite !== "string") {
      throw new Error("Invalid native session store path");
    }
    return { storePath: target.storePath, sqlitePath: sqlite };
  });
}

/** Run with only the target runtime loaded; native singleton layouts differ between releases. */
export async function assertLegacySessionSourcesPreserved(
  targetRoot: string,
  targets: unknown,
  loadNative: NativeLoader,
): Promise<void> {
  if (!Array.isArray(targets)) throw new Error("Invalid legacy session store inventory");
  const prepareSnapshot = await loadNative(
    targetRoot,
    "sqlite-snapshot-source-",
    "prepareSqliteReadOnlyLocation",
  );
  for (const value of targets) {
    const target = record(value);
    if (typeof target.storePath !== "string" || typeof target.sqlitePath !== "string") {
      throw new Error("Invalid native session store path");
    }
    await inspectSessionStore(target.storePath, target.sqlitePath, prepareSnapshot);
  }
}
