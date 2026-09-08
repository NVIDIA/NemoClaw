// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_KIND = "nemoclaw-locked-npm-cache-seed-v1";
const MANIFEST_NAME = "manifest.json";
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 6;
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface LockedArchive {
  archive: string;
  integrity: string;
  resolved: string;
}

export interface NpmPlatformTarget {
  cpu: string;
  libc: string;
  os: string;
}

interface SeedManifestArchive extends LockedArchive {
  size: number;
}

interface SeedManifest {
  archiveCount: number;
  archives: SeedManifestArchive[];
  kind: typeof MANIFEST_KIND;
  lockSha256: string;
  target: NpmPlatformTarget;
}

export type ArchiveDownloader = (archive: LockedArchive) => Promise<Uint8Array>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function sha512Bytes(integrity: string): Buffer {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  if (!match) throw new Error("package-lock integrity must use canonical sha512 base64");
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
    throw new Error("package-lock integrity must encode one canonical SHA-512 digest");
  }
  return digest;
}

function archiveName(resolved: string): string {
  const url = new URL(resolved);
  if (
    url.origin !== REGISTRY_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`package-lock archive must use ${REGISTRY_ORIGIN} without credentials`);
  }
  const name = path.posix.basename(url.pathname);
  if (!name.endsWith(".tgz") || name === ".tgz" || name.toLowerCase().includes("%2f")) {
    throw new Error("package-lock archive URL must end in one literal .tgz name");
  }
  return name;
}

function lockSha256(source: Uint8Array): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function archiveIntegrity(source: Uint8Array): string {
  return `sha512-${crypto.createHash("sha512").update(source).digest("base64")}`;
}

function targetValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    throw new Error(`${label} must be one lowercase npm platform identifier`);
  }
  return value;
}

function exactTarget(target: NpmPlatformTarget): NpmPlatformTarget {
  return {
    cpu: targetValue(target.cpu, "target cpu"),
    libc: targetValue(target.libc, "target libc"),
    os: targetValue(target.os, "target os"),
  };
}

function targetAllows(entry: JsonRecord, key: keyof NpmPlatformTarget, target: string): boolean {
  const value = entry[key];
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`package-lock ${key} constraint must be a string array`);
  }
  const denied = value.includes(`!${target}`);
  const allowed = value.filter((item) => !item.startsWith("!"));
  return !denied && (allowed.length === 0 || allowed.includes(target));
}

function dependencyNames(entry: JsonRecord, key: string): string[] {
  const value = entry[key];
  return value === undefined ? [] : Object.keys(record(value, `package-lock ${key}`));
}

