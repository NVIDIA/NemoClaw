// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
  AGENT_MARKER,
  MARKER,
  MIGRATION_MARKER,
  MODELS_MARKER,
  patchOpenClawAgentDbText,
  patchOpenClawModelsConfigText,
  patchOpenClawSharedStatePermissions,
  patchOpenClawStateDbText,
  patchOpenClawStateMigrationText,
} from "../scripts/patch-openclaw-shared-state-permissions.mts";
import { restoreEnv } from "./helpers/env-test-helpers";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-shared-state-permissions.mts",
);

const UPSTREAM_STATE_DB_SOURCE = [
  'import { chmodSync, existsSync, mkdirSync, statSync as realStatSync, unlinkSync } from "node:fs";',
  'import path from "node:path";',
  "",
  "const OPENCLAW_STATE_DIR_MODE = 448;",
  "const OPENCLAW_STATE_FILE_MODE = 384;",
  "const chmodWarnedTargets = new Set();",
  "const chmodCalls = [];",
  "const chmodWarnings = [];",
  "let disappearOnStat = '';",
  "const stateDbLog = { warn(message) { chmodWarnings.push(message); } };",
  "function statSync(target) {",
  "\tif (target === disappearOnStat) {",
  "\t\tdisappearOnStat = '';",
  "\t\tunlinkSync(target);",
  "\t}",
  "\treturn realStatSync(target);",
  "}",
  "function applyPrivateModeSync(target, mode) {",
  "\tchmodCalls.push({ target, mode });",
  "\ttry {",
  "\t\tchmodSync(target, mode);",
  "\t\treturn { applied: true };",
  "\t} catch (error) {",
  "\t\treturn { applied: false, error };",
  "\t}",
  "}",
  "function bestEffortChmodSync(target, mode) {",
  "\tconst result = applyPrivateModeSync(target, mode);",
  "\tif (result.applied || chmodWarnedTargets.has(target)) return;",
  "\tchmodWarnedTargets.add(target);",
  "\tstateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);",
  "}",
  "function resolveOpenClawStateSqliteDir(env) { return env.OPENCLAW_STATE_DIR; }",
  "function resolveOpenClawStateSqlitePath(env) { return path.join(env.OPENCLAW_STATE_DIR, 'openclaw.sqlite'); }",
  "function resolveSqliteDatabaseFilePaths(pathname) { return [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`]; }",
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
  "function resetChmodCalls() { chmodCalls.length = 0; chmodWarnings.length = 0; }",
  "function setDisappearOnStat(target) { disappearOnStat = target; }",
  "export { chmodCalls, chmodWarnings, ensureOpenClawStatePermissions, resetChmodCalls, setDisappearOnStat };",
  "",
].join("\n");

const UPSTREAM_AGENT_DB_SOURCE = [
  'import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";',
  'import path from "node:path";',
  "",
  "const OPENCLAW_AGENT_DB_DIR_MODE = 448;",
  "const OPENCLAW_AGENT_DB_FILE_MODE = 384;",
  "function resolveOpenClawAgentSqlitePath(options) { return path.join(options.env.OPENCLAW_AGENT_DIR, `${options.agentId}.sqlite`); }",
  "function resolveSqliteDatabaseFilePaths(pathname) { return [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`]; }",
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
  "export { ensureOpenClawAgentDatabasePermissions };",
  "",
].join("\n");

const UPSTREAM_SECRET_FILE_SOURCE = [
  'import fs$1 from "node:fs/promises";',
  "",
  "const PRIVATE_SECRET_DIR_MODE = 448;",
  "const PRIVATE_SECRET_FILE_MODE = 384;",
  "async function enforcePrivatePathMode(resolvedPath, expectedMode, kind) {",
  '\tif (process.platform === "win32") return;',
  "\tawait fs$1.chmod(resolvedPath, expectedMode);",
  "\tconst actualMode = (await fs$1.stat(resolvedPath)).mode & 511;",
  "\tif (actualMode !== expectedMode) throw new Error(`Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`);",
  "}",
  "async function writeSecretFileAtomic(params) {",
  "\tconst mode = params.mode ?? 384;",
  "\tconst dirMode = params.dirMode ?? 448;",
  "\treturn { dirMode, mode };",
  "}",
  "export { enforcePrivatePathMode, writeSecretFileAtomic };",
  "",
].join("\n");

