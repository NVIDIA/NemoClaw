#!/usr/bin/env -S node --experimental-strip-types

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

export const AFFECTED_IP_ADDRESS_VERSION = "10.2.0";
export const FIXED_IP_ADDRESS_VERSION = "10.3.1";
export const FIXED_IP_ADDRESS_INTEGRITY =
  "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==";
export const FIXED_IP_ADDRESS_TARBALL =
  "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz";
export const REVIEWED_NPM_VERSION = "11.18.0";

const REVIEWED_IP_ADDRESS_VERSIONS = new Set([
  AFFECTED_IP_ADDRESS_VERSION,
  FIXED_IP_ADDRESS_VERSION,
]);

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

function verifyIpAddressManifest(manifest: JsonObject): string {
  const version = manifest.version;
  const engines = record(manifest.engines, "npm bundled ip-address engines");
  if (
    manifest.name !== "ip-address" ||
    typeof version !== "string" ||
    !REVIEWED_IP_ADDRESS_VERSIONS.has(version) ||
    manifest.main !== "dist/ip-address.js" ||
    manifest.types !== "dist/ip-address.d.ts" ||
    manifest.license !== "MIT" ||
    engines.node !== ">= 12" ||
    manifest.dependencies !== undefined
  ) {
    throw new Error(
      `npm bundled ip-address identity or package contract has drifted: ${JSON.stringify({
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

export type BundledNpmIpAddressState = Readonly<{
  ipAddressVersion: string;
  npmVersion: string;
  state: "affected" | "fixed";
}>;

export function inspectBundledNpmIpAddress(npmRoot: string): BundledNpmIpAddressState {
  const root = realDirectory(npmRoot, "npm package root");
  const npmManifest = readJson(join(root, "package.json"), "npm package manifest");
  if (npmManifest.name !== "npm" || npmManifest.version !== REVIEWED_NPM_VERSION) {
    throw new Error(`npm package identity has drifted; expected npm@${REVIEWED_NPM_VERSION}`);
  }

  const version = verifyIpAddressManifest(
    readJson(
      join(root, "node_modules", "ip-address", "package.json"),
      "npm bundled ip-address manifest",
    ),
  );
  const nodeModulesRoot = realDirectory(join(root, "node_modules"), "npm node_modules root");
  const versions = collectBundledPackageVersions({
    ignoredDirectoryPrefixes: [".ip-address.nemoclaw-stage-", "ip-address.nemoclaw-backup-"],
    nodeModulesRoot,
    packageName: "ip-address",
  });
  if (versions.length !== 1 || versions[0] !== version) {
    throw new Error(`npm bundled ip-address layout has drifted: ${JSON.stringify(versions)}`);
  }

  return {
    ipAddressVersion: version,
    npmVersion: REVIEWED_NPM_VERSION,
    state: version === FIXED_IP_ADDRESS_VERSION ? "fixed" : "affected",
  };
}

export function verifyBundledNpmIpAddress(npmRoot: string): BundledNpmIpAddressState {
  const inspected = inspectBundledNpmIpAddress(npmRoot);
  if (inspected.state !== "fixed") {
    throw new Error(
      `npm@${inspected.npmVersion} bundles affected ip-address@${inspected.ipAddressVersion}; expected ${FIXED_IP_ADDRESS_VERSION}`,
    );
  }
  return inspected;
}

export function patchBundledNpmIpAddress(options: {
  npmRoot: string;
  replacementRoot: string;
}): BundledNpmIpAddressState {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(options.replacementRoot, "replacement ip-address root");
  rejectUnsafePackageTree(replacementRoot, "replacement ip-address package");
  const replacementVersion = verifyIpAddressManifest(
    readJson(join(replacementRoot, "package.json"), "replacement ip-address manifest"),
  );
  if (replacementVersion !== FIXED_IP_ADDRESS_VERSION) {
    throw new Error(`replacement package must be ip-address@${FIXED_IP_ADDRESS_VERSION}`);
  }

  const current = inspectBundledNpmIpAddress(npmRoot);
  if (current.state === "fixed") return current;

  const livePath = join(npmRoot, "node_modules", "ip-address");
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stagingRoot = mkdtempSync(join(dirname(livePath), ".ip-address.nemoclaw-stage-"));
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
    const fixed = verifyBundledNpmIpAddress(npmRoot);
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
          `npm bundled ip-address rollback failed; ${backupPath} retains the original tree`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export type BundledNpmIpAddressCommandRunner = (command: string, args: readonly string[]) => void;

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

function prepareFixedIpAddressReplacement(
  commandRunner: BundledNpmIpAddressCommandRunner,
): PreparedReplacement {
  const rootDirectory = mkdtempSync(join(tmpdir(), "nemoclaw-npm-ip-address-"));
  const archivePath = join(rootDirectory, `ip-address-${FIXED_IP_ADDRESS_VERSION}.tgz`);
  const replacementRoot = join(rootDirectory, "replacement");
  try {
    commandRunner("curl", [
      "--proto",
      "=https",
      "--tlsv1.2",
      "--fail",
      "--silent",
      "--show-error",
      "--output",
      archivePath,
      FIXED_IP_ADDRESS_TARBALL,
    ]);
    const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archiveBytes: Buffer;
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("ip-address replacement download must be a real file");
      }
      archiveBytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (actualIntegrity !== FIXED_IP_ADDRESS_INTEGRITY) {
      throw new Error(
        `ip-address replacement integrity mismatch\nExpected: ${FIXED_IP_ADDRESS_INTEGRITY}\nActual:   ${actualIntegrity}`,
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

export type BundledNpmIpAddressRegistryDependencies = Readonly<{
  commandRunner?: BundledNpmIpAddressCommandRunner;
  prepareReplacement?: (commandRunner: BundledNpmIpAddressCommandRunner) => PreparedReplacement;
}>;

export function patchBundledNpmIpAddressFromRegistry(
  npmRoot: string,
  dependencies: BundledNpmIpAddressRegistryDependencies = {},
): BundledNpmIpAddressState {
  const commandRunner = dependencies.commandRunner ?? run;
  const current = inspectBundledNpmIpAddress(npmRoot);
  if (current.state === "fixed") {
    commandRunner("npm", ["--version"]);
    commandRunner("npx", ["--version"]);
    return current;
  }
  const prepared = (dependencies.prepareReplacement ?? prepareFixedIpAddressReplacement)(
    commandRunner,
  );
  try {
    const result = patchBundledNpmIpAddress({
      npmRoot,
      replacementRoot: prepared.replacementRoot,
    });
    commandRunner("npm", ["--version"]);
    commandRunner("npx", ["--version"]);
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
    const result = patchBundledNpmIpAddressFromRegistry(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} bundled ip-address@${result.ipAddressVersion}\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
