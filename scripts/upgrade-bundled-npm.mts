#!/usr/bin/env -S node --experimental-strip-types

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEWED_NPM_VERSION = "11.18.0";
export const REVIEWED_NPM_INTEGRITY =
  "sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW/WJ+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0+vzXysCvAsepbMaBTwnrAD+w==";
export const REVIEWED_NPM_TARBALL = "https://registry.npmjs.org/npm/-/npm-11.18.0.tgz";

export const REVIEWED_NPM_PACKAGES = {
  "brace-expansion": "5.0.7",
  picomatch: "4.0.4",
  sigstore: "4.1.1",
  tar: "7.5.19",
} as const;

const REPLACEABLE_NPM_VERSIONS = new Set(["10.9.8", "11.13.0"]);

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

function npmVersion(npmRoot: string): string {
  const manifest = readJson(join(npmRoot, "package.json"), "npm package manifest");
  if (manifest.name !== "npm" || typeof manifest.version !== "string") {
    throw new Error("npm package identity has drifted");
  }
  return manifest.version;
}

type ReviewedPackageName = keyof typeof REVIEWED_NPM_PACKAGES;

function collectReviewedPackages(
  directory: string,
  packages: Map<ReviewedPackageName, string[]>,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    // npm creates node_modules/.bin symlinks during the reviewed archive install.
    // Do not follow them while inventorying package manifests.
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`npm package contains an unsafe member: ${child}`);
    }
    if (entry.isDirectory()) {
      collectReviewedPackages(child, packages);
      continue;
    }
    if (entry.name !== "package.json") continue;

    const manifest = readJson(child, "bundled npm package manifest");
    const name = manifest.name;
    if (
      typeof name === "string" &&
      Object.hasOwn(REVIEWED_NPM_PACKAGES, name) &&
      typeof manifest.version === "string"
    ) {
      packages.get(name as ReviewedPackageName)?.push(manifest.version);
    }
  }
}

export type ReviewedNpmState = Readonly<{
  npmVersion: string;
  packages: Readonly<Record<ReviewedPackageName, readonly string[]>>;
}>;

export function verifyReviewedNpm(npmRoot: string): ReviewedNpmState {
  const root = realDirectory(npmRoot, "npm package root");
  const version = npmVersion(root);
  if (version !== REVIEWED_NPM_VERSION) {
    throw new Error(`npm@${version} is not reviewed npm@${REVIEWED_NPM_VERSION}`);
  }

  const packages = new Map<ReviewedPackageName, string[]>(
    Object.keys(REVIEWED_NPM_PACKAGES).map((name) => [name as ReviewedPackageName, []]),
  );
  collectReviewedPackages(join(root, "node_modules"), packages);

  for (const [name, expectedVersion] of Object.entries(REVIEWED_NPM_PACKAGES)) {
    const observed = packages.get(name as ReviewedPackageName) ?? [];
    if (observed.length === 0 || observed.some((item) => item !== expectedVersion)) {
      throw new Error(
        `npm@${version} bundled ${name} versions ${JSON.stringify(observed)}; expected only ${expectedVersion}`,
      );
    }
  }

  return {
    npmVersion: version,
    packages: {
      "brace-expansion": packages.get("brace-expansion") ?? [],
      picomatch: packages.get("picomatch") ?? [],
      sigstore: packages.get("sigstore") ?? [],
      tar: packages.get("tar") ?? [],
    },
  };
}

export function verifyReviewedNpmArchive(archivePath: string): void {
  const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`reviewed npm archive must be a real file: ${archivePath}`);
    }
    const integrity = `sha512-${createHash("sha512")
      .update(readFileSync(descriptor))
      .digest("base64")}`;
    if (integrity !== REVIEWED_NPM_INTEGRITY) {
      throw new Error(
        `reviewed npm archive integrity mismatch\nExpected: ${REVIEWED_NPM_INTEGRITY}\nActual:   ${integrity}`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

export type BundledNpmCommandRunner = (command: string, args: readonly string[]) => void;

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`);
  }
}

type PreparedArchive = Readonly<{
  archivePath: string;
  cleanup: () => void;
}>;

function prepareReviewedNpmArchive(commandRunner: BundledNpmCommandRunner): PreparedArchive {
  const rootDirectory = mkdtempSync(join(tmpdir(), "nemoclaw-reviewed-npm-"));
  const archivePath = join(rootDirectory, `npm-${REVIEWED_NPM_VERSION}.tgz`);
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
      REVIEWED_NPM_TARBALL,
    ]);
    verifyReviewedNpmArchive(archivePath);
    return {
      archivePath,
      cleanup: () => rmSync(rootDirectory, { force: true, recursive: true }),
    };
  } catch (error) {
    rmSync(rootDirectory, { force: true, recursive: true });
    throw error;
  }
}

export type BundledNpmUpgradeDependencies = Readonly<{
  commandRunner?: BundledNpmCommandRunner;
  installArchive?: (archivePath: string, commandRunner: BundledNpmCommandRunner) => void;
  prepareArchive?: (commandRunner: BundledNpmCommandRunner) => PreparedArchive;
}>;

function installReviewedNpm(archivePath: string, commandRunner: BundledNpmCommandRunner): void {
  commandRunner("npm", [
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archivePath,
  ]);
}

export function upgradeBundledNpm(
  npmRoot: string,
  dependencies: BundledNpmUpgradeDependencies = {},
): ReviewedNpmState {
  const root = realDirectory(npmRoot, "npm package root");
  const currentVersion = npmVersion(root);
  const commandRunner = dependencies.commandRunner ?? run;

  if (currentVersion === REVIEWED_NPM_VERSION) {
    const reviewed = verifyReviewedNpm(root);
    commandRunner("npm", ["--version"]);
    commandRunner("npx", ["--version"]);
    return reviewed;
  }
  if (!REPLACEABLE_NPM_VERSIONS.has(currentVersion)) {
    throw new Error(
      `npm@${currentVersion} is outside the reviewed upgrade path to npm@${REVIEWED_NPM_VERSION}`,
    );
  }

  const prepared = (dependencies.prepareArchive ?? prepareReviewedNpmArchive)(commandRunner);
  try {
    (dependencies.installArchive ?? installReviewedNpm)(prepared.archivePath, commandRunner);
    const reviewed = verifyReviewedNpm(root);
    commandRunner("npm", ["--version"]);
    commandRunner("npx", ["--version"]);
    return reviewed;
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
    const result = upgradeBundledNpm(argument("--npm-root"));
    process.stdout.write(
      `Verified npm@${result.npmVersion} with ${Object.entries(result.packages)
        .map(([name, versions]) => `${name}@${versions.join(",")}`)
        .join(" ")}\n`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
