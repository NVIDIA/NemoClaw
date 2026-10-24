#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type JsonObject,
  collectBundledPackageVersions,
  jsonObject as record,
  readJsonObject as readJson,
  rejectUnsafePackageTree,
  requireRealDirectory as realDirectory,
} from "./bundled-npm-package.mts";
import { REVIEWED_NPM_VERSION } from "./reviewed-npm-identity.mts";

export { REVIEWED_NPM_VERSION };

export const AFFECTED_UNDICI_VERSION = "6.27.0";
export const FIXED_UNDICI_VERSION = "6.29.1";
export const FIXED_UNDICI_INTEGRITY =
  "sha512-EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA==";
export const FIXED_UNDICI_TARBALL = "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz";

const REVIEWED_UNDICI_VERSIONS = new Set([AFFECTED_UNDICI_VERSION, "6.29.0", FIXED_UNDICI_VERSION]);

function removeBackup(backupPath: string): void {
  try {
    rmSync(backupPath, { force: true, recursive: true });
  } catch (cleanupError) {
    try {
      rmSync(backupPath, { force: true, recursive: true });
    } catch (retryError) {
      throw new AggregateError(
        [cleanupError, retryError],
        `verified replacement retained but affected backup cleanup failed: ${backupPath}`,
      );
    }
  }
}

function verifyUndiciManifest(manifest: JsonObject): string {
  const version = manifest.version;
  const engines = record(manifest.engines, "npm bundled undici engines");
  if (
    manifest.name !== "undici" ||
    typeof version !== "string" ||
    !REVIEWED_UNDICI_VERSIONS.has(version) ||
    manifest.main !== "index.js" ||
    manifest.types !== "index.d.ts" ||
    manifest.license !== "MIT" ||
    engines.node !== ">=18.17" ||
    manifest.dependencies !== undefined
  ) {
    throw new Error(
      `npm bundled undici identity or package contract has drifted: ${JSON.stringify({
        dependencies: manifest.dependencies,
        engines,
        license: manifest.license,
        main: manifest.main,
        types: manifest.types,
        version,
      })}`,
    );
  }
  return version;
}

export type BundledNpmUndiciState = Readonly<{
  undiciVersion: string;
  npmVersion: string;
  state: "affected" | "fixed";
}>;

export function inspectBundledNpmUndici(npmRoot: string): BundledNpmUndiciState {
  const root = realDirectory(npmRoot, "npm package root");
  const npmManifest = readJson(join(root, "package.json"), "npm package manifest");
  const npmVersion = npmManifest.version;
  if (
    npmManifest.name !== "npm" ||
    (npmVersion !== REVIEWED_NPM_VERSION && npmVersion !== "12.2.1")
  ) {
    throw new Error(
      `npm package identity has drifted; expected npm@${REVIEWED_NPM_VERSION} or npm@12.2.1`,
    );
  }

  const version = verifyUndiciManifest(
    readJson(join(root, "node_modules", "undici", "package.json"), "npm bundled undici manifest"),
  );
  const affectedVersion = npmVersion === "12.2.1" ? "6.29.0" : AFFECTED_UNDICI_VERSION;
  if (version !== affectedVersion && version !== FIXED_UNDICI_VERSION) {
    throw new Error(`npm@${npmVersion} bundled undici identity has drifted`);
  }
  const nodeModulesRoot = realDirectory(join(root, "node_modules"), "npm node_modules root");
  const versions = collectBundledPackageVersions({
    ignoredDirectoryPrefixes: [".undici.nemoclaw-stage-", "undici.nemoclaw-backup-"],
    nodeModulesRoot,
    packageName: "undici",
  });
  if (versions.length !== 1 || versions[0] !== version) {
    throw new Error(`npm bundled undici layout has drifted: ${JSON.stringify(versions)}`);
  }

  return {
    undiciVersion: version,
    npmVersion,
    state: version === FIXED_UNDICI_VERSION ? "fixed" : "affected",
  };
}

export function verifyBundledNpmUndici(npmRoot: string): BundledNpmUndiciState {
  const inspected = inspectBundledNpmUndici(npmRoot);
  if (inspected.state !== "fixed") {
    throw new Error(
      `npm@${inspected.npmVersion} bundles affected undici@${inspected.undiciVersion}; expected ${FIXED_UNDICI_VERSION}`,
    );
  }
  return inspected;
}

