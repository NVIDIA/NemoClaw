// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getBuildIdentity } from "../core/version";
import { readBoundedRegularFile } from "./bounded-file";

const COMMIT = /^[0-9a-f]{40}$/;
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const TRUSTED_GIT_CONFIG = [
  "--no-replace-objects",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;
export const CUA_BUILD_IDENTITY_FILE = "cua-build-identity.json";
const MAX_CUA_BUILD_IDENTITY_BYTES = 1024;
const MAX_TRACKED_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_GIT_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_GIT_BATCH_OBJECTS = 512;
const GIT_LFS_POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n$/;

export interface CuaBuildIdentity {
  schemaVersion: 1;
  sourceRevision: string;
  sourceClean: boolean;
}

function gitEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function runTrustedGit(
  root: string,
  args: readonly string[],
  maxBuffer = MAX_GIT_METADATA_BYTES,
): Buffer {
  return execFileSync(TRUSTED_GIT_EXECUTABLE, [...TRUSTED_GIT_CONFIG, ...args], {
    cwd: root,
    env: gitEnvironment(root),
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function runTrustedGitWithInput(
  root: string,
  args: readonly string[],
  input: Buffer,
  maxBuffer: number,
): Buffer {
  return execFileSync(TRUSTED_GIT_EXECUTABLE, [...TRUSTED_GIT_CONFIG, ...args], {
    cwd: root,
    env: gitEnvironment(root),
    input,
    maxBuffer,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

interface TrackedBlob {
  filePath: string;
  mode: string;
  object: string;
  size: number;
}

function authoritativeBlobBatch(root: string, blobs: readonly TrackedBlob[]): Buffer[] {
  const input = Buffer.from(`${blobs.map(({ object }) => object).join("\n")}\n`, "ascii");
  const expectedBytes = blobs.reduce((total, { size }) => total + size, 0);
  const output = runTrustedGitWithInput(
    root,
    ["cat-file", "--batch"],
    input,
    expectedBytes + MAX_GIT_METADATA_BYTES,
  );
  const authoritative: Buffer[] = [];
  let offset = 0;
  for (const blob of blobs) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("CUA Git blob batch has an invalid header");
    const header = output.subarray(offset, headerEnd).toString("ascii");
    if (header !== `${blob.object} blob ${blob.size}`) {
      throw new Error("CUA Git blob batch does not match the exact commit tree");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + blob.size;
    if (contentEnd >= output.byteLength || output[contentEnd] !== 0x0a) {
      throw new Error("CUA Git blob batch has an invalid content boundary");
    }
    authoritative.push(output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== output.byteLength) throw new Error("CUA Git blob batch has trailing output");
  return authoritative;
}

function trackedPath(root: string, rawPath: Buffer): string {
  const relative = rawPath.toString("utf8");
  if (
    relative.length === 0 ||
    !Buffer.from(relative, "utf8").equals(rawPath) ||
    path.isAbsolute(relative) ||
    path.normalize(relative) !== relative ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("CUA source contains an unsupported tracked path");
  }
  return path.join(root, relative);
}

function regularFileMatches(
  filePath: string,
  expectedExecutable: boolean,
  authoritative: Buffer,
): boolean {
  const lfsPointer = GIT_LFS_POINTER.exec(authoritative.toString("ascii"));
  const lfsSize = lfsPointer?.[2] === undefined ? null : Number(lfsPointer[2]);
  if (
    lfsPointer !== null &&
    (!Number.isSafeInteger(lfsSize) ||
      lfsSize === null ||
      lfsSize < 0 ||
      lfsSize > MAX_TRACKED_SOURCE_BYTES)
  ) {
    return false;
  }
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o7022n) !== 0n ||
      ((before.mode & 0o111n) !== 0n) !== expectedExecutable ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      (lfsSize !== null && before.size !== BigInt(lfsSize))
    ) {
      throw new Error("CUA tracked file type or mode does not match HEAD");
    }
    const size = Number(before.size);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = lfsPointer === null ? null : createHash("sha256");
    let position = 0;
    while (position < size) {
      const length = fs.readSync(
        handle,
        buffer,
        0,
        Math.min(buffer.byteLength, size - position),
        position,
      );
      if (length === 0) throw new Error("CUA tracked file changed while it was inspected");
      const chunk = buffer.subarray(0, length);
      if (hash !== null) {
        hash.update(chunk);
      } else if (!chunk.equals(authoritative.subarray(position, position + length))) {
        return false;
      }
      position += length;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("CUA tracked file changed while it was inspected");
    }
    return hash === null
      ? authoritative.byteLength === size
      : hash.digest("hex") === lfsPointer?.[1];
  } finally {
    fs.closeSync(handle);
  }
}

function symbolicLinkMatches(filePath: string, authoritative: Buffer): boolean {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isSymbolicLink()) throw new Error("CUA tracked link type does not match HEAD");
  const target = fs.readlinkSync(filePath, { encoding: "buffer" });
  const after = fs.lstatSync(filePath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    before.uid !== after.uid ||
    before.gid !== after.gid ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    BigInt(target.byteLength) !== before.size
  ) {
    throw new Error("CUA tracked link changed while it was inspected");
  }
  return target.equals(authoritative);
}

function trackedFilesystemMatchesHead(root: string, sourceRevision: string): boolean {
  const tree = runTrustedGit(root, ["ls-tree", "-lrz", "--full-tree", sourceRevision]);
  const blobs: TrackedBlob[] = [];
  for (const rawEntry of tree.subarray(0, -1).toString("binary").split("\0")) {
    const entry = Buffer.from(rawEntry, "binary");
    const separator = entry.indexOf(0x09);
    if (separator < 0) return false;
    const metadata = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40}) +(-|[0-9]+)$/.exec(
      entry.subarray(0, separator).toString("ascii"),
    );
    if (!metadata) return false;
    const mode = metadata[1];
    const type = metadata[2];
    const object = metadata[3];
    const rawSize = metadata[4];
    if (mode === undefined || type === undefined || object === undefined || rawSize === undefined) {
      return false;
    }
    const filePath = trackedPath(root, entry.subarray(separator + 1));

    if (type === "commit" && mode === "160000") {
      if (!fs.lstatSync(filePath).isDirectory()) return false;
      const entries = fs.readdirSync(filePath);
      if (entries.length === 0) return false;
      const gitMarker = path.join(filePath, ".git");
      const marker = fs.lstatSync(gitMarker);
      if ((!marker.isFile() && !marker.isDirectory()) || marker.isSymbolicLink()) return false;
      if (inspectGitCheckout(filePath, object) !== true) return false;
      continue;
    }
    if (type !== "blob") return false;
    if (!/^[0-9]+$/.test(rawSize ?? "")) return false;
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRACKED_SOURCE_BYTES) return false;
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") return false;
    blobs.push({ filePath, mode, object, size });
  }
  for (let start = 0; start < blobs.length; ) {
    let end = start;
    let bytes = 0;
    while (end < blobs.length && end - start < MAX_GIT_BATCH_OBJECTS) {
      const next = blobs[end];
      if (next === undefined) return false;
      if (end > start && bytes + next.size > MAX_GIT_BATCH_BYTES) break;
      bytes += next.size;
      end += 1;
    }
    const batch = blobs.slice(start, end);
    const authoritative = authoritativeBlobBatch(root, batch);
    for (const [index, blob] of batch.entries()) {
      const expected = authoritative[index];
      if (expected === undefined || expected.byteLength !== blob.size) return false;
      if (blob.mode === "120000") {
        if (!symbolicLinkMatches(blob.filePath, expected)) return false;
      } else if (!regularFileMatches(blob.filePath, blob.mode === "100755", expected)) {
        return false;
      }
    }
    start = end;
  }
  return true;
}

function inspectGitCheckout(root: string, sourceRevision: string): boolean | null {
  try {
    const topLevel = runTrustedGit(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    if (fs.realpathSync(topLevel) !== fs.realpathSync(root)) return false;
    if (runTrustedGit(root, ["for-each-ref", "--format=%(refname)", "refs/replace/"]).length) {
      return false;
    }
    const head = runTrustedGit(root, ["rev-parse", "--verify", "HEAD"]).toString("utf8").trim();
    if (head !== sourceRevision) return false;
    const flags = runTrustedGit(root, ["ls-files", "-v", "-z"]);
    for (const entry of flags.subarray(0, -1).toString("binary").split("\0")) {
      const tag = entry[0];
      if (tag === "S" || (tag !== undefined && tag >= "a" && tag <= "z")) return false;
    }
    const indexDiff = runTrustedGit(root, [
      "diff-index",
      "--cached",
      "--name-only",
      "-z",
      sourceRevision,
      "--",
    ]);
    if (indexDiff.length !== 0) return false;
    if (!trackedFilesystemMatchesHead(root, sourceRevision)) return false;
    const untracked = runTrustedGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return untracked.length === 0;
  } catch {
    return null;
  }
}

function hasGitMarker(root: string): boolean {
  try {
    fs.lstatSync(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

function parseStamp(value: unknown): CuaBuildIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CUA build identity must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "schemaVersion\0sourceClean\0sourceRevision") {
    throw new Error("CUA build identity contains unsupported fields");
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.sourceRevision !== "string" ||
    !COMMIT.test(record.sourceRevision) ||
    typeof record.sourceClean !== "boolean"
  ) {
    throw new Error("CUA build identity is invalid");
  }
  return record as unknown as CuaBuildIdentity;
}

function assertPackagedStampAuthority(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error(
      "CUA packaged build identity must be a regular authority file without group/world write access",
    );
  }
  const parent = fs.lstatSync(path.dirname(filePath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) {
    throw new Error(
      "CUA packaged build identity parent must be a trusted directory without group/world write access",
    );
  }
  if (process.platform === "linux") {
    if (stat.uid !== 0) {
      throw new Error("CUA packaged build identity must be installed under root-owned authority");
    }
    let ancestor = path.dirname(filePath);
    while (true) {
      const ancestorStat = fs.lstatSync(ancestor);
      if (
        !ancestorStat.isDirectory() ||
        ancestorStat.isSymbolicLink() ||
        ancestorStat.uid !== 0 ||
        (ancestorStat.mode & 0o022) !== 0
      ) {
        throw new Error(
          "CUA packaged build identity must have a root-owned immutable authority path",
        );
      }
      if (ancestor === path.parse(ancestor).root) break;
      ancestor = path.dirname(ancestor);
    }
  }
}

/** Build-time stamp; a Git failure is unknown and therefore not clean. */
export function createCuaBuildIdentityStamp(
  root: string,
  sourceRevision: string,
): CuaBuildIdentity {
  if (!COMMIT.test(sourceRevision)) {
    throw new Error("CUA requires an exact lowercase 40-character source revision");
  }
  return {
    schemaVersion: 1,
    sourceRevision,
    sourceClean: inspectGitCheckout(root, sourceRevision) === true,
  };
}

export interface ResolveCuaBuildIdentityOptions {
  rootDir?: string;
  buildIdentity?: CuaBuildIdentity;
  /** Test seam for packaged authority metadata; production always uses the strict validator. */
  assertPackagedStampAuthority?: (filePath: string) => void;
}

/**
 * Resolve an exact CUA build identity without changing the existing NemoClaw version shape.
 * A live Git checkout is re-observed; packaged installs use the build-time CUA-only stamp.
 */
export function resolveCurrentCuaBuildIdentity(
  options: ResolveCuaBuildIdentityOptions = {},
): CuaBuildIdentity {
  if (options.buildIdentity) return parseStamp(options.buildIdentity);
  const root = options.rootDir ?? path.resolve(__dirname, "..", "..", "..");
  const sourceRevision = getBuildIdentity({ rootDir: root }).sourceRevision;
  if (!COMMIT.test(sourceRevision)) {
    throw new Error("CUA requires an exact lowercase 40-character source revision");
  }
  const liveClean = inspectGitCheckout(root, sourceRevision);
  if (liveClean !== null || hasGitMarker(root)) {
    return { schemaVersion: 1, sourceRevision, sourceClean: liveClean === true };
  }

  const stampPath = path.join(root, "dist", CUA_BUILD_IDENTITY_FILE);
  let stamp: CuaBuildIdentity;
  try {
    (options.assertPackagedStampAuthority ?? assertPackagedStampAuthority)(stampPath);
    const raw = readBoundedRegularFile(stampPath, {
      label: "CUA packaged build identity",
      minBytes: 2,
      maxBytes: MAX_CUA_BUILD_IDENTITY_BYTES,
    });
    stamp = parseStamp(JSON.parse(raw.toString("utf8")) as unknown);
  } catch {
    throw new Error("CUA build cleanliness could not be proven");
  }
  if (stamp.sourceRevision !== sourceRevision) {
    throw new Error("CUA build identity does not match the executing NemoClaw build");
  }
  return stamp;
}
