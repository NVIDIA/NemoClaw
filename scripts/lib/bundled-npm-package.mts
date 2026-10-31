// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs, {
  closeSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type JsonObject = Record<string, unknown>;

export function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

export function readJsonObject(file: string, label: string): JsonObject {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a real file: ${file}`);
    return jsonObject(JSON.parse(readFileSync(descriptor, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

function syncMetadataDirectory(filename: string): void {
  const directory = fs.openSync(
    dirname(filename),
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

/** Publish complete verified metadata without modifying the source file in place. */
export function rewriteRegularFile(
  filename: string,
  label: string,
  transform: (original: string) => string,
): void {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let temporary: string | undefined;
  try {
    const initial = fs.fstatSync(descriptor);
    if (!initial.isFile()) throw new Error(`${label} must be a real file`);
    const original = fs.readFileSync(descriptor, "utf8");
    const patched = transform(original);
    if (patched === original) {
      syncMetadataDirectory(filename);
      return;
    }
    const bytes = Buffer.from(patched);
    const stagingPath = `${filename}.nemoclaw-${randomBytes(16).toString("hex")}.tmp`;
    const staging = fs.openSync(
      stagingPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporary = stagingPath;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(staging, bytes, offset, bytes.length - offset, offset);
        if (!written) throw new Error(`${label} write made no progress`);
        offset += written;
      }
      if (!fs.readFileSync(staging).equals(bytes))
        throw new Error(`${label} staged contents failed verification`);
      const staged = fs.fstatSync(staging);
      if (staged.uid !== initial.uid || staged.gid !== initial.gid)
        fs.fchownSync(staging, initial.uid, initial.gid);
      fs.fchmodSync(staging, initial.mode & 0o777);
      fs.fsyncSync(staging);
      const current = fs.lstatSync(filename);
      const observed = fs.fstatSync(descriptor);
      if (
        !current.isFile() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        observed.size !== initial.size ||
        observed.mtimeMs !== initial.mtimeMs ||
        observed.ctimeMs !== initial.ctimeMs
      )
        throw new Error(`${label} changed before writing`);
      fs.renameSync(stagingPath, filename);
      temporary = undefined;
      syncMetadataDirectory(filename);
    } finally {
      fs.closeSync(staging);
    }
  } finally {
    try {
      if (temporary) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

export function requireRealDirectory(directory: string, label: string): string {
  const resolved = resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  return realpathSync(resolved);
}

export function rejectUnsafePackageTree(root: string, label: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`${label} contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafePackageTree(join(root, entry.name), label);
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

export function collectBundledPackageVersions(options: {
  ignoredDirectoryPrefixes: readonly string[];
  nodeModulesRoot: string;
  packageName: string;
}): string[] {
  const versions: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        if (!isContainedBinSymlink(options.nodeModulesRoot, directory, entry.name)) {
          throw new Error(`npm package contains an unsafe symlink: ${join(directory, entry.name)}`);
        }
        continue;
      }
      if (
        entry.isDirectory() &&
        options.ignoredDirectoryPrefixes.some((prefix) => entry.name.startsWith(prefix))
      ) {
        continue;
      }
      const child = join(directory, entry.name);
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error(`npm package contains an unsafe member: ${child}`);
      }
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (entry.name !== "package.json") continue;
      const manifest = readJsonObject(child, "npm bundled package manifest");
      if (manifest.name !== options.packageName) continue;
      if (typeof manifest.version !== "string") {
        throw new Error(`npm bundled ${options.packageName} version is invalid`);
      }
      versions.push(manifest.version);
    }
  };
  visit(options.nodeModulesRoot);
  return versions;
}

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

type RetainedBackupOptions = {
  npmRoot: string;
  packageName: "ip-address" | "undici";
  verifyBackup: (manifest: JsonObject) => void;
};

const stagingMarker = "nemoclaw-owner.json";

// A PID is meaningful only in the same host boot and, on Linux, PID namespace.
// If this identity cannot be established, retain the stage for manual inspection.
function stagingProcessScope(): string {
  if (process.platform === "linux") {
    return JSON.stringify([
      hostname(),
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      fs.readlinkSync("/proc/self/ns/pid"),
    ]);
  }
  if (process.platform === "darwin") {
    const boot = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (boot.status !== 0 || !/^[a-f0-9-]{36}$/i.test(boot.stdout.trim())) {
      throw new Error("staging boot identity is unavailable");
    }
    return JSON.stringify([hostname(), "darwin", boot.stdout.trim()]);
  }
  throw new Error("staging process identity is unavailable on this platform");
}