function resolveDependencyPath(
  packages: JsonRecord,
  fromPath: string,
  dependency: string,
): string | undefined {
  let directory = fromPath;
  while (true) {
    const candidate = directory
      ? `${directory}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (packages[candidate] !== undefined) return candidate;
    const nestedIndex = directory.lastIndexOf("/node_modules/");
    if (nestedIndex >= 0) {
      directory = directory.slice(0, nestedIndex);
      continue;
    }
    if (directory.startsWith("node_modules/")) {
      directory = "";
      continue;
    }
    return undefined;
  }
}

function reachablePackagePaths(packages: JsonRecord, target: NpmPlatformTarget): string[] {
  const root = record(packages[""], "package-lock root package");
  const queue: Array<{ dependency: string; fromPath: string; optional: boolean; peer: boolean }> =
    [];
  for (const dependency of dependencyNames(root, "dependencies")) {
    queue.push({ dependency, fromPath: "", optional: false, peer: false });
  }
  for (const dependency of dependencyNames(root, "devDependencies")) {
    queue.push({ dependency, fromPath: "", optional: false, peer: false });
  }
  for (const dependency of dependencyNames(root, "optionalDependencies")) {
    queue.push({ dependency, fromPath: "", optional: true, peer: false });
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const edge = queue.shift()!;
    const packagePath = resolveDependencyPath(packages, edge.fromPath, edge.dependency);
    if (packagePath === undefined) {
      // A lock generated with --legacy-peer-deps records the package's peer
      // declaration but correctly omits that peer from the install graph.
      if (edge.optional || edge.peer) continue;
      throw new Error(`package-lock dependency is unresolved: ${edge.dependency}`);
    }
    const entry = record(packages[packagePath], `package-lock entry ${packagePath}`);
    const compatible =
      targetAllows(entry, "os", target.os) &&
      targetAllows(entry, "cpu", target.cpu) &&
      targetAllows(entry, "libc", target.libc);
    if (!compatible) {
      if (edge.optional || entry.optional === true) continue;
      throw new Error(`required package-lock dependency is incompatible: ${packagePath}`);
    }
    if (visited.has(packagePath)) continue;
    visited.add(packagePath);

    for (const dependency of dependencyNames(entry, "dependencies")) {
      queue.push({ dependency, fromPath: packagePath, optional: false, peer: false });
    }
    for (const dependency of dependencyNames(entry, "optionalDependencies")) {
      queue.push({ dependency, fromPath: packagePath, optional: true, peer: false });
    }
    const peerMetadata =
      entry.peerDependenciesMeta === undefined
        ? {}
        : record(entry.peerDependenciesMeta, "package-lock peerDependenciesMeta");
    for (const dependency of dependencyNames(entry, "peerDependencies")) {
      const metadata = peerMetadata[dependency];
      const optional = metadata === undefined ? false : record(metadata, "peer metadata").optional;
      queue.push({ dependency, fromPath: packagePath, optional: optional === true, peer: true });
    }
  }
  return [...visited];
}

export function lockedArchives(
  lockSource: string,
  requestedTarget: NpmPlatformTarget,
): LockedArchive[] {
  const lock = record(JSON.parse(lockSource) as unknown, "package-lock.json");
  if (lock.lockfileVersion !== 3) throw new Error("package-lock.json must use lockfileVersion 3");
  const packages = record(lock.packages, "package-lock.json packages");
  const target = exactTarget(requestedTarget);
  const byArchive = new Map<string, LockedArchive>();
  const byResolved = new Map<string, LockedArchive>();
  const byIntegrity = new Map<string, LockedArchive>();

  for (const packagePath of reachablePackagePaths(packages, target)) {
    const entry = record(packages[packagePath], `package-lock entry ${packagePath}`);
    const resolved = entry.resolved;
    const integrity = entry.integrity;
    if (resolved === undefined && integrity === undefined) continue;
    if (typeof resolved !== "string" || typeof integrity !== "string") {
      throw new Error("package-lock archive entries must define resolved and integrity together");
    }
    sha512Bytes(integrity);
    const archive = archiveName(resolved);
    const candidate = { archive, integrity, resolved };
    const sameArchive = byArchive.get(archive);
    const sameResolved = byResolved.get(resolved);
    const sameIntegrity = byIntegrity.get(integrity);
    if (sameArchive && JSON.stringify(sameArchive) !== JSON.stringify(candidate)) {
      throw new Error(`package-lock archive name is ambiguous: ${archive}`);
    }
    if (sameResolved && sameResolved.integrity !== integrity) {
      throw new Error(`package-lock URL has more than one integrity: ${resolved}`);
    }
    if (sameIntegrity && sameIntegrity.resolved !== resolved) {
      throw new Error("package-lock integrity has more than one registry URL");
    }
    byArchive.set(archive, candidate);
    byResolved.set(resolved, candidate);
    byIntegrity.set(integrity, candidate);
  }

  if (byArchive.size === 0) throw new Error("package-lock.json contains no registry archives");
  return [...byArchive.values()].sort((left, right) => left.archive.localeCompare(right.archive));
}

async function exactFileSource(file: string, label: string): Promise<Buffer> {
  if (!path.isAbsolute(file) || file.includes("\n")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error(`${label} must be one regular non-symlink file`);
  });
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new Error(`${label} must be one regular non-symlink file`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function exactDirectory(directory: string, label: string): Promise<string> {
  if (!path.isAbsolute(directory) || directory.includes("\n")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be one non-symlink directory`);
  }
  return realpath(directory);
}

