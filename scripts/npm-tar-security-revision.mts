// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitStagedReplacementTransaction,
  discardStagedReplacements,
  type StagedReplacement,
  stageDirectoryReplacement,
  stageFileReplacement,
} from "./lib/staged-replacement-transaction.mts";

export const FIXED_TAR_VERSION = "7.5.19";
export const FIXED_TAR_INTEGRITY =
  "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==";
export const FIXED_TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz";

const VULNERABLE_TAR_VERSION = "7.5.11";
const VULNERABLE_TAR_INTEGRITY =
  "sha512-ChjMH33/KetonMTAtpYdgUFr0tbz69Fp2v7zWxQfYZX4g5ZN2nOBXm1R2xyA+lMIKrLKIoKAwFj93jE/avX9cQ==";
const VULNERABLE_TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.11.tgz";
const BACKUP_MARKER = "nemoclaw-tar-security-revision.json";

type JsonRecord = Record<string, unknown>;
type RevisionState = "fixed" | "vulnerable";

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function realDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

function readRealFile(file: string, label: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a real file: ${file}: ${String(error)}`);
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a real file: ${file}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readJson(file: string, label: string): JsonRecord {
  const contents = readRealFile(file, label);
  try {
    return record(JSON.parse(contents.toString("utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  }
}

function rejectUnsafeTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`replacement tar package contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafeTree(path.join(root, entry.name));
  }
}

function stageJsonPair(
  manifestPath: string,
  manifest: JsonRecord,
  lockPath: string,
  lock: JsonRecord,
): StagedReplacement[] {
  const replacements: StagedReplacement[] = [];
  try {
    replacements.push(
      stageFileReplacement({
        contents: `${JSON.stringify(manifest, null, 2)}\n`,
        label: "NemoClaw package manifest",
        livePath: manifestPath,
      }),
    );
    replacements.push(
      stageFileReplacement({
        contents: `${JSON.stringify(lock, null, 2)}\n`,
        label: "NemoClaw package lock",
        livePath: lockPath,
      }),
    );
    return replacements;
  } catch (error) {
    discardStagedReplacements(replacements);
    throw error;
  }
}

function inspectNemoClawMetadata(packageRoot: string): {
  lock: JsonRecord;
  manifest: JsonRecord;
  state: RevisionState;
} {
  const manifest = readJson(path.join(packageRoot, "package.json"), "NemoClaw package manifest");
  const lock = readJson(path.join(packageRoot, "package-lock.json"), "NemoClaw package lock");
  const manifestDependencies = record(manifest.dependencies, "NemoClaw manifest dependencies");
  const packages = record(lock.packages, "NemoClaw lock packages");
  const rootLock = record(packages[""], "NemoClaw root lock package");
  const rootDependencies = record(rootLock.dependencies, "NemoClaw root lock dependencies");
  const tarLock = record(packages["node_modules/tar"], "NemoClaw tar lock package");

  if (
    manifest.name !== "nemoclaw" ||
    manifest.version !== "0.1.0" ||
    lock.name !== "nemoclaw" ||
    lock.version !== "0.1.0" ||
    lock.lockfileVersion !== 3 ||
    rootLock.name !== "nemoclaw" ||
    rootLock.version !== "0.1.0"
  ) {
    throw new Error("historical NemoClaw package identity does not match the review");
  }

  const observed = {
    integrity: tarLock.integrity,
    manifest: manifestDependencies.tar,
    resolved: tarLock.resolved,
    rootLock: rootDependencies.tar,
    version: tarLock.version,
  };
  const vulnerable = {
    integrity: VULNERABLE_TAR_INTEGRITY,
    manifest: "^7.0.0",
    resolved: VULNERABLE_TAR_TARBALL,
    rootLock: "^7.0.0",
    version: VULNERABLE_TAR_VERSION,
  };
  const fixed = {
    integrity: FIXED_TAR_INTEGRITY,
    manifest: FIXED_TAR_VERSION,
    resolved: FIXED_TAR_TARBALL,
    rootLock: FIXED_TAR_VERSION,
    version: FIXED_TAR_VERSION,
  };
  if (JSON.stringify(observed) === JSON.stringify(vulnerable)) {
    return { lock, manifest, state: "vulnerable" };
  }
  if (JSON.stringify(observed) === JSON.stringify(fixed)) return { lock, manifest, state: "fixed" };
  throw new Error(
    `historical NemoClaw tar metadata is mixed or has drifted: ${JSON.stringify(observed)}`,
  );
}