function sameDirectory(left: fs.Stats, right: fs.Stats): boolean {
  return right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

function packageTreeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    const initial = lstatSync(directory);
    if (!initial.isDirectory()) throw new Error("backup comparison requires real directories");
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const descriptor = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = fstatSync(descriptor);
        hash.update(JSON.stringify([relative(root, file), before.mode & 0o777]));
        if (before.isDirectory()) {
          hash.update("directory");
          visit(file);
        } else {
          if (!before.isFile() || before.nlink !== 1)
            throw new Error("backup comparison requires unlinked regular files");
          const bytes = readFileSync(descriptor);
          hash.update(JSON.stringify(["file", bytes.length]));
          hash.update(bytes);
        }
        const after = fstatSync(descriptor);
        const current = lstatSync(file);
        if (
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          after.mode !== before.mode ||
          after.nlink !== before.nlink ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error("package changed during backup comparison");
      } finally {
        closeSync(descriptor);
      }
    }
    const final = lstatSync(directory);
    if (
      !sameDirectory(initial, final) ||
      initial.mtimeMs !== final.mtimeMs ||
      initial.ctimeMs !== final.ctimeMs
    )
      throw new Error("package directory changed during backup comparison");
  };
  visit(root);
  return hash.digest("hex");
}

function markBundledPackageStage(stage: string, packageName: string): void {
  const parent = dirname(stage);
  const parentStat = lstatSync(parent);
  const stageStat = lstatSync(stage);
  const marker = {
    schemaVersion: 1,
    packageName,
    parent,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    stage: basename(stage),
    stageDevice: stageStat.dev,
    stageInode: stageStat.ino,
    uid: stageStat.uid,
    pid: process.pid,
    processScope: stagingProcessScope(),
  };
  const file = join(stage, stagingMarker);
  const descriptor = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(marker)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncMetadataDirectory(file);
  syncMetadataDirectory(stage);
}

function reconcileBundledPackageStages(parent: string, packageName: string): void {
  const parentStat = lstatSync(parent);
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(`.${packageName}.nemoclaw-stage-`)) continue;
    const stage = join(parent, name);
    try {
      const stageStat = lstatSync(stage);
      if (
        parentStat.uid !== process.getuid?.() ||
        (parentStat.mode & 0o022) !== 0 ||
        !stageStat.isDirectory() ||
        stageStat.uid !== process.getuid?.() ||
        (stageStat.mode & 0o077) !== 0
      )
        throw new Error("stage ownership cannot be verified");
      const file = join(stage, stagingMarker);
      const descriptor = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let marker: JsonObject;
      try {
        const initial = fstatSync(descriptor);
        if (
          !initial.isFile() ||
          initial.nlink !== 1 ||
          initial.uid !== stageStat.uid ||
          (initial.mode & 0o077) !== 0 ||
          initial.size < 1 ||
          initial.size > 4096
        )
          throw new Error("stage marker is not a private regular file");
        marker = jsonObject(JSON.parse(readFileSync(descriptor, "utf8")), "stage marker");
        const current = lstatSync(file);
        const final = fstatSync(descriptor);
        if (
          current.dev !== initial.dev ||
          current.ino !== initial.ino ||
          final.size !== initial.size ||
          final.mtimeMs !== initial.mtimeMs ||
          final.ctimeMs !== initial.ctimeMs
        )
          throw new Error("stage marker changed during recovery");
      } finally {
        closeSync(descriptor);
      }
      if (
        marker.schemaVersion !== 1 ||
        marker.packageName !== packageName ||
        marker.parent !== parent ||
        marker.parentDevice !== parentStat.dev ||
        marker.parentInode !== parentStat.ino ||
        marker.stage !== name ||
        marker.stageDevice !== stageStat.dev ||
        marker.stageInode !== stageStat.ino ||
        marker.uid !== stageStat.uid ||
        marker.processScope !== stagingProcessScope() ||
        typeof marker.pid !== "number" ||
        !Number.isSafeInteger(marker.pid) ||
        marker.pid <= 0
      )
        throw new Error("stage marker does not identify this package, directory and process scope");
      let inactive = false;
      try {
        process.kill(marker.pid, 0);
      } catch (error) {
        inactive = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!inactive) throw new Error("stage creator is active or its exit cannot be verified");
      rejectUnsafePackageTree(stage, "retained npm package stage");
      if (
        !sameDirectory(parentStat, lstatSync(parent)) ||
        !sameDirectory(stageStat, lstatSync(stage))
      ) {
        throw new Error("stage directory changed during recovery");
      }
      // Old stages have no backup receipt. Never infer ownership from a filename alone.
      if (marker.backup !== undefined) {
        const backup = jsonObject(marker.backup, "stage backup receipt");
        const prefix = `${packageName}.nemoclaw-backup-`;
        if (
          typeof backup.name !== "string" ||
          !backup.name.startsWith(prefix) ||
          !/^[1-9][0-9]*-[a-f0-9]{16}$/.test(backup.name.slice(prefix.length))
        )
          throw new Error("stage backup name is invalid");
        const backupPath = join(parent, backup.name);
        const backupStat = lstatSync(backupPath, { throwIfNoEntry: false });
        const livePath = join(parent, packageName);
        const liveStat = lstatSync(livePath, { throwIfNoEntry: false });
        if (
          backupStat &&
          liveStat &&
          liveStat.dev === backup.liveDevice &&
          liveStat.ino === backup.liveInode
        ) {
          if (
            readdirSync(parent).filter((entry) => entry.startsWith(prefix)).length !== 1 ||
            !backupStat.isDirectory() ||
            backupStat.dev !== backup.device ||
            backupStat.ino !== backup.inode ||
            packageTreeDigest(livePath) !== backup.digest ||
            packageTreeDigest(backupPath) !== backup.digest
          )
            throw new Error(
              "owned backup and original package no longer match; inspect before retrying",
            );
          if (
            !sameDirectory(parentStat, lstatSync(parent)) ||
            !sameDirectory(liveStat, lstatSync(livePath)) ||
            !sameDirectory(backupStat, lstatSync(backupPath))
          )
            throw new Error("backup directory changed during recovery");
          removeBackup(backupPath);
          syncMetadataDirectory(backupPath);
        }
      }
      rmSync(stage, { recursive: true });
      syncMetadataDirectory(stage);
    } catch (error) {
      console.error(
        `npm bundled ${packageName} staging recovery incomplete; inspect before removing ${JSON.stringify(stage)}: ${String(error)}`,
      );
    }
  }
}