async function atomicOutputDirectory(
  output: string,
): Promise<{ commit: () => Promise<void>; temporary: string }> {
  if (!path.isAbsolute(output) || output.includes("\n")) {
    throw new Error("output directory must be an absolute path");
  }
  if (path.resolve(output) !== output) throw new Error("output directory must be normalized");
  const parent = await exactDirectory(path.dirname(output), "output parent");
  const destination = path.join(parent, path.basename(output));
  try {
    await lstat(destination);
    throw new Error("output directory must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(path.join(parent, ".locked-npm-cache-seed."));
  await chmod(temporary, 0o700);
  return {
    temporary,
    commit: async () => {
      await rename(temporary, destination);
    },
  };
}

async function defaultDownloadArchive(archive: LockedArchive): Promise<Uint8Array> {
  let lastError: unknown = new Error("archive download did not run");
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(archive.resolved, {
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        throw new Error(`registry returned HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error("registry archive is too large");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error("registry archive size is outside the accepted range");
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new Error(`could not download ${archive.archive}`, { cause: lastError });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index]);
      }
    }),
  );
  return results;
}

export async function materializeLockedNpmCacheSeed(options: {
  downloadArchive?: ArchiveDownloader;
  lockfile: string;
  output: string;
  target: NpmPlatformTarget;
}): Promise<SeedManifest> {
  const lockSource = await exactFileSource(options.lockfile, "lockfile");
  const target = exactTarget(options.target);
  const archives = lockedArchives(lockSource.toString("utf8"), target);
  const downloadArchive = options.downloadArchive ?? defaultDownloadArchive;
  const directory = await atomicOutputDirectory(options.output);
  try {
    const downloaded = await mapConcurrent(archives, DOWNLOAD_CONCURRENCY, async (archive) => {
      const bytes = await downloadArchive(archive);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error(`downloaded archive size is invalid: ${archive.archive}`);
      }
      if (archiveIntegrity(bytes) !== archive.integrity) {
        throw new Error(
          `downloaded archive does not match package-lock integrity: ${archive.archive}`,
        );
      }
      return { archive, bytes };
    });
    const manifest: SeedManifest = {
      archiveCount: downloaded.length,
      archives: downloaded.map(({ archive, bytes }) => ({
        ...archive,
        size: bytes.byteLength,
      })),
      kind: MANIFEST_KIND,
      lockSha256: lockSha256(lockSource),
      target,
    };
    for (const { archive, bytes } of downloaded) {
      const destination = path.join(directory.temporary, archive.archive);
      await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
    }
    await writeFile(
      path.join(directory.temporary, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o444,
      },
    );
    await directory.commit();
    return manifest;
  } catch (error) {
    await rm(directory.temporary, { force: true, recursive: true });
    throw error;
  }
}

function parseManifest(source: string): SeedManifest {
  const manifest = record(JSON.parse(source) as unknown, "npm cache seed manifest");
  if (
    manifest.kind !== MANIFEST_KIND ||
    typeof manifest.lockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.lockSha256) ||
    !Number.isSafeInteger(manifest.archiveCount) ||
    !Array.isArray(manifest.archives) ||
    !manifest.target
  ) {
    throw new Error("npm cache seed manifest header is invalid");
  }
  const archives = manifest.archives.map((value) => {
    const entry = record(value, "npm cache seed manifest archive");
    if (
      typeof entry.archive !== "string" ||
      typeof entry.integrity !== "string" ||
      typeof entry.resolved !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      Number(entry.size) < 1 ||
      Number(entry.size) > MAX_ARCHIVE_BYTES
    ) {
      throw new Error("npm cache seed manifest archive is invalid");
    }
    return {
      archive: entry.archive,
      integrity: entry.integrity,
      resolved: entry.resolved,
      size: Number(entry.size),
    };
  });
  if (manifest.archiveCount !== archives.length) {
    throw new Error("npm cache seed manifest archive count is invalid");
  }
  return {
    archiveCount: Number(manifest.archiveCount),
    archives,
    kind: MANIFEST_KIND,
    lockSha256: manifest.lockSha256,
    target: exactTarget(
      record(manifest.target, "npm cache seed target") as unknown as NpmPlatformTarget,
    ),
  };
}

export async function verifyAndCopyLockedNpmCacheSeed(options: {
  lockfile: string;
  output?: string;
  seed: string;
  target: NpmPlatformTarget;
}): Promise<SeedManifest> {
  const lockSource = await exactFileSource(options.lockfile, "lockfile");
  const target = exactTarget(options.target);
  const expected = lockedArchives(lockSource.toString("utf8"), target);
  const seed = await exactDirectory(options.seed, "seed directory");
  const manifestSource = await exactFileSource(path.join(seed, MANIFEST_NAME), "seed manifest");
  const manifest = parseManifest(manifestSource.toString("utf8"));
  if (manifest.lockSha256 !== lockSha256(lockSource)) {
    throw new Error("npm cache seed manifest does not match the selected package-lock.json");
  }
  if (JSON.stringify(manifest.target) !== JSON.stringify(target)) {
    throw new Error("npm cache seed manifest does not match the selected platform target");
  }
  const expectedManifest = expected.map((archive) => JSON.stringify(archive));
  const actualManifest = manifest.archives.map(({ size: _size, ...archive }) =>
    JSON.stringify(archive),
  );
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error("npm cache seed manifest does not contain the complete locked archive set");
  }
  const entries = await readdir(seed, { withFileTypes: true });
  const expectedNames = [...expected.map(({ archive }) => archive), MANIFEST_NAME].sort();
  const actualNames = entries.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("npm cache seed directory contains missing or unexpected files");
  }
  for (const [index, archive] of expected.entries()) {
    const archivePath = path.join(seed, archive.archive);
    const source = await exactFileSource(archivePath, `seed archive ${archive.archive}`);
    if (
      source.byteLength !== manifest.archives[index].size ||
      archiveIntegrity(source) !== archive.integrity
    ) {
      throw new Error(`npm cache seed archive failed integrity validation: ${archive.archive}`);
    }
  }

  if (options.output !== undefined) {
    const directory = await atomicOutputDirectory(options.output);
    try {
      await chmod(directory.temporary, 0o755);
      for (const archive of expected) {
        const destination = path.join(directory.temporary, archive.archive);
        await copyFile(path.join(seed, archive.archive), destination);
        await chmod(destination, 0o444);
      }
      await directory.commit();
    } catch (error) {
      await rm(directory.temporary, { force: true, recursive: true });
      throw error;
    }
  }
  return manifest;
}

function parseOptions(argv: string[]): {
  command: string;
  cpu: string;
  libc: string;
  lockfile: string;
  os: string;
  output: string;
  seed?: string;
} {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined || options.has(name)) {
      throw new Error("invalid locked npm cache seed arguments");
    }
    options.set(name, value);
  }
  const lockfile = options.get("--lockfile");
  const output = options.get("--output");
  const seed = options.get("--seed");
  const os = options.get("--os");
  const cpu = options.get("--cpu");
  const libc = options.get("--libc");
  const allowed =
    command === "export"
      ? new Set(["--lockfile", "--output", "--os", "--cpu", "--libc"])
      : new Set(["--lockfile", "--output", "--seed", "--os", "--cpu", "--libc"]);
  if (
    (command !== "export" && command !== "copy") ||
    !lockfile ||
    !output ||
    !os ||
    !cpu ||
    !libc ||
    (command === "copy" && !seed) ||
    [...options.keys()].some((name) => !allowed.has(name))
  ) {
    throw new Error(
      "usage: materialize-locked-npm-cache-seed.mts <export|copy> --lockfile <absolute-file> --output <absolute-dir> --os <npm-os> --cpu <npm-cpu> --libc <npm-libc> [--seed <absolute-dir>]",
    );
  }
  return { command, cpu, libc, lockfile, os, output, seed };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const target = { cpu: options.cpu, libc: options.libc, os: options.os };
  const manifest =
    options.command === "export"
      ? await materializeLockedNpmCacheSeed({ ...options, target })
      : await verifyAndCopyLockedNpmCacheSeed({
          lockfile: options.lockfile,
          output: options.output,
          seed: options.seed!,
          target,
        });
  process.stdout.write(`Validated ${manifest.archiveCount} lock-pinned npm archives.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