const UPSTREAM_STATE_MIGRATION_SOURCE = [
  'import { existsSync } from "node:fs";',
  "",
  "const fileExists = existsSync;",
  "function migrateLegacyUpdateCheckState(params) {",
  "\tconst changes = [];",
  "\tconst warnings = [];",
  "\tif (!fileExists(params.detected.sourcePath)) return {",
  "\t\tchanges,",
  "\t\twarnings",
  "\t};",
  '\twarnings.push("upstream update-check migration ran");',
  "\treturn { changes, warnings };",
  "}",
  "export { migrateLegacyUpdateCheckState };",
  "",
].join("\n");

const UPSTREAM_FILE_STORE_SOURCE = [
  'import path from "node:path";',
  "",
  "function fileStore(options) {",
  "\tconst rootDir = path.resolve(options.rootDir);",
  "\tconst privateMode = options.private ?? false;",
  "\tconst dirMode = options.dirMode ?? 448;",
  "\tconst mode = options.mode ?? 384;",
  "\treturn { dirMode, mode, privateMode, rootDir };",
  "}",
  "function fileStoreSync(options) {",
  "\tconst rootDir = path.resolve(options.rootDir);",
  "\tconst privateMode = options.private ?? false;",
  "\tconst dirMode = options.dirMode ?? 448;",
  "\tconst mode = options.mode ?? 384;",
  "\treturn { dirMode, mode, privateMode, rootDir };",
  "}",
  "export { fileStore, fileStoreSync };",
  "",
].join("\n");

const UPSTREAM_MODELS_CONFIG_SOURCE = [
  'import realFs from "node:fs/promises";',
  "",
  "const chmodCalls = [];",
  "const fs = {",
  "\tstat: realFs.stat,",
  "\tasync chmod(pathname, requestedMode) {",
  "\t\tchmodCalls.push({ pathname, mode: requestedMode });",
  "\t\tawait realFs.chmod(pathname, requestedMode);",
  "\t}",
  "};",
  "async function ensureModelsFileModeForModelsJson(pathname) {",
  "\tawait fs.chmod(pathname, 384).catch(() => {});",
  "}",
  "async function writeModelsFileAtomicForModelsJson(targetPath, contents) {",
  "\treturn { contents, targetPath };",
  "}",
  "function resetChmodCalls() { chmodCalls.length = 0; }",
  "export { chmodCalls, ensureModelsFileModeForModelsJson, resetChmodCalls };",
  "",
].join("\n");

interface StateFixtureRuntime {
  chmodCalls: Array<{ target: string; mode: number }>;
  chmodWarnings: string[];
  ensureOpenClawStatePermissions(
    pathname: string,
    env: {
      NEMOCLAW_OPENCLAW_SHARED_STATE?: string;
      OPENCLAW_STATE_DIR: string;
      OPENSHELL_SANDBOX?: string;
    },
  ): void;
  resetChmodCalls(): void;
  setDisappearOnStat(target: string): void;
}

interface AgentFixtureRuntime {
  ensureOpenClawAgentDatabasePermissions(
    pathname: string,
    options: {
      agentId: string;
      env: {
        NEMOCLAW_OPENCLAW_SHARED_STATE?: string;
        OPENCLAW_AGENT_DIR: string;
        OPENSHELL_SANDBOX?: string;
      };
    },
  ): void;
}

interface SecretFixtureRuntime {
  enforcePrivatePathMode(pathname: string, expectedMode: number, kind: string): Promise<void>;
  writeSecretFileAtomic(params: { dirMode?: number; mode?: number }): Promise<{
    dirMode: number;
    mode: number;
  }>;
}

interface MigrationFixtureRuntime {
  migrateLegacyUpdateCheckState(params: { detected: { sourcePath: string } }): {
    changes: string[];
    warnings: string[];
  };
}

interface FileStoreFixtureRuntime {
  fileStore(options: FileStoreFixtureOptions): FileStoreFixtureResult;
  fileStoreSync(options: FileStoreFixtureOptions): FileStoreFixtureResult;
}

interface FileStoreFixtureOptions {
  rootDir: string;
  private?: boolean;
  dirMode?: number;
  mode?: number;
}

interface FileStoreFixtureResult {
  dirMode: number;
  mode: number;
  privateMode: boolean;
  rootDir: string;
}