// Only one recognized backup is eligible; ambiguous or unverifiable trees stay intact.
function verifiedRetainedBackup(options: RetainedBackupOptions): string | undefined {
  const parent = requireRealDirectory(
    join(options.npmRoot, "node_modules"),
    "npm node_modules root",
  );
  const prefix = `${options.packageName}.nemoclaw-backup-`;
  const backups = readdirSync(parent).filter((entry) => entry.startsWith(prefix));
  if (backups.length === 0) return undefined;
  const backupPath = join(parent, backups[0]);
  if (backups.length !== 1 || !/^[1-9][0-9]*-[a-f0-9]{16}$/.test(backups[0].slice(prefix.length))) {
    throw new Error(
      `npm bundled ${options.packageName} has an ambiguous retained backup; inspect before retrying: ${backupPath}`,
    );
  }
  try {
    requireRealDirectory(backupPath, "retained npm package backup");
    rejectUnsafePackageTree(backupPath, "retained npm package backup");
    options.verifyBackup(
      readJsonObject(join(backupPath, "package.json"), "retained npm package backup manifest"),
    );
  } catch (error) {
    throw new Error(
      `npm bundled ${options.packageName} retained backup cannot be verified; inspect before retrying: ${backupPath}`,
      { cause: error },
    );
  }
  return backupPath;
}

// Callers validate npm identity first. Never replace an existing path, including a dangling link.
// Only inactive, verified owned stages are removed; unknown stages are retained and reported.
export function restoreMissingBundledPackage(options: RetainedBackupOptions): void {
  const parent = requireRealDirectory(
    join(options.npmRoot, "node_modules"),
    "npm node_modules root",
  );
  const livePath = join(parent, options.packageName);
  reconcileBundledPackageStages(parent, options.packageName);
  if (lstatSync(livePath, { throwIfNoEntry: false })) return;
  const backupPath = verifiedRetainedBackup(options);
  if (backupPath) renameSync(backupPath, livePath);
}

// A previous invocation may have installed the verified package but failed cleanup.
export function reconcileBundledPackageBackup(
  options: RetainedBackupOptions & {
    fixed: boolean;
  },
): void {
  const backupPath = verifiedRetainedBackup(options);
  if (!backupPath) return;
  if (!options.fixed) {
    throw new Error(
      `npm bundled ${options.packageName} has an ambiguous retained backup; inspect before retrying: ${backupPath}`,
    );
  }
  removeBackup(backupPath);
}

