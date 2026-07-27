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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const AFFECTED_BRACE_EXPANSION_VERSION = "5.0.7";
export const FIXED_BRACE_EXPANSION_VERSION = "5.0.8";
export const FIXED_BRACE_EXPANSION_INTEGRITY =
  "sha512-JZyDyq3D4AUifKTPOB7DELf6XsB3WdPuNxCtob1vFXPsSXhdAiHBWJ/tJ8HAc9aH84BK+5JFZLNkJKx3G9kzQg==";
export const FIXED_BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz";
export const REVIEWED_NPM_VERSION = "11.18.0";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function readJson(file: string, label: string): JsonRecord {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a real file: ${file}`);
    return record(JSON.parse(readFileSync(descriptor, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

function realDirectory(directory: string, label: string): string {
  const resolved = resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

function rejectUnsafeTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(
        `replacement brace-expansion package contains an unsafe member: ${entry.name}`,
      );
    }
    if (entry.isDirectory()) rejectUnsafeTree(join(root, entry.name));
  }
}

function isContainedBinSymlink(
  nodeModulesRoot: string,
  directory: string,
  entryName: string,
): boolean {
  if (basename(directory) !== ".bin") return false;
  try {
    const target = realpathSync(join(directory, entryName));
    const targetRelative = relative(nodeModulesRoot, target);
    return (
      targetRelative !== "" &&
      targetRelative !== ".." &&
      !targetRelative.startsWith(`..${sep}`) &&
      !isAbsolute(targetRelative) &&
      lstatSync(target).isFile()
    );
  } catch {
    return false;
  }
}

function collectBraceExpansionVersions(
  directory: string,
  nodeModulesRoot: string,
  versions: string[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      if (!isContainedBinSymlink(nodeModulesRoot, directory, entry.name)) {
        throw new Error(`npm package contains an unsafe symlink: ${join(directory, entry.name)}`);
      }
      continue;
    }
    if (
      entry.isDirectory() &&
      (entry.name.startsWith(".brace-expansion.nemoclaw-stage-") ||
        entry.name.startsWith("brace-expansion.nemoclaw-backup-"))
    ) {
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`npm package contains an unsafe member: ${join(directory, entry.name)}`);
    }
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectBraceExpansionVersions(child, nodeModulesRoot, versions);
      continue;
    }
    if (entry.name !== "package.json") continue;
    const manifest = readJson(child, "npm bundled package manifest");
    if (manifest.name === "brace-expansion") {
      if (typeof manifest.version !== "string") {
        throw new Error("npm bundled brace-expansion version is invalid");
      }
      versions.push(manifest.version);
    }
  }
}

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
    (version !== AFFECTED_BRACE_EXPANSION_VERSION && version !== FIXED_BRACE_EXPANSION_VERSION) ||
    dependencies["balanced-match"] !== "^4.0.2"
  ) {
    throw new Error(
      `npm bundled brace-expansion identity or dependency layout has drifted: ${JSON.stringify({
        dependencies,
        version,
      })}`,
    );
  }

  const versions: string[] = [];
  const nodeModulesRoot = realDirectory(join(root, "node_modules"), "npm node_modules root");
  collectBraceExpansionVersions(nodeModulesRoot, nodeModulesRoot, versions);
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
  rejectUnsafeTree(replacementRoot);
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