interface ModelsFixtureRuntime {
  chmodCalls: Array<{ pathname: string; mode: number }>;
  ensureModelsFileModeForModelsJson(pathname: string): Promise<void>;
  resetChmodCalls(): void;
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o7777;
}

function makeFixture(
  stateFileCount = 1,
  agentFileCount = 1,
  secretFileCount = 1,
  migrationFileCount = 1,
  fileStoreFileCount = 1,
  modelsFileCount = 1,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-state-mode-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const stateFiles: string[] = [];
  for (let index = 0; index < stateFileCount; index += 1) {
    const file = path.join(dist, `openclaw-state-db-${index}.js`);
    fs.writeFileSync(file, UPSTREAM_STATE_DB_SOURCE);
    stateFiles.push(file);
  }
  const agentFiles: string[] = [];
  for (let index = 0; index < agentFileCount; index += 1) {
    const file = path.join(dist, `openclaw-agent-db-${index}.js`);
    fs.writeFileSync(file, UPSTREAM_AGENT_DB_SOURCE);
    agentFiles.push(file);
  }
  const secretFiles: string[] = [];
  for (let index = 0; index < secretFileCount; index += 1) {
    const file = path.join(dist, `secret-file-${index}.js`);
    fs.writeFileSync(file, UPSTREAM_SECRET_FILE_SOURCE);
    secretFiles.push(file);
  }
  const migrationFiles: string[] = [];
  for (let index = 0; index < migrationFileCount; index += 1) {
    const file = path.join(dist, `state-migrations-${index}.js`);
    fs.writeFileSync(file, UPSTREAM_STATE_MIGRATION_SOURCE);
    migrationFiles.push(file);
  }
  const fileStoreFiles: string[] = [];
  for (let index = 0; index < fileStoreFileCount; index += 1) {
    const file = path.join(dist, `file-store-${index}.js`);
    fs.writeFileSync(file, UPSTREAM_FILE_STORE_SOURCE);
    fileStoreFiles.push(file);
  }
  const modelsFiles: string[] = [];
  for (let index = 0; index < modelsFileCount; index += 1) {
    const file = path.join(dist, `models-config-${index}.js`);
    fs.writeFileSync(file, UPSTREAM_MODELS_CONFIG_SOURCE);
    modelsFiles.push(file);
  }
  return {
    agentFiles,
    dist,
    fileStoreFiles,
    migrationFiles,
    modelsFiles,
    root,
    secretFiles,
    stateFiles,
  };
}

function runPatch(dist: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, dist], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function importStateFixture(file: string): Promise<StateFixtureRuntime> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as StateFixtureRuntime;
}

async function importAgentFixture(file: string): Promise<AgentFixtureRuntime> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as AgentFixtureRuntime;
}

async function importSecretFixture(file: string): Promise<SecretFixtureRuntime> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as SecretFixtureRuntime;
}

async function importMigrationFixture(file: string): Promise<MigrationFixtureRuntime> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as MigrationFixtureRuntime;
}

async function importFileStoreFixture(file: string): Promise<FileStoreFixtureRuntime> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as FileStoreFixtureRuntime;
}

async function importModelsFixture(file: string): Promise<ModelsFixtureRuntime> {
  return (await import(
    `${pathToFileURL(file).href}?test=${Date.now()}-${Math.random()}`
  )) as ModelsFixtureRuntime;
}