function setFixedNemoClawMetadata(manifest: JsonRecord, lock: JsonRecord): void {
  record(manifest.dependencies, "NemoClaw manifest dependencies").tar = FIXED_TAR_VERSION;
  const packages = record(lock.packages, "NemoClaw lock packages");
  record(
    record(packages[""], "NemoClaw root lock package").dependencies,
    "NemoClaw root lock dependencies",
  ).tar = FIXED_TAR_VERSION;
  const tarLock = record(packages["node_modules/tar"], "NemoClaw tar lock package");
  tarLock.version = FIXED_TAR_VERSION;
  tarLock.resolved = FIXED_TAR_TARBALL;
  tarLock.integrity = FIXED_TAR_INTEGRITY;
}

function writeBackup(options: {
  backupDirectory: string;
  packageRoot: string;
  state: RevisionState;
}): void {
  const backupDirectory = realDirectory(options.backupDirectory, "backup directory");
  if (readdirSync(backupDirectory).length !== 0) throw new Error("backup directory must be empty");
  const rootMetadata = statSync(options.packageRoot);
  writeFileSync(
    path.join(backupDirectory, "package.json"),
    readRealFile(path.join(options.packageRoot, "package.json"), "NemoClaw package manifest"),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(backupDirectory, "package-lock.json"),
    readRealFile(path.join(options.packageRoot, "package-lock.json"), "NemoClaw package lock"),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(backupDirectory, BACKUP_MARKER),
    `${JSON.stringify({
      device: String(rootMetadata.dev),
      inode: String(rootMetadata.ino),
      packageRoot: realpathSync(options.packageRoot),
      schema: 1,
      state: options.state,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

export function prepareHistoricalNemoClawInstall(options: {
  backupDirectory: string;
  packageRoot: string;
}): RevisionState {
  const packageRoot = realDirectory(options.packageRoot, "NemoClaw package root");
  const inspected = inspectNemoClawMetadata(packageRoot);
  writeBackup({ ...options, packageRoot, state: inspected.state });
  if (inspected.state === "fixed") return inspected.state;

  setFixedNemoClawMetadata(inspected.manifest, inspected.lock);
  const replacements = stageJsonPair(
    path.join(packageRoot, "package.json"),
    inspected.manifest,
    path.join(packageRoot, "package-lock.json"),
    inspected.lock,
  );
  commitStagedReplacementTransaction({
    replacements,
    verify: () => {
      if (inspectNemoClawMetadata(packageRoot).state !== "fixed") {
        throw new Error("NemoClaw tar metadata revision did not reach the fixed state");
      }
    },
  });
  return inspected.state;
}

export function restoreHistoricalNemoClawInstall(options: {
  backupDirectory: string;
  packageRoot: string;
}): void {
  const packageRoot = realDirectory(options.packageRoot, "NemoClaw package root");
  const backupDirectory = realDirectory(options.backupDirectory, "backup directory");
  const marker = readJson(path.join(backupDirectory, BACKUP_MARKER), "backup marker");
  const rootMetadata = statSync(packageRoot);
  if (
    marker.schema !== 1 ||
    marker.packageRoot !== packageRoot ||
    marker.device !== String(rootMetadata.dev) ||
    marker.inode !== String(rootMetadata.ino) ||
    (marker.state !== "vulnerable" && marker.state !== "fixed")
  ) {
    throw new Error("backup marker does not match the NemoClaw package root");
  }
  if (inspectNemoClawMetadata(packageRoot).state !== "fixed") {
    throw new Error("refusing to restore over unexpected NemoClaw metadata");
  }
  const manifestPath = path.join(packageRoot, "package.json");
  const lockPath = path.join(packageRoot, "package-lock.json");
  const manifestBackup = readRealFile(
    path.join(backupDirectory, "package.json"),
    "backed-up NemoClaw package manifest",
  );
  const lockBackup = readRealFile(
    path.join(backupDirectory, "package-lock.json"),
    "backed-up NemoClaw package lock",
  );
  const replacements: StagedReplacement[] = [];
  try {
    replacements.push(
      stageFileReplacement({
        contents: manifestBackup,
        label: "NemoClaw package manifest rollback",
        livePath: manifestPath,
      }),
      stageFileReplacement({
        contents: lockBackup,
        label: "NemoClaw package lock rollback",
        livePath: lockPath,
      }),
    );
  } catch (error) {
    discardStagedReplacements(replacements);
    throw error;
  }
  commitStagedReplacementTransaction({
    replacements,
    verify: () => {
      const restored = inspectNemoClawMetadata(packageRoot);
      if (restored.state !== marker.state) throw new Error("NemoClaw metadata rollback failed");
    },
  });
}

export function verifyHistoricalNemoClawInstall(packageRoot: string): void {
  const root = realDirectory(packageRoot, "NemoClaw package root");
  if (inspectNemoClawMetadata(root).state !== "fixed") {
    throw new Error("NemoClaw tar metadata is not fixed");
  }
  const installedTar = readJson(
    path.join(root, "node_modules", "tar", "package.json"),
    "installed NemoClaw tar manifest",
  );
  if (installedTar.name !== "tar" || installedTar.version !== FIXED_TAR_VERSION) {
    throw new Error(`installed NemoClaw tar must be tar@${FIXED_TAR_VERSION}`);
  }
}

function inspectBundledNpm(npmRoot: string): { manifest: JsonRecord; state: RevisionState } {
  const manifest = readJson(path.join(npmRoot, "package.json"), "npm package manifest");
  const dependencies = record(manifest.dependencies, "npm package dependencies");
  const bundleDependencies = manifest.bundleDependencies;
  if (
    manifest.name !== "npm" ||
    manifest.version !== "10.9.7" ||
    !Array.isArray(bundleDependencies) ||
    bundleDependencies.filter((dependency) => dependency === "tar").length !== 1
  ) {
    throw new Error("npm package identity or bundled dependency layout does not match npm@10.9.7");
  }
  const installedTar = readJson(
    path.join(npmRoot, "node_modules", "tar", "package.json"),
    "npm bundled tar manifest",
  );
  const observed = { dependency: dependencies.tar, version: installedTar.version };
  if (
    installedTar.name === "tar" &&
    observed.dependency === "^7.5.11" &&
    observed.version === VULNERABLE_TAR_VERSION
  ) {
    return { manifest, state: "vulnerable" };
  }
  if (
    installedTar.name === "tar" &&
    observed.dependency === FIXED_TAR_VERSION &&
    observed.version === FIXED_TAR_VERSION
  ) {
    return { manifest, state: "fixed" };
  }
  throw new Error(`npm bundled tar state is mixed or has drifted: ${JSON.stringify(observed)}`);
}

export function verifyBundledNpmTar(npmRoot: string): void {
  const root = realDirectory(npmRoot, "npm package root");
  if (inspectBundledNpm(root).state !== "fixed") throw new Error("npm bundled tar is not fixed");
}

export function patchBundledNpmTar(options: { npmRoot: string; replacementRoot: string }): void {
  const npmRoot = realDirectory(options.npmRoot, "npm package root");
  const replacementRoot = realDirectory(options.replacementRoot, "replacement tar root");
  rejectUnsafeTree(replacementRoot);
  const replacement = readJson(path.join(replacementRoot, "package.json"), "replacement tar");
  if (replacement.name !== "tar" || replacement.version !== FIXED_TAR_VERSION) {
    throw new Error(`replacement package must be tar@${FIXED_TAR_VERSION}`);
  }
  const inspected = inspectBundledNpm(npmRoot);
  record(inspected.manifest.dependencies, "npm package dependencies").tar = FIXED_TAR_VERSION;
  const replacements: StagedReplacement[] = [];
  try {
    replacements.push(
      stageDirectoryReplacement({
        label: "npm bundled tar package",
        livePath: path.join(npmRoot, "node_modules", "tar"),
        sourcePath: replacementRoot,
      }),
      stageFileReplacement({
        contents: `${JSON.stringify(inspected.manifest, null, 2)}\n`,
        label: "npm package manifest",
        livePath: path.join(npmRoot, "package.json"),
      }),
    );
  } catch (error) {
    discardStagedReplacements(replacements);
    throw error;
  }
  commitStagedReplacementTransaction({
    replacements,
    verify: () => verifyBundledNpmTar(npmRoot),
  });
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function main(): void {
  const modes = [
    "--patch-bundled-npm",
    "--verify-bundled-npm",
    "--prepare-install",
    "--restore-install",
    "--verify-install",
  ].filter((mode) => process.argv.includes(mode));
  if (modes.length !== 1) throw new Error("exactly one npm tar security revision mode is required");
  const mode = modes[0];
  if (mode === "--patch-bundled-npm") {
    patchBundledNpmTar({
      npmRoot: argument("--npm-root"),
      replacementRoot: argument("--replacement-root"),
    });
  } else if (mode === "--verify-bundled-npm") {
    verifyBundledNpmTar(argument("--npm-root"));
  } else if (mode === "--verify-install") {
    verifyHistoricalNemoClawInstall(argument("--nemoclaw-root"));
  } else {
    const options = {
      backupDirectory: argument("--backup-directory"),
      packageRoot: argument("--nemoclaw-root"),
    };
    if (mode === "--prepare-install") prepareHistoricalNemoClawInstall(options);
    else restoreHistoricalNemoClawInstall(options);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
