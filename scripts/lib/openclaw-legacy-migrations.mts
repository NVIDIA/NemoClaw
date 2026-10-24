#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertLegacySessionSourcesPreserved,
  MixedLegacySessionsError,
  resolveLegacySessionSources,
} from "./openclaw-legacy-session-admission.mts";

const BRIDGES = [
  { version: "2026.9.5", schemas: { state: 17, agent: 21 }, migrationPrefix: "io.snapshot-" },
  { version: "2026.9.7", schemas: { state: 19, agent: 24 }, migrationPrefix: "config-flow-steps-" },
] as const;
type Bridge = (typeof BRIDGES)[number];
type NativeFunction = (...args: unknown[]) => unknown;

/** Wait for native ownership to end without reading config or changing any state. */
export async function waitForOpenClawGatewayOwner(
  root: string,
  deps: { now?: () => number; sleep?: (milliseconds: number) => Promise<unknown> } = {},
): Promise<void> {
  if (manifest(root).version !== "2026.10.5") throw new Error("Unreviewed ownership inspector");
  const readOwner = await nativeFunction(root, "gateway-lock-", "readActiveGatewayLockIdentity");
  const now = deps.now ?? (() => performance.now());
  const wait = deps.sleep ?? sleep;
  // A stopped foreign owner expires after 90 seconds. Leave time for config
  // generation inside the existing five-minute managed root-apply deadline.
  const deadline = now() + 120_000;
  let reported = false;
  while (now() < deadline) {
    try {
      const owner = await readOwner({
        env: process.env,
        requireInspection: true,
        includeEmbedded: true,
        timeoutMs: Math.max(1, Math.min(5_000, deadline - now())),
      });
      if (owner === undefined) return;
      if (!Number.isSafeInteger(object(owner).pid))
        throw new Error("Invalid native owner identity");
    } catch (error) {
      // A foreign PID namespace cannot prove death while the native heartbeat
      // is fresh. Retry only that refusal; malformed or unreadable locks fail.
      if (
        !(error instanceof Error) ||
        error.name !== "GatewayLockError" ||
        !(error.cause instanceof Error) ||
        error.cause.name !== "GatewayLockNamespaceError"
      )
        throw error;
    }
    if (!reported) {
      process.stderr.write("[setup] Waiting for OpenClaw native gateway ownership to end\n");
      reported = true;
    }
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(2_000, remaining));
  }
  throw new Error("OpenClaw gateway ownership did not end within the maintenance budget");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid native migration inspection result");
  }
  return value as Record<string, unknown>;
}

function versionParts(version: unknown): number[] {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
    throw new Error("Unrecognized OpenClaw state writer version");
  }
  const parts = version.split(/[-+]/, 1)[0]!.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Invalid OpenClaw state writer version");
  return parts;
}

