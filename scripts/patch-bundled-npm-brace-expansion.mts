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
  collectBundledPackageVersions,
  jsonObject as record,
  readJsonObject as readJson,
  rejectUnsafePackageTree,
  requireRealDirectory as realDirectory,
} from "./lib/bundled-npm-package.mts";

export const AFFECTED_BRACE_EXPANSION_VERSION = "5.0.7";
export const FIXED_BRACE_EXPANSION_VERSION = "5.0.9";
export const FIXED_BRACE_EXPANSION_INTEGRITY =
  "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==";
export const FIXED_BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz";
export const REVIEWED_NPM_VERSION = "11.18.0";

const REVIEWED_BRACE_EXPANSION_VERSIONS = new Set([
  AFFECTED_BRACE_EXPANSION_VERSION,
  "5.0.8",
  FIXED_BRACE_EXPANSION_VERSION,
]);

export type BundledNpmBraceExpansionState = Readonly<{
  braceExpansionVersion: string;
  npmVersion: string;
  state: "affected" | "fixed";
}>;

export function inspectBundledNpmBraceExpansion(npmRoot: string): BundledNpmBraceExpansionState {
  const root = realDirectory(npmRoot, "npm package root");
  const npmManifest = readJson(join(root, "package.json"), "npm package manifest");
  if (npmManifest.name !== "npm" || npmManifest.version !== REVIEWED_NPM_VERSION) {
    throw new Error(`npm package identity has drifted; expected npm@${REVIEWED_NPM_VERSION}`);
  }

  const braceManifest = readJson(
    join(root, "node_modules", "brace-expansion", "package.json"),
    "npm bundled brace-expansion manifest",
  );
  const dependencies = record(
    braceManifest.dependencies,
    "npm bundled brace-expansion dependencies",
  );
  const version = braceManifest.version;
  if (
    braceManifest.name !== "brace-expansion" ||
    typeof version !== "string" ||
    !REVIEWED_BRACE_EXPANSION_VERSIONS.has(version) ||
    dependencies["balanced-match"] !== "^4.0.2"
  ) {
    throw new Error(
      `npm bundled brace-expansion identity or dependency layout has drifted: ${JSON.stringify({
        dependencies,
        version,
      })}`,
    );
  }

  const nodeModulesRoot = realDirectory(join(root, "node_modules"), "npm node_modules root");
  const versions = collectBundledPackageVersions({
    ignoredDirectoryPrefixes: [
      ".brace-expansion.nemoclaw-stage-",
      "brace-expansion.nemoclaw-backup-",
    ],
    nodeModulesRoot,
    packageName: "brace-expansion",
  });
  if (versions.length !== 1 || versions[0] !== version) {
    throw new Error(`npm bundled brace-expansion layout has drifted: ${JSON.stringify(versions)}`);
  }

  return {
    braceExpansionVersion: version,
    npmVersion: REVIEWED_NPM_VERSION,
    state: version === FIXED_BRACE_EXPANSION_VERSION ? "fixed" : "affected",
  };
}

export function verifyBundledNpmBraceExpansion(npmRoot: string): BundledNpmBraceExpansionState {
  const inspected = inspectBundledNpmBraceExpansion(npmRoot);
  if (inspected.state !== "fixed") {
    throw new Error(
      `npm@${inspected.npmVersion} bundles affected brace-expansion@${inspected.braceExpansionVersion}; expected ${FIXED_BRACE_EXPANSION_VERSION}`,
    );
  }
  return inspected;
}

export function patchBundledNpmBraceExpansion(options: {
  npmRoot: string;
  replacementRoot: string;
}): BundledNpmBraceExpansionState {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(
    options.replacementRoot,
    "replacement brace-expansion root",
  );
  rejectUnsafePackageTree(replacementRoot, "replacement brace-expansion package");
  const replacement = readJson(
    join(replacementRoot, "package.json"),
    "replacement brace-expansion manifest",
  );
  if (
    replacement.name !== "brace-expansion" ||
    replacement.version !== FIXED_BRACE_EXPANSION_VERSION
  ) {
    throw new Error(`replacement package must be brace-expansion@${FIXED_BRACE_EXPANSION_VERSION}`);
  }

  const current = inspectBundledNpmBraceExpansion(npmRoot);
  if (current.state === "fixed") return current;

  const livePath = join(npmRoot, "node_modules", "brace-expansion");
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stagingRoot = mkdtempSync(join(dirname(livePath), ".brace-expansion.nemoclaw-stage-"));
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
    const fixed = verifyBundledNpmBraceExpansion(npmRoot);
    rollbackRequired = false;
    try {
      rmSync(backupPath, { force: true, recursive: true });
    } catch {
      rmSync(backupPath, { force: true, recursive: true });
    }
    return fixed;
  } catch (error) {
    if (rollbackRequired) {
      rmSync(livePath, { force: true, recursive: true });
      renameSync(backupPath, livePath);
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export type BundledNpmBraceExpansionCommandRunner = (
  command: string,
  args: readonly string[],
) => void;

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

function prepareFixedBraceExpansionReplacement(
  commandRunner: BundledNpmBraceExpansionCommandRunner,
): PreparedReplacement {
  const rootDirectory = mkdtempSync(join(tmpdir(), "nemoclaw-npm-brace-expansion-"));
  const archivePath = join(rootDirectory, `brace-expansion-${FIXED_BRACE_EXPANSION_VERSION}.tgz`);
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
      FIXED_BRACE_EXPANSION_TARBALL,
    ]);
    const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archiveBytes: Buffer;
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("brace-expansion replacement download must be a real file");
      }
      archiveBytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (actualIntegrity !== FIXED_BRACE_EXPANSION_INTEGRITY) {
      throw new Error(
        `brace-expansion replacement integrity mismatch\nExpected: ${FIXED_BRACE_EXPANSION_INTEGRITY}\nActual:   ${actualIntegrity}`,
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

export type BundledNpmBraceExpansionRegistryDependencies = Readonly<{
  commandRunner?: BundledNpmBraceExpansionCommandRunner;
  prepareReplacement?: (
    commandRunner: BundledNpmBraceExpansionCommandRunner,
  ) => PreparedReplacement;
}>;

export function patchBundledNpmBraceExpansionFromRegistry(
  npmRoot: string,
  dependencies: BundledNpmBraceExpansionRegistryDependencies = {},
): BundledNpmBraceExpansionState {
  const commandRunner = dependencies.commandRunner ?? run;
  const current = inspectBundledNpmBraceExpansion(npmRoot);
  if (current.state === "fixed") {
    commandRunner("npm", ["--version"]);
    commandRunner("npx", ["--version"]);
    return current;
  }
  const prepared = (dependencies.prepareReplacement ?? prepareFixedBraceExpansionReplacement)(
    commandRunner,
  );
  try {
    const result = patchBundledNpmBraceExpansion({
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
    const result = patchBundledNpmBraceExpansionFromRegistry(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} bundled brace-expansion@${result.braceExpansionVersion}\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
