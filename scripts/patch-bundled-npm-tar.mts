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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXED_TAR_VERSION = "7.5.20";
export const FIXED_TAR_INTEGRITY =
  "sha512-9FcyK4PA6+WbzlTM9WhQm6vB5W7cP7dUiPsv1g7YDwEQnQ1CGpK3MGlKk/ITVWMk05kHZuBhmVhiv8LZoy/PFQ==";
export const FIXED_TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.20.tgz";
export const MINIMUM_SAFE_TAR_VERSION = "7.5.19";

/**
 * Source boundary for this private npm-tree remediation. The pinned upstream
 * Node images below bundle npm releases whose private tar copies are below the
 * safe floor, so changing NemoClaw's application lockfiles cannot fix them.
 * Remove this patch only after every pinned base changes and an unpatched build
 * from each replacement reports no tar copy below MINIMUM_SAFE_TAR_VERSION.
 * The Dockerfile contract test forces that review whenever either pin changes.
 */
export const NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH = [
  "node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba",
  "node:24-trixie-slim@sha256:05c08ce4291e9a58f59456a7985176defb12cdd42271f35ff81a3e167ea61d4c",
] as const;

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
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${label} must be a real file: ${file}`);
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

function parseVersion(version: unknown, label: string): readonly [number, number, number] {
  if (typeof version !== "string") throw new Error(`${label} must be an exact semver version`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw new Error(`${label} must be an exact semver version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: unknown, minimum: string, label: string): boolean {
  const observed = parseVersion(version, label);
  const required = parseVersion(minimum, "minimum tar version");
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] !== required[index]) return observed[index]! > required[index]!;
  }
  return true;
}

function rejectUnsafeTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`replacement tar package contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafeTree(join(root, entry.name));
  }
}

export type BundledNpmTarState = Readonly<{
  npmVersion: string;
  state: "affected" | "fixed";
  tarVersion: string;
}>;

export function inspectBundledNpmTar(npmRoot: string): BundledNpmTarState {
  const root = realDirectory(npmRoot, "npm package root");
  const manifest = readJson(join(root, "package.json"), "npm package manifest");
  const npmVersion = typeof manifest.version === "string" ? manifest.version : "";
  const [npmMajor] = parseVersion(npmVersion, "npm version");
  const dependencies = record(manifest.dependencies, "npm package dependencies");
  const tarRange = dependencies.tar;
  const bundleDependencies = manifest.bundleDependencies;
  if (
    manifest.name !== "npm" ||
    (npmMajor !== 10 && npmMajor !== 11) ||
    typeof tarRange !== "string" ||
    !/^\^7\.5\.(0|[1-9]\d*)$/u.test(tarRange) ||
    !Array.isArray(bundleDependencies) ||
    bundleDependencies.filter((dependency) => dependency === "tar").length !== 1
  ) {
    throw new Error(
      `npm package identity or bundled tar layout has drifted: ${JSON.stringify({ npmVersion, tarRange })}`,
    );
  }

  const installedTar = readJson(
    join(root, "node_modules", "tar", "package.json"),
    "npm bundled tar manifest",
  );
  if (installedTar.name !== "tar") throw new Error("npm bundled tar package identity has drifted");
  const tarVersion = typeof installedTar.version === "string" ? installedTar.version : "";
  parseVersion(tarVersion, "npm bundled tar version");
  return {
    npmVersion,
    state: versionAtLeast(tarVersion, MINIMUM_SAFE_TAR_VERSION, "npm bundled tar version")
      ? "fixed"
      : "affected",
    tarVersion,
  };
}

export function verifyBundledNpmTar(npmRoot: string): BundledNpmTarState {
  const inspected = inspectBundledNpmTar(npmRoot);
  if (inspected.state !== "fixed") {
    throw new Error(
      `npm@${inspected.npmVersion} bundles affected tar@${inspected.tarVersion}; expected >=${MINIMUM_SAFE_TAR_VERSION}`,
    );
  }
  return inspected;
}

export function patchBundledNpmTar(options: {
  npmRoot: string;
  replacementRoot: string;
}): BundledNpmTarState {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(options.replacementRoot, "replacement tar root");
  rejectUnsafeTree(replacementRoot);
  const replacement = readJson(join(replacementRoot, "package.json"), "replacement tar manifest");
  if (replacement.name !== "tar" || replacement.version !== FIXED_TAR_VERSION) {
    throw new Error(`replacement package must be tar@${FIXED_TAR_VERSION}`);
  }

  const current = inspectBundledNpmTar(npmRoot);
  if (current.state === "fixed") return current;

  const livePath = join(npmRoot, "node_modules", "tar");
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stagingRoot = mkdtempSync(join(dirname(livePath), ".tar.nemoclaw-stage-"));
  const stagedPath = join(stagingRoot, "replacement");
  const backupPath = `${livePath}.nemoclaw-backup-${transactionId}`;
  let mutationStarted = false;
  try {
    cpSync(replacementRoot, stagedPath, { dereference: false, recursive: true });
    cpSync(livePath, backupPath, {
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
    });
    mutationStarted = true;
    rmSync(livePath, { recursive: true });
    renameSync(stagedPath, livePath);
    const fixed = verifyBundledNpmTar(npmRoot);
    if (fixed.tarVersion !== FIXED_TAR_VERSION) {
      throw new Error(`npm bundled tar replacement did not reach tar@${FIXED_TAR_VERSION}`);
    }
    rmSync(backupPath, { force: true, recursive: true });
    return fixed;
  } catch (error) {
    if (mutationStarted) {
      rmSync(livePath, { force: true, recursive: true });
      renameSync(backupPath, livePath);
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export type BundledNpmTarCommandRunner = (command: string, args: readonly string[]) => void;

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

export type BundledNpmTarRegistryDependencies = Readonly<{
  commandRunner?: BundledNpmTarCommandRunner;
  prepareReplacement?: (commandRunner: BundledNpmTarCommandRunner) => PreparedReplacement;
}>;

function prepareFixedTarReplacement(
  commandRunner: BundledNpmTarCommandRunner,
): PreparedReplacement {
  const rootDirectory = mkdtempSync(join(tmpdir(), "nemoclaw-npm-tar-bootstrap-"));
  const archivePath = join(rootDirectory, `tar-${FIXED_TAR_VERSION}.tgz`);
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
      FIXED_TAR_TARBALL,
    ]);
    const archiveDescriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archiveBytes: Buffer;
    try {
      if (!fstatSync(archiveDescriptor).isFile()) {
        throw new Error("npm bundled tar replacement download must be a real file");
      }
      archiveBytes = readFileSync(archiveDescriptor);
    } finally {
      closeSync(archiveDescriptor);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (actualIntegrity !== FIXED_TAR_INTEGRITY) {
      throw new Error(
        `npm bundled tar replacement integrity mismatch\nExpected: ${FIXED_TAR_INTEGRITY}\nActual:   ${actualIntegrity}`,
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

export function patchBundledNpmTarFromRegistry(
  npmRoot: string,
  dependencies: BundledNpmTarRegistryDependencies = {},
): BundledNpmTarState {
  const commandRunner = dependencies.commandRunner ?? run;
  const current = inspectBundledNpmTar(npmRoot);
  if (current.state === "fixed") {
    commandRunner("npm", ["--version"]);
    commandRunner("npx", ["--version"]);
    return current;
  }
  const prepared = (dependencies.prepareReplacement ?? prepareFixedTarReplacement)(commandRunner);
  try {
    const result = patchBundledNpmTar({
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
    const result = patchBundledNpmTarFromRegistry(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} bundled tar@${result.tarVersion} (minimum ${MINIMUM_SAFE_TAR_VERSION})\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