function newerThan(version: unknown, target: string): boolean {
  const left = versionParts(version);
  const right = versionParts(target);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

function manifest(root: string): Record<string, unknown> {
  const result = object(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")));
  if (result.name !== "openclaw") throw new Error("Expected the installed OpenClaw runtime");
  versionParts(result.version);
  return result;
}

/** Resolve only the reviewed native module family, refusing missing/ambiguous exports. */
async function nativeFunction(root: string, prefix: string, name: string): Promise<NativeFunction> {
  const dist = path.join(root, "dist");
  const candidates: { file: string; exported: string }[] = [];
  for (const nameOnDisk of fs.readdirSync(dist)) {
    if (!nameOnDisk.startsWith(prefix) || !/\.m?js$/.test(nameOnDisk)) continue;
    const file = path.join(dist, nameOnDisk);
    const source = fs.readFileSync(file, "utf8");
    for (const declaration of source.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const specifier of declaration[1]!.split(",")) {
        const match = specifier.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (match?.[1] === name) candidates.push({ file, exported: match[2] ?? name });
      }
    }
  }
  // Prefer the public facade over the same implementation's minified export.
  const facades = candidates.filter((candidate) => candidate.exported === name);
  const selected = facades.length ? facades : candidates;
  if (selected.length !== 1) throw new Error("Native migration export missing or ambiguous");
  const candidate = selected[0]!;
  const loaded = await import(pathToFileURL(candidate.file).href);
  if (typeof loaded[candidate.exported] !== "function") {
    throw new Error("Native migration export is not callable");
  }
  return loaded[candidate.exported] as NativeFunction;
}

async function sourceConfig(root: string): Promise<Record<string, unknown>> {
  const createConfigIO = await nativeFunction(root, "io-", "createConfigIO");
  const io = object(
    createConfigIO({ env: { ...process.env }, observe: false, pluginValidation: "core-only" }),
  );
  if (typeof io.readConfigFileSnapshot !== "function")
    throw new Error("Native config reader missing");
  const snapshot = object(await io.readConfigFileSnapshot());
  if (snapshot.exists === false) return {};
  // A recovery/default config cannot stand in for an unreadable original.
  return object(snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig);
}

async function bridgeEligible(targetRoot: string, bridge: Bridge): Promise<boolean> {
  if (manifest(targetRoot).version !== "2026.10.5") throw new Error("Unreviewed migration target");
  const cfg = await sourceConfig(targetRoot);
  const writer = cfg.meta === undefined ? undefined : object(cfg.meta).lastTouchedVersion;
  if (writer !== undefined && newerThan(writer, bridge.version)) return false;
  const listAgentIds = await nativeFunction(targetRoot, "agent-scope-config-", "listAgentIds");
  const resolveAgentDir = await nativeFunction(
    targetRoot,
    "agent-scope-config-",
    "resolveAgentDir",
  );
  const candidatePaths = await nativeFunction(
    targetRoot,
    "targets-",
    "resolveConfiguredAgentDatabaseCandidatePaths",
  );
  const preflight = await nativeFunction(
    targetRoot,
    "openclaw-database-preflight-",
    "preflightOpenClawDatabaseSchemas",
  );
  const ids = listAgentIds(cfg);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
    throw new Error("Invalid native agent roster");
  const result = object(
    await preflight({
      env: process.env,
      supportedVersions: bridge.schemas,
      preserveSourceArtifacts: true,
      configuredAgentDatabaseTargets: ids.map((agentId: string) => {
        const directory = resolveAgentDir(cfg, agentId);
        if (typeof directory !== "string") throw new Error("Invalid native agent directory");
        return { agentId, path: path.join(directory, "openclaw-agent.sqlite") };
      }),
      configuredAgentDatabaseCandidatePaths: candidatePaths(cfg, { env: process.env }),
      agentAdmissionConfig: cfg,
      signal: AbortSignal.timeout(45_000),
    }),
  );
  if (!Array.isArray(result.incompatible) || !Array.isArray(result.indeterminate)) {
    throw new Error("Invalid native schema preflight");
  }
  for (const field of ["indeterminate", "agentRefusals", "deferredSchemaPublications"]) {
    if (
      result[field] !== undefined &&
      (!Array.isArray(result[field]) || result[field].length > 0)
    ) {
      throw new Error("Cannot establish intermediate runtime compatibility");
    }
  }
  if (result.incompatible.length > 0) return false;
  await assertLegacyPluginIndexPreserved(targetRoot);
  return true;
}

/** Older bridge migrations discard a malformed plugin ledger instead of quarantining it. */
export async function assertLegacyPluginIndexPreserved(targetRoot: string): Promise<void> {
  const resolveStatePath = await nativeFunction(
    targetRoot,
    "openclaw-state-db.paths-",
    "resolveOpenClawStateSqlitePath",
  );
  const pathname = resolveStatePath(process.env);
  if (typeof pathname !== "string") throw new Error("Invalid native state database path");
  try {
    const stat = fs.lstatSync(pathname);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe legacy state database");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prepare = await nativeFunction(
    targetRoot,
    "sqlite-snapshot-source-",
    "prepareSqliteReadOnlyLocation",
  );
  const snapshot = object(
    await prepare(pathname, {
      preserveSourceArtifacts: true,
      allowLiveOwner: false,
      signal: AbortSignal.timeout(45_000),
    }),
  );
  if (typeof snapshot.location !== "string" || typeof snapshot.cleanup !== "function") {
    throw new Error("Invalid native state inspection snapshot");
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(snapshot.location, { readOnly: true });
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'installed_plugin_index'").get())
      return;
    const rows = db.prepare("SELECT * FROM installed_plugin_index").all();
    for (const row of rows) {
      if (row.index_key !== "installed-plugin-index")
        throw new Error("Unknown legacy plugin index row");
      object(JSON.parse(String(row.install_records_json)));
      for (const column of ["plugins_json", "diagnostics_json"]) {
        if (!Array.isArray(JSON.parse(String(row[column])))) {
          throw new Error("Legacy plugin index requires preservation before migration");
        }
      }
    }
  } finally {
    try {
      db?.close();
    } finally {
      if (snapshot.cleanup() !== true) throw new Error("State inspection cleanup failed");
    }
  }
}

async function previewBridgeConfig(
  root: string,
  bridge: Bridge,
): Promise<{ storePath: string; sqlitePath: string }[]> {
  if (manifest(root).version !== bridge.version) throw new Error("Unexpected migration runtime");
  const cfg = await sourceConfig(root);
  const migrate = await nativeFunction(root, bridge.migrationPrefix, "applyLegacyDoctorMigrations");
  const validate = await nativeFunction(root, "validation-core-", "validateConfigObjectRaw");
  const normalizeRoster = await nativeFunction(
    root,
    "legacy.roster-",
    "migratePersistedImplicitMainRoster",
  );
  const roster = object(await normalizeRoster(cfg));
  // Core-only, state-free preview: do not load user plugins or strip unknown
  // keys to make an older runtime accept config written by a newer runtime.
  const preview = object(
    await migrate(roster.config, { sourceConfigBeforeMigrations: cfg, pluginContracts: false }),
  );
  const checked = object(await validate(preview.next ?? roster.config));
  if (checked.ok !== true)
    throw new Error("Config cannot safely pass through the intermediate runtime");
  return resolveLegacySessionSources(root, object(preview.next ?? roster.config), nativeFunction);
}

async function assertRetiredTelegramStateMigrated(root: string): Promise<void> {
  if (manifest(root).version !== "2026.9.7") throw new Error("Unexpected retired-state inspector");
  const config = await sourceConfig(root);
  const resolveStateDir = await nativeFunction(root, "paths-", "resolveStateDir");
  const stateDir = resolveStateDir(process.env);
  if (typeof stateDir !== "string") throw new Error("Invalid native state directory");
  archiveEmptyTelegramThreadBindings(stateDir);
  // 10.5 no longer inspects these sources. Retain 9.7's read-only detector so
  // an incompatible/skipped 9.5 bridge cannot silently strand Telegram data.
  const api = await import(
    pathToFileURL(path.join(root, "dist/extensions/telegram/doctor-contract-api.js")).href
  );
  if (!Array.isArray(api.stateMigrations))
    throw new Error("Native Telegram migration contract missing");
  const matches = api.stateMigrations.filter(
    (migration: unknown) => object(migration).id === "telegram-legacy-state",
  );
  if (matches.length !== 1 || typeof matches[0].detectLegacyState !== "function") {
    throw new Error("Native Telegram retirement detector missing or ambiguous");
  }
  const detection = await matches[0].detectLegacyState({
    config,
    env: process.env,
    stateDir,
    oauthDir: path.join(stateDir, "credentials"),
    context: new Proxy(
      {},
      {
        get() {
          throw new Error("Retired-state inspection attempted canonical access");
        },
      },
    ),
  });
  if (detection !== null) throw new Error("Legacy Telegram state still requires the 9.5 migration");
}

// The exact shapes come from OpenClaw 9.8's Telegram retirement contract.
// JSON.parse alone would accept duplicate/escaped keys and lose their meaning.
const EMPTY_THREAD_BINDINGS = [
  /^\s*\{\s*"version"\s*:\s*1\s*,\s*"bindings"\s*:\s*\[\s*\]\s*\}\s*$/,
  /^\s*\{\s*"bindings"\s*:\s*\[\s*\]\s*,\s*"version"\s*:\s*1\s*\}\s*$/,
];
const EMPTY_ARCHIVE_PREFIX = ".nemoclaw-telegram-empty-";

function emptyThreadBindings(bytes: Buffer): boolean {
  const raw = bytes.toString("utf8");
  try {
    JSON.parse(raw);
    return EMPTY_THREAD_BINDINGS.some((pattern) => pattern.test(raw));
  } catch {
    return false;
  }
}

/** Archive only verified empty files while the restored gateway is stopped. */
export function archiveEmptyTelegramThreadBindings(stateDir: string): void {
  const directory = path.join(fs.realpathSync(stateDir), "telegram");
  let entries: string[];
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Invalid Telegram directory");
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // An interrupted move must remain blocking even if the old source name is gone.
  if (
    entries.some((name) => name.startsWith(EMPTY_ARCHIVE_PREFIX) && !name.endsWith(".migrated"))
  ) {
    throw new Error("Incomplete empty Telegram state archival");
  }
  for (const name of entries) {
    if (!/^thread-bindings-.+\.json$/.test(name)) continue;
    const source = path.join(directory, name);
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    let fd: number;
    try {
      fd = fs.openSync(source, flags);
    } catch (error) {
      // Leave symlinks for the native retirement detector without following them.
      if ((error as NodeJS.ErrnoException).code === "ELOOP") continue;
      throw error;
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1) continue;
      const entry = fs.lstatSync(source);
      if (
        !entry.isFile() ||
        entry.nlink !== 1 ||
        opened.ino !== entry.ino ||
        opened.dev !== entry.dev
      )
        throw new Error("Telegram source changed before inspection");
      const bytes = fs.readFileSync(fd);
      if (!emptyThreadBindings(bytes)) continue;
      // Reserve a private destination instead of overwriting a prior .migrated
      // file. Moving first preserves even a concurrently replaced source.
      const pending = fs.mkdtempSync(path.join(directory, EMPTY_ARCHIVE_PREFIX));
      const archived = path.join(pending, name);
      fs.renameSync(source, archived);
      const archivedFd = fs.openSync(archived, flags);
      try {
        const moved = fs.fstatSync(archivedFd);
        if (
          !moved.isFile() ||
          moved.nlink !== 1 ||
          moved.ino !== opened.ino ||
          moved.dev !== opened.dev ||
          !fs.readFileSync(archivedFd).equals(bytes)
        ) {
          throw new Error("Telegram source changed during archival; retained for recovery");
        }
        const retained = fs.lstatSync(archived);
        if (
          !retained.isFile() ||
          retained.nlink !== 1 ||
          retained.ino !== moved.ino ||
          retained.dev !== moved.dev
        ) {
          throw new Error("Telegram archive changed during verification; retained for recovery");
        }
      } finally {
        fs.closeSync(archivedFd);
      }
      fs.renameSync(pending, `${pending}.migrated`);
    } finally {
      fs.closeSync(fd);
    }
  }
}