export function replaceBundledPackage<State>(options: {
  npmRoot: string;
  packageName: "ip-address" | "undici";
  replacementRoot: string;
  verify: (npmRoot: string) => State;
}): State {
  const { npmRoot, packageName, replacementRoot, verify } = options;
  const parent = requireRealDirectory(join(npmRoot, "node_modules"), "npm node_modules root");
  const livePath = join(parent, packageName);
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const stagingRoot = mkdtempSync(join(dirname(livePath), `.${packageName}.nemoclaw-stage-`));
  const stagedPath = join(stagingRoot, "replacement");
  const stagedBackupPath = join(stagingRoot, "backup");
  const backupPath = `${livePath}.nemoclaw-backup-${transactionId}`;
  let rollbackRequired = false;
  try {
    const liveStat = lstatSync(livePath);
    const liveDigest = packageTreeDigest(livePath);
    markBundledPackageStage(stagingRoot, packageName);
    cpSync(replacementRoot, stagedPath, { dereference: false, recursive: true });
    cpSync(livePath, stagedBackupPath, {
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
    });
    const backupStat = lstatSync(stagedBackupPath);
    if (
      !sameDirectory(liveStat, lstatSync(livePath)) ||
      packageTreeDigest(livePath) !== liveDigest ||
      packageTreeDigest(stagedBackupPath) !== liveDigest
    )
      throw new Error("original package changed while preparing its backup");
    rewriteRegularFile(join(stagingRoot, stagingMarker), "stage backup receipt", (original) =>
      JSON.stringify({
        ...jsonObject(JSON.parse(original), "stage marker"),
        backup: {
          name: basename(backupPath),
          device: backupStat.dev,
          inode: backupStat.ino,
          liveDevice: liveStat.dev,
          liveInode: liveStat.ino,
          digest: liveDigest,
        },
      }),
    );
    // Rename only this newly copied directory, never a lower-layer overlayfs live directory.
    renameSync(stagedBackupPath, backupPath);
    rollbackRequired = true;
    rmSync(livePath, { recursive: true });
    renameSync(stagedPath, livePath);
    const fixed = verify(npmRoot);
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
          `npm bundled ${packageName} rollback failed; ${backupPath} retains the original tree`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export type BundledNpmCommandRunner = (command: string, args: readonly string[]) => void;

export function runBundledNpmCommand(command: string, args: readonly string[]): void {
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

export type PreparedBundledReplacement = Readonly<{
  cleanup: () => void;
  replacementRoot: string;
}>;

export function prepareBundledPackageReplacement(options: {
  packageName: "ip-address" | "undici";
  version: string;
  integrity: string;
  tarball: string;
  offline: boolean;
  commandRunner: BundledNpmCommandRunner;
}): PreparedBundledReplacement {
  const { packageName, version, integrity, tarball, commandRunner } = options;
  const rootDirectory = mkdtempSync(join(tmpdir(), `nemoclaw-npm-${packageName}-`));
  const archivePath = join(rootDirectory, `${packageName}-${version}.tgz`);
  const replacementRoot = join(rootDirectory, "replacement");
  try {
    if (options.offline) {
      commandRunner("npm", [
        "pack",
        `${packageName}@${version}`,
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
        tarball,
      ]);
    }
    const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let archiveBytes: Buffer;
    try {
      if (!fstatSync(descriptor).isFile())
        throw new Error(`${packageName} replacement download must be a real file`);
      archiveBytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (actualIntegrity !== integrity) {
      throw new Error(
        `${packageName} replacement integrity mismatch\nExpected: ${integrity}\nActual:   ${actualIntegrity}`,
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

export function remediateBundledPackageFromRegistry<
  State extends { state: "affected" | "fixed" },
>(options: {
  current: State;
  commandRunner: BundledNpmCommandRunner;
  prepareReplacement: (runner: BundledNpmCommandRunner) => PreparedBundledReplacement;
  patch: (replacementRoot: string) => State;
  verifyCommands: (runner: BundledNpmCommandRunner) => void;
}): State {
  if (options.current.state === "fixed") {
    options.verifyCommands(options.commandRunner);
    return options.current;
  }
  const prepared = options.prepareReplacement(options.commandRunner);
  try {
    const result = options.patch(prepared.replacementRoot);
    options.verifyCommands(options.commandRunner);
    return result;
  } finally {
    prepared.cleanup();
  }
}