export function patchBundledNpmUndici(options: {
  npmRoot: string;
  replacementRoot: string;
}): BundledNpmUndiciState {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(options.replacementRoot, "replacement undici root");
  rejectUnsafePackageTree(replacementRoot, "replacement undici package");
  const replacementVersion = verifyUndiciManifest(
    readJson(join(replacementRoot, "package.json"), "replacement undici manifest"),
  );
  if (replacementVersion !== FIXED_UNDICI_VERSION) {
    throw new Error(`replacement package must be undici@${FIXED_UNDICI_VERSION}`);
  }

  const current = inspectBundledNpmUndici(npmRoot);
  if (current.state === "fixed") return current;

  const livePath = join(npmRoot, "node_modules", "undici");
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stagingRoot = mkdtempSync(join(dirname(livePath), ".undici.nemoclaw-stage-"));
  const stagedPath = join(stagingRoot, "replacement");
  const backupPath = `${livePath}.nemoclaw-backup-${transactionId}`;
  let rollbackRequired = false;
  try {
    cpSync(replacementRoot, stagedPath, { dereference: false, recursive: true });
    cpSync(livePath, backupPath, {
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
    });
    rollbackRequired = true;
    rmSync(livePath, { recursive: true });
    renameSync(stagedPath, livePath);
    const fixed = verifyBundledNpmUndici(npmRoot);
    rollbackRequired = false;
    removeBackup(backupPath);
    return fixed;
  } catch (error) {
    if (rollbackRequired) {
      try {
        rmSync(livePath, { force: true, recursive: true });
        renameSync(backupPath, livePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `npm bundled undici rollback failed; ${backupPath} retains the original tree`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export type BundledNpmUndiciCommandRunner = (command: string, args: readonly string[]) => void;

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`);
  }
}

type PreparedReplacement = Readonly<{
  cleanup: () => void;
  replacementRoot: string;
}>;

function prepareFixedUndiciReplacement(
  commandRunner: BundledNpmUndiciCommandRunner,
): PreparedReplacement {
  const rootDirectory = mkdtempSync(join(tmpdir(), "nemoclaw-npm-undici-"));
  const archivePath = join(rootDirectory, `undici-${FIXED_UNDICI_VERSION}.tgz`);
  const replacementRoot = join(rootDirectory, "replacement");
  try {
    if (process.env.NPM_CONFIG_OFFLINE === "true" || process.env.npm_config_offline === "true") {
      commandRunner("npm", [
        "pack",
        `undici@${FIXED_UNDICI_VERSION}`,
        "--registry=https://registry.npmjs.org/",
        "--offline",
        "--ignore-scripts",
        "--pack-destination",
        rootDirectory,
      ]);
    } else {
      commandRunner("curl", [
        "--proto",
        "=https",
        "--tlsv1.2",
        "--fail",
        "--silent",
        "--show-error",
        "--output",
        archivePath,
        FIXED_UNDICI_TARBALL,
      ]);
    }
    const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archiveBytes: Buffer;
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("undici replacement download must be a real file");
      }
      archiveBytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (actualIntegrity !== FIXED_UNDICI_INTEGRITY) {
      throw new Error(
        `undici replacement integrity mismatch\nExpected: ${FIXED_UNDICI_INTEGRITY}\nActual:   ${actualIntegrity}`,
      );
    }

    mkdirSync(replacementRoot, { mode: 0o700 });
    commandRunner("tar", [
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      replacementRoot,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    return {
      cleanup: () => rmSync(rootDirectory, { force: true, recursive: true }),
      replacementRoot,
    };
  } catch (error) {
    rmSync(rootDirectory, { force: true, recursive: true });
    throw error;
  }
}

export type BundledNpmUndiciRegistryDependencies = Readonly<{
  commandRunner?: BundledNpmUndiciCommandRunner;
  prepareReplacement?: (commandRunner: BundledNpmUndiciCommandRunner) => PreparedReplacement;
}>;

export function patchBundledNpmUndiciFromRegistry(
  npmRoot: string,
  dependencies: BundledNpmUndiciRegistryDependencies = {},
): BundledNpmUndiciState {
  const commandRunner = dependencies.commandRunner ?? run;
  const current = inspectBundledNpmUndici(npmRoot);
  if (current.state === "fixed") {
    commandRunner(process.execPath, [join(npmRoot, "bin", "npm-cli.js"), "--version"]);
    commandRunner(process.execPath, [join(npmRoot, "bin", "npx-cli.js"), "--version"]);
    return current;
  }
  const prepared = (dependencies.prepareReplacement ?? prepareFixedUndiciReplacement)(
    commandRunner,
  );
  try {
    const result = patchBundledNpmUndici({
      npmRoot,
      replacementRoot: prepared.replacementRoot,
    });
    commandRunner(process.execPath, [join(npmRoot, "bin", "npm-cli.js"), "--version"]);
    commandRunner(process.execPath, [join(npmRoot, "bin", "npx-cli.js"), "--version"]);
    return result;
  } finally {
    prepared.cleanup();
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function isMainModule(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isMainModule()) {
  try {
    const result = patchBundledNpmUndiciFromRegistry(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} bundled undici@${result.undiciVersion}\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