class DoctorExitError extends Error {}

function reportInspectionFailure(args: string[], interrupted: boolean): void {
  // Neither native stderr nor runtime/config paths are safe to publish. These
  // fixed labels identify the failed gate without exposing its private input.
  const operations: Record<string, string> = {
    "--eligible": "schema admission",
    "--preview": "config preview",
    "--sessions": "session preservation",
    "--retired": "retired Telegram state inspection",
  };
  const operation = operations[args[1] ?? ""];
  const bridge = BRIDGES.find((candidate) => candidate.version === args[3]);
  if (!operation || !bridge) return;
  process.stderr.write(
    `[migration] OpenClaw ${bridge.version} ${operation} ${interrupted ? "did not complete" : "failed"}; native details withheld to protect restored state.\n`,
  );
}

function child(args: string[], timeout: number, inspect: boolean, input?: string): string {
  const env = { ...process.env };
  delete env.VITEST;
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    ...(process.platform !== "win32" ? { detached: true } : {}),
    maxBuffer: 16 * 1024 * 1024,
    stdio: inspect ? ["pipe", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    input,
    env: {
      ...env,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_PATH_BOOTSTRAPPED: "1",
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
    },
  });
  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" &&
    process.platform !== "win32" &&
    result.pid > 0
  ) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (result.error || result.signal || result.status === null) {
    if (inspect) reportInspectionFailure(args, true);
    throw new Error("OpenClaw migration command did not complete");
  }
  if (inspect && result.status === 42) throw new MixedLegacySessionsError();
  if (result.status !== 0) {
    if (inspect) reportInspectionFailure(args, false);
    throw new DoctorExitError("OpenClaw migration command failed");
  }
  return result.stdout ?? "";
}