describe("OpenClaw SQLite state permission compatibility patch (#7280)", () => {
  it("applies every exact target once through the CLI and remains idempotent", () => {
    const fixture = makeFixture();
    try {
      const first = runPatch(fixture.dist);
      expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
      expect(first.stdout).toContain("SQLite state permissions patched");
      const patchedState = fs.readFileSync(fixture.stateFiles[0], "utf8");
      const patchedAgent = fs.readFileSync(fixture.agentFiles[0], "utf8");
      const upstreamSecret = fs.readFileSync(fixture.secretFiles[0], "utf8");
      const patchedMigration = fs.readFileSync(fixture.migrationFiles[0], "utf8");
      const upstreamFileStore = fs.readFileSync(fixture.fileStoreFiles[0], "utf8");
      const patchedModels = fs.readFileSync(fixture.modelsFiles[0], "utf8");
      expect(patchedState.split(MARKER)).toHaveLength(2);
      expect(patchedAgent.split(AGENT_MARKER)).toHaveLength(2);
      expect(patchedMigration.split(MIGRATION_MARKER)).toHaveLength(2);
      expect(patchedModels.split(MODELS_MARKER)).toHaveLength(2);
      expect(patchedState).toContain("NEMOCLAW_SHARED_STATE_DIR_MODE = 0o2770");
      expect(patchedAgent).toContain("NEMOCLAW_SHARED_AGENT_DB_DIR_MODE = 0o2770");
      expect(upstreamSecret).toBe(UPSTREAM_SECRET_FILE_SOURCE);
      expect(upstreamFileStore).toBe(UPSTREAM_FILE_STORE_SOURCE);

      const second = runPatch(fixture.dist);
      expect(second.status, `${second.stdout}${second.stderr}`).toBe(0);
      expect(second.stdout).toContain("SQLite state permissions already-patched");
      expect(fs.readFileSync(fixture.stateFiles[0], "utf8")).toBe(patchedState);
      expect(fs.readFileSync(fixture.agentFiles[0], "utf8")).toBe(patchedAgent);
      expect(fs.readFileSync(fixture.secretFiles[0], "utf8")).toBe(upstreamSecret);
      expect(fs.readFileSync(fixture.migrationFiles[0], "utf8")).toBe(patchedMigration);
      expect(fs.readFileSync(fixture.fileStoreFiles[0], "utf8")).toBe(upstreamFileStore);
      expect(fs.readFileSync(fixture.modelsFiles[0], "utf8")).toBe(patchedModels);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "1",
    "sandbox-name",
  ])("retains owner-only state modes for the same-UID OpenShell marker %s", async (openShellMarker) => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importStateFixture(fixture.stateFiles[0]);
      const stateDir = path.join(fixture.root, "runtime-state");
      const database = path.join(stateDir, "openclaw.sqlite");
      const wal = `${database}-wal`;
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENSHELL_SANDBOX: openShellMarker };

      runtime.ensureOpenClawStatePermissions(database, env);
      fs.writeFileSync(database, "");
      fs.writeFileSync(wal, "");
      runtime.ensureOpenClawStatePermissions(database, env);

      expect(mode(stateDir)).toBe(0o700);
      expect(mode(database)).toBe(0o600);
      expect(mode(wal)).toBe(0o600);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses group-shared modes for direct NemoClaw containers", async () => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importStateFixture(fixture.stateFiles[0]);
      const stateDir = path.join(fixture.root, "direct-state");
      const database = path.join(stateDir, "openclaw.sqlite");
      const env = {
        NEMOCLAW_OPENCLAW_SHARED_STATE: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENSHELL_SANDBOX: "",
      };

      runtime.ensureOpenClawStatePermissions(database, env);
      fs.writeFileSync(database, "");
      runtime.ensureOpenClawStatePermissions(database, env);

      expect(mode(stateDir)).toBe(0o2770);
      expect(mode(database)).toBe(0o660);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses the process marker when a worker passes a narrowed environment", async () => {
    const fixture = makeFixture();
    const previousMarker = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importStateFixture(fixture.stateFiles[0]);
      const stateDir = path.join(fixture.root, "worker-state");
      const database = path.join(stateDir, "openclaw.sqlite");
      process.env.NEMOCLAW_OPENCLAW_SHARED_STATE = "1";

      runtime.ensureOpenClawStatePermissions(database, { OPENCLAW_STATE_DIR: stateDir });
      fs.writeFileSync(database, "");
      runtime.ensureOpenClawStatePermissions(database, { OPENCLAW_STATE_DIR: stateDir });

      expect(mode(stateDir)).toBe(0o2770);
      expect(mode(database)).toBe(0o660);
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousMarker);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses group-shared modes for the per-agent database", async () => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importAgentFixture(fixture.agentFiles[0]);
      const agentDir = path.join(fixture.root, "agent-state");
      const database = path.join(agentDir, "main.sqlite");
      const options = {
        agentId: "main",
        env: {
          NEMOCLAW_OPENCLAW_SHARED_STATE: "1",
          OPENCLAW_AGENT_DIR: agentDir,
          OPENSHELL_SANDBOX: "",
        },
      };

      runtime.ensureOpenClawAgentDatabasePermissions(database, options);
      fs.writeFileSync(database, "");
      runtime.ensureOpenClawAgentDatabasePermissions(database, options);

      expect(mode(agentDir)).toBe(0o2770);
      expect(mode(database)).toBe(0o660);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "1",
    "sandbox-name",
  ])("retains owner-only per-agent database modes in same-UID OpenShell %s", async (openShellMarker) => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importAgentFixture(fixture.agentFiles[0]);
      const agentDir = path.join(fixture.root, "openshell-agent-state");
      const database = path.join(agentDir, "main.sqlite");
      const options = {
        agentId: "main",
        env: { OPENCLAW_AGENT_DIR: agentDir, OPENSHELL_SANDBOX: openShellMarker },
      };

      runtime.ensureOpenClawAgentDatabasePermissions(database, options);
      fs.writeFileSync(database, "");
      runtime.ensureOpenClawAgentDatabasePermissions(database, options);

      expect(mode(agentDir)).toBe(0o700);
      expect(mode(database)).toBe(0o600);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains owner-only secret-file modes under the NemoClaw marker", async () => {
    const fixture = makeFixture();
    const previousMarker = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      process.env.NEMOCLAW_OPENCLAW_SHARED_STATE = "1";
      const runtime = await importSecretFixture(fixture.secretFiles[0]);
      const privateDir = path.join(fixture.root, "private-store");
      fs.mkdirSync(privateDir, { mode: 0o700 });
      fs.chmodSync(privateDir, 0o2770);

      const defaults = await runtime.writeSecretFileAtomic({});
      expect(defaults).toEqual({ dirMode: 0o700, mode: 0o600 });
      await runtime.enforcePrivatePathMode(privateDir, defaults.dirMode, "directory");
      expect(mode(privateDir)).toBe(0o700);
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousMarker);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux" || (process.getuid?.() ?? -1) !== 0)(
    "denies a same-group user access to another user's device identity",
    async () => {
      const fixture = makeFixture();
      try {
        patchOpenClawSharedStatePermissions(fixture.dist);
        const runtime = await importFileStoreFixture(fixture.fileStoreFiles[0]);
        const privateDir = path.join(fixture.root, "gateway-private-store");
        const identityFile = path.join(privateDir, "identity.json");
        const defaults = runtime.fileStore({ rootDir: privateDir, private: true });
        const sharedGid = 65_534;
        const gatewayUid = 65_532;
        const sandboxUid = 65_533;
        fs.chmodSync(fixture.root, 0o755);
        fs.mkdirSync(privateDir, { mode: defaults.dirMode });
        fs.chownSync(privateDir, gatewayUid, sharedGid);
        fs.chmodSync(privateDir, defaults.dirMode);

        const writer = spawnSync(
          process.execPath,
          [
            "-e",
            `process.umask(0); require("node:fs").writeFileSync(${JSON.stringify(identityFile)}, "gateway-credential", { mode: ${defaults.mode} });`,
          ],
          { encoding: "utf8", gid: sharedGid, uid: gatewayUid },
        );
        expect(writer.status, writer.stderr).toBe(0);
        expect(mode(privateDir)).toBe(0o700);
        expect(mode(identityFile)).toBe(0o600);

        const reader = spawnSync(
          process.execPath,
          ["-e", `require("node:fs").readFileSync(${JSON.stringify(identityFile)}, "utf8")`],
          { encoding: "utf8", gid: sharedGid, uid: sandboxUid },
        );
        expect(reader.status).not.toBe(0);
        expect(reader.stderr).toContain("EACCES");

        const writerFromSandbox = spawnSync(
          process.execPath,
          ["-e", `require("node:fs").appendFileSync(${JSON.stringify(identityFile)}, "tampered")`],
          { encoding: "utf8", gid: sharedGid, uid: sandboxUid },
        );
        expect(writerFromSandbox.status).not.toBe(0);
        expect(writerFromSandbox.stderr).toContain("EACCES");
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("retains owner-only defaults for async and sync private stores under NemoClaw", async () => {
    const fixture = makeFixture();
    const previousMarker = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importFileStoreFixture(fixture.fileStoreFiles[0]);
      process.env.NEMOCLAW_OPENCLAW_SHARED_STATE = "1";
      const rootDir = path.join(fixture.root, "normal-private-store");

      for (const result of [
        runtime.fileStore({ rootDir, private: true }),
        runtime.fileStoreSync({ rootDir, private: true }),
      ]) {
        expect(result).toMatchObject({ dirMode: 0o700, mode: 0o600, privateMode: true });
      }
      expect(runtime.fileStore({ rootDir })).toMatchObject({
        dirMode: 0o700,
        mode: 0o600,
        privateMode: false,
      });
      expect(
        runtime.fileStore({ rootDir, private: true, dirMode: 0o750, mode: 0o640 }),
      ).toMatchObject({ dirMode: 0o750, mode: 0o640, privateMode: true });
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousMarker);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains owner-only private-store defaults outside NemoClaw", async () => {
    const fixture = makeFixture();
    const previousShared = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    const previousOpenShell = process.env.OPENSHELL_SANDBOX;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      delete process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
      process.env.OPENSHELL_SANDBOX = "sandbox_name";
      const runtime = await importFileStoreFixture(fixture.fileStoreFiles[0]);
      const rootDir = path.join(fixture.root, "upstream-private-store");

      expect(runtime.fileStore({ rootDir, private: true })).toMatchObject({
        dirMode: 0o700,
        mode: 0o600,
        privateMode: true,
      });
      expect(runtime.fileStoreSync({ rootDir, private: true })).toMatchObject({
        dirMode: 0o700,
        mode: 0o600,
        privateMode: true,
      });
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousShared);
      restoreEnv("OPENSHELL_SANDBOX", previousOpenShell);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps generated models files group-readable under the split-user marker", async () => {
    const fixture = makeFixture();
    const previousShared = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    const previousOpenShell = process.env.OPENSHELL_SANDBOX;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      process.env.NEMOCLAW_OPENCLAW_SHARED_STATE = "1";
      delete process.env.OPENSHELL_SANDBOX;
      const runtime = await importModelsFixture(fixture.modelsFiles[0]);
      const modelsFile = path.join(fixture.root, "models.json");
      fs.writeFileSync(modelsFile, "{}", { mode: 0o600 });

      await runtime.ensureModelsFileModeForModelsJson(modelsFile);
      expect(mode(modelsFile)).toBe(0o660);
      expect(runtime.chmodCalls).toEqual([{ pathname: modelsFile, mode: 0o660 }]);

      runtime.resetChmodCalls();
      await runtime.ensureModelsFileModeForModelsJson(modelsFile);
      expect(runtime.chmodCalls).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousShared);
      restoreEnv("OPENSHELL_SANDBOX", previousOpenShell);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "1",
    "sandbox-name",
  ])("retains the upstream generated-models mode in same-UID OpenShell %s", async (openShellMarker) => {
    const fixture = makeFixture();
    const previousShared = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    const previousOpenShell = process.env.OPENSHELL_SANDBOX;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      delete process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
      process.env.OPENSHELL_SANDBOX = openShellMarker;
      const runtime = await importModelsFixture(fixture.modelsFiles[0]);
      const modelsFile = path.join(fixture.root, "models.json");
      fs.writeFileSync(modelsFile, "{}", { mode: 0o660 });

      await runtime.ensureModelsFileModeForModelsJson(modelsFile);
      expect(mode(modelsFile)).toBe(0o600);
      expect(runtime.chmodCalls).toEqual([{ pathname: modelsFile, mode: 0o600 }]);
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousShared);
      restoreEnv("OPENSHELL_SANDBOX", previousOpenShell);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["NEMOCLAW_OPENCLAW_SHARED_STATE", "1"],
    ["OPENSHELL_SANDBOX", "sandbox-name"],
  ] as const)("ignores legacy update-check migration state under %s", async (markerName, markerValue) => {
    const fixture = makeFixture();
    const previousShared = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    const previousOpenShell = process.env.OPENSHELL_SANDBOX;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      delete process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
      delete process.env.OPENSHELL_SANDBOX;
      process.env[markerName] = markerValue;
      const cache = path.join(fixture.root, "update-check.json");
      fs.writeFileSync(cache, "not even valid JSON");
      const runtime = await importMigrationFixture(fixture.migrationFiles[0]);

      expect(runtime.migrateLegacyUpdateCheckState({ detected: { sourcePath: cache } })).toEqual({
        changes: [],
        warnings: [],
      });
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousShared);
      restoreEnv("OPENSHELL_SANDBOX", previousOpenShell);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains the upstream update-check migration behavior outside NemoClaw", async () => {
    const fixture = makeFixture();
    const previousShared = process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
    const previousOpenShell = process.env.OPENSHELL_SANDBOX;
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      delete process.env.NEMOCLAW_OPENCLAW_SHARED_STATE;
      process.env.OPENSHELL_SANDBOX = "sandbox_name";
      const cache = path.join(fixture.root, "update-check.json");
      fs.writeFileSync(cache, "{}");
      const runtime = await importMigrationFixture(fixture.migrationFiles[0]);

      expect(runtime.migrateLegacyUpdateCheckState({ detected: { sourcePath: cache } })).toEqual({
        changes: [],
        warnings: ["upstream update-check migration ran"],
      });
    } finally {
      restoreEnv("NEMOCLAW_OPENCLAW_SHARED_STATE", previousShared);
      restoreEnv("OPENSHELL_SANDBOX", previousOpenShell);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "",
    "0",
    "TRUE",
    "sandbox_name",
    "-sandbox",
    "sandbox-",
  ])("retains upstream private modes for an invalid OpenShell marker %j", async (openShellMarker) => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importStateFixture(fixture.stateFiles[0]);
      const stateDir = path.join(fixture.root, "private-state");
      const database = path.join(stateDir, "openclaw.sqlite");
      const env = {
        NEMOCLAW_OPENCLAW_SHARED_STATE: "",
        OPENCLAW_STATE_DIR: stateDir,
        OPENSHELL_SANDBOX: openShellMarker,
      };
      runtime.ensureOpenClawStatePermissions(database, env);
      fs.writeFileSync(database, "");
      runtime.ensureOpenClawStatePermissions(database, env);
      expect(mode(stateDir)).toBe(0o700);
      expect(mode(database)).toBe(0o600);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("skips chmod for already-matching group-shared state", async () => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importStateFixture(fixture.stateFiles[0]);
      const stateDir = path.join(fixture.root, "preowned-state");
      const database = path.join(stateDir, "openclaw.sqlite");
      const wal = `${database}-wal`;
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.writeFileSync(database, "");
      fs.writeFileSync(wal, "");
      fs.chmodSync(stateDir, 0o2770);
      fs.chmodSync(database, 0o660);
      fs.chmodSync(wal, 0o660);
      runtime.resetChmodCalls();

      runtime.ensureOpenClawStatePermissions(database, {
        NEMOCLAW_OPENCLAW_SHARED_STATE: "1",
        OPENCLAW_STATE_DIR: stateDir,
      });

      expect(runtime.chmodCalls).toEqual([]);
      expect(mode(stateDir)).toBe(0o2770);
      expect(mode(database)).toBe(0o660);
      expect(mode(wal)).toBe(0o660);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves best-effort behavior when a SQLite sidecar disappears before the mode probe", async () => {
    const fixture = makeFixture();
    try {
      patchOpenClawSharedStatePermissions(fixture.dist);
      const runtime = await importStateFixture(fixture.stateFiles[0]);
      const stateDir = path.join(fixture.root, "racing-state");
      const database = path.join(stateDir, "openclaw.sqlite");
      const wal = `${database}-wal`;
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.writeFileSync(database, "");
      fs.writeFileSync(wal, "");
      fs.chmodSync(stateDir, 0o2770);
      fs.chmodSync(database, 0o660);
      fs.chmodSync(wal, 0o660);
      runtime.resetChmodCalls();
      runtime.setDisappearOnStat(wal);

      expect(() =>
        runtime.ensureOpenClawStatePermissions(database, {
          NEMOCLAW_OPENCLAW_SHARED_STATE: "1",
          OPENCLAW_STATE_DIR: stateDir,
        }),
      ).not.toThrow();

      expect(fs.existsSync(wal)).toBe(false);
      expect(runtime.chmodCalls).toEqual([{ target: wal, mode: 0o660 }]);
      expect(runtime.chmodWarnings).toHaveLength(1);
      expect(runtime.chmodWarnings[0]).toContain(wal);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed on missing, ambiguous, and partial source shapes", () => {
    const missing = makeFixture(0, 1, 1);
    try {
      expect(() => patchOpenClawSharedStatePermissions(missing.dist)).toThrow(
        "Expected exactly one OpenClaw shared-state database target",
      );
    } finally {
      fs.rmSync(missing.root, { recursive: true, force: true });
    }

    const ambiguous = makeFixture(2, 1, 1);
    try {
      expect(() => patchOpenClawSharedStatePermissions(ambiguous.dist)).toThrow("found 2");
      for (const file of [
        ...ambiguous.stateFiles,
        ...ambiguous.agentFiles,
        ...ambiguous.secretFiles,
        ...ambiguous.migrationFiles,
        ...ambiguous.fileStoreFiles,
        ...ambiguous.modelsFiles,
      ]) {
        expect(fs.readFileSync(file, "utf8")).not.toContain("nemoclaw: group-shared");
      }
    } finally {
      fs.rmSync(ambiguous.root, { recursive: true, force: true });
    }

    const missingMigration = makeFixture(1, 1, 1, 0);
    try {
      expect(() => patchOpenClawSharedStatePermissions(missingMigration.dist)).toThrow(
        "Expected exactly one OpenClaw state-migration target",
      );
      for (const file of [
        ...missingMigration.stateFiles,
        ...missingMigration.agentFiles,
        ...missingMigration.secretFiles,
        ...missingMigration.fileStoreFiles,
        ...missingMigration.modelsFiles,
      ]) {
        expect(fs.readFileSync(file, "utf8")).not.toContain("nemoclaw: group-shared");
      }
    } finally {
      fs.rmSync(missingMigration.root, { recursive: true, force: true });
    }

    const ambiguousMigration = makeFixture(1, 1, 1, 2);
    try {
      expect(() => patchOpenClawSharedStatePermissions(ambiguousMigration.dist)).toThrow(
        "Expected exactly one OpenClaw state-migration target",
      );
      for (const file of [
        ...ambiguousMigration.stateFiles,
        ...ambiguousMigration.agentFiles,
        ...ambiguousMigration.secretFiles,
        ...ambiguousMigration.migrationFiles,
        ...ambiguousMigration.fileStoreFiles,
        ...ambiguousMigration.modelsFiles,
      ]) {
        expect(fs.readFileSync(file, "utf8")).not.toContain("nemoclaw:");
      }
    } finally {
      fs.rmSync(ambiguousMigration.root, { recursive: true, force: true });
    }

    const missingModels = makeFixture(1, 1, 1, 1, 1, 0);
    try {
      expect(() => patchOpenClawSharedStatePermissions(missingModels.dist)).toThrow(
        "Expected exactly one OpenClaw models-config target",
      );
    } finally {
      fs.rmSync(missingModels.root, { recursive: true, force: true });
    }

    const ambiguousModels = makeFixture(1, 1, 1, 1, 1, 2);
    try {
      expect(() => patchOpenClawSharedStatePermissions(ambiguousModels.dist)).toThrow(
        "Expected exactly one OpenClaw models-config target",
      );
      for (const file of [
        ...ambiguousModels.stateFiles,
        ...ambiguousModels.agentFiles,
        ...ambiguousModels.secretFiles,
        ...ambiguousModels.migrationFiles,
        ...ambiguousModels.fileStoreFiles,
        ...ambiguousModels.modelsFiles,
      ]) {
        expect(fs.readFileSync(file, "utf8")).not.toContain("nemoclaw:");
      }
    } finally {
      fs.rmSync(ambiguousModels.root, { recursive: true, force: true });
    }

    expect(() =>
      patchOpenClawStateDbText(`${UPSTREAM_STATE_DB_SOURCE}\n${MARKER}\n`, "partial.js"),
    ).toThrow("expected exactly one patched pattern");
    expect(() =>
      patchOpenClawAgentDbText(`${UPSTREAM_AGENT_DB_SOURCE}\n${AGENT_MARKER}\n`, "partial.js"),
    ).toThrow("expected exactly one patched pattern");
    expect(() =>
      patchOpenClawStateMigrationText(
        `${UPSTREAM_STATE_MIGRATION_SOURCE}\n${MIGRATION_MARKER}\n`,
        "partial.js",
      ),
    ).toThrow("expected exactly one patched pattern");
    expect(() =>
      patchOpenClawModelsConfigText(
        `${UPSTREAM_MODELS_CONFIG_SOURCE}\n${MODELS_MARKER}\n`,
        "partial.js",
      ),
    ).toThrow("expected exactly one patched pattern");
    expect(() =>
      patchOpenClawStateDbText(
        UPSTREAM_STATE_DB_SOURCE.replace(
          "function bestEffortChmodSync(target, mode) {",
          "function bestEffortChmodSync(target, requestedMode) {",
        ),
        "drifted.js",
      ),
    ).toThrow("expected exactly one chmod helper, found 0");
  });
});