export function runOpenClawLegacyMigrations(targetRoot: string, migrationRoot: string): void {
  const target = manifest(targetRoot).version;
  if (!newerThan(target, "2026.9.7")) return;
  if (target !== "2026.10.5") throw new Error("Unreviewed migration target");
  const preview = (runtime: string, bridge: Bridge) => {
    const sources = child(
      [import.meta.filename, "--preview", runtime, bridge.version],
      60_000,
      true,
    );
    child([import.meta.filename, "--sessions", targetRoot, bridge.version], 60_000, true, sources);
  };
  for (const bridge of BRIDGES) {
    const runtime = path.join(migrationRoot, bridge.version, "node_modules", "openclaw");
    // 9.7 refuses retired Telegram sources, including verified empty files.
    // Settle these after 9.5's import and before any 9.7 Doctor pass, even
    // when schema/version admission will skip that older runtime entirely.
    if (bridge.version === "2026.9.7") {
      child([import.meta.filename, "--retired", runtime, bridge.version], 60_000, true);
    }
    const eligible = JSON.parse(
      child([import.meta.filename, "--eligible", targetRoot, bridge.version], 60_000, true),
    );
    if (eligible !== true && eligible !== false)
      throw new Error("Invalid migration eligibility result");
    if (!eligible) continue;
    preview(runtime, bridge);
    process.stderr.write(`[migration] Preparing restored state with OpenClaw ${bridge.version}\n`);
    const command = [
      path.join(runtime, "openclaw.mjs"),
      "doctor",
      "--fix",
      "--yes",
      "--non-interactive",
    ];
    // Doctor can require a second pass after initializing dependent stores.
    try {
      child(command, 180_000, false);
    } catch (error) {
      if (!(error instanceof DoctorExitError)) throw error;
      process.stderr.write(
        `[migration] Checking one follow-up pass for OpenClaw ${bridge.version}\n`,
      );
    }
    if (
      JSON.parse(
        child([import.meta.filename, "--eligible", targetRoot, bridge.version], 60_000, true),
      ) !== true
    ) {
      throw new Error("Restored state changed during intermediate migration");
    }
    preview(runtime, bridge);
    child(command, 180_000, false);
  }
}

async function main(): Promise<void> {
  const [mode, root, value, extra] = process.argv.slice(2);
  if (!root || !value || extra) throw new Error("Expected migration operation and runtime paths");
  if (mode === "--run") return runOpenClawLegacyMigrations(root, value);
  if (mode === "--run-executable" || mode === "--wait-gateway-executable") {
    const executable = fs.realpathSync(root);
    let directory = fs.statSync(executable).isDirectory() ? executable : path.dirname(executable);
    while (true) {
      const candidates =
        path.basename(directory) === "node_modules"
          ? [path.join(directory, "openclaw"), directory]
          : [directory];
      for (const candidate of candidates) {
        const packagePath = path.join(candidate, "package.json");
        if (
          fs.existsSync(packagePath) &&
          object(JSON.parse(fs.readFileSync(packagePath, "utf8"))).name === "openclaw"
        ) {
          if (mode === "--wait-gateway-executable") {
            if (value !== "2026.10.5") throw new Error("Unreviewed ownership inspection request");
            return waitForOpenClawGatewayOwner(candidate);
          }
          return runOpenClawLegacyMigrations(candidate, value);
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("Installed OpenClaw package not found");
      directory = parent;
    }
  }
  const bridge = BRIDGES.find((candidate) => candidate.version === value);
  if (!bridge) throw new Error("Unreviewed intermediate runtime");
  if (mode === "--eligible")
    process.stdout.write(`${JSON.stringify(await bridgeEligible(root, bridge))}\n`);
  else if (mode === "--preview")
    process.stdout.write(`${JSON.stringify(await previewBridgeConfig(root, bridge))}\n`);
  else if (mode === "--sessions") {
    if (manifest(root).version !== "2026.10.5") throw new Error("Unreviewed migration target");
    await assertLegacySessionSourcesPreserved(
      root,
      JSON.parse(fs.readFileSync(0, "utf8")),
      nativeFunction,
    );
  } else if (mode === "--retired") await assertRetiredTelegramStateMigrated(root);
  else throw new Error("Unknown migration operation");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    if (error instanceof MixedLegacySessionsError) {
      process.stderr.write(
        "[migration] Legacy session JSON and populated SQLite sessions coexist. Restore a consistent backup or reconcile the session histories before retrying; gateway remains stopped.\n",
      );
      process.exitCode = 42;
      return;
    }
    // Native inspection errors can contain config values. Keep this boundary opaque.
    process.stderr.write(
      process.argv[2] === "--wait-gateway-executable"
        ? "[setup] OpenClaw gateway ownership could not be verified as stopped.\n"
        : "[migration] OpenClaw intermediate migration could not safely complete; gateway remains stopped.\n",
    );
    process.exitCode = 1;
  });
}
