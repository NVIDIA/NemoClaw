#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const NPM_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;
const EXACT_NPM_PACKAGE_SPEC =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export type ReviewedNpmArchiveRequest = Readonly<{
  env?: NodeJS.ProcessEnv;
  expectedIntegrity: string;
  label: string;
  npmExecutable?: string;
  packageSpec: string;
  tarballUrl: string;
  tempDirectory?: string;
}>;

export type ReviewedNpmCacheRequest = Readonly<{
  cacheDirectory: string;
  env?: NodeJS.ProcessEnv;
  lockfilePath: string;
  npmExecutable?: string;
  registryOrigin: string;
  tempDirectory?: string;
}>;

export type ReviewedNpmLockRequest = ReviewedNpmArchiveRequest &
  Readonly<{
    expectedLockSha256: string;
    lockfilePath: string;
    registryOrigin: string;
  }>;

export type ReviewedInstalledNpmLockRequest = Readonly<{
  expectedLockSha256: string;
  installRoot: string;
  label: string;
  lockfilePath: string;
  omitDev?: boolean;
}>;

export type ReviewedNpmMetadata = Readonly<{
  integrity: string;
  tarballUrl: string;
}>;

export type ReviewedNpmPackageWithoutIntegrity = Readonly<{
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;

export type ReviewedNpmArchive = Readonly<{
  archivePath: string;
  rootDirectory: string;
}>;

export type ReviewedNpmArchiveFileRequest = Readonly<{
  archivePath: string;
  expectedIntegrity: string;
  label: string;
  maximumBytes?: number;
}>;

type NpmRunner = (args: readonly string[], request: ReviewedNpmArchiveRequest) => string;

function runNpm(args: readonly string[], request: ReviewedNpmArchiveRequest): string {
  const result = spawnSync(request.npmExecutable ?? "npm", args, {
    encoding: "utf-8",
    env: request.env,
    maxBuffer: NPM_OUTPUT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `${request.label} npm ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}

function requireReviewedRequest(request: ReviewedNpmArchiveRequest): void {
  if (!EXACT_NPM_PACKAGE_SPEC.test(request.packageSpec)) {
    throw new Error(`${request.label} must use an exact npm package spec: ${request.packageSpec}`);
  }
  if (!request.expectedIntegrity.startsWith("sha512-")) {
    throw new Error(`${request.label} must use a committed sha512 npm integrity value`);
  }
  if (!request.tarballUrl) {
    throw new Error(`${request.label} must use a committed npm tarball URL`);
  }
}

export function readReviewedNpmArchiveFile(request: ReviewedNpmArchiveFileRequest): Buffer {
  if (!isAbsolute(request.archivePath)) {
    throw new Error(`${request.label} archive path must be absolute`);
  }
  let descriptor: number | undefined;
  try {
    const archivePath = resolve(request.archivePath);
    descriptor = openSync(archivePath, "r");
    const opened = fstatSync(descriptor);
    const pathEntry = lstatSync(archivePath);
    if (
      !opened.isFile() ||
      !pathEntry.isFile() ||
      pathEntry.isSymbolicLink() ||
      opened.dev !== pathEntry.dev ||
      opened.ino !== pathEntry.ino
    ) {
      throw new Error("archive must be a non-symlink regular file");
    }
    if (request.maximumBytes !== undefined && opened.size > request.maximumBytes) {
      throw new Error("archive must be a bounded regular file");
    }
    const archive = readFileSync(descriptor);
    const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (actualIntegrity !== request.expectedIntegrity) {
      throw new Error(
        `${request.label} archive integrity mismatch\nExpected: ${request.expectedIntegrity}\nActual:   ${actualIntegrity}`,
      );
    }
    return archive;
  } catch (error) {
    throw new Error(`${request.label} archive is unreadable: ${String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifyReviewedNpmMetadata(
  request: ReviewedNpmArchiveRequest,
  npmRunner: NpmRunner = runNpm,
): ReviewedNpmMetadata {
  requireReviewedRequest(request);
  const integrity = npmRunner(["view", request.packageSpec, "dist.integrity"], request).trim();
  if (integrity !== request.expectedIntegrity) {
    throw new Error(
      `${request.label} npm integrity mismatch\nExpected: ${request.expectedIntegrity}\nActual:   ${integrity}`,
    );
  }

  const tarballUrl = npmRunner(["view", request.packageSpec, "dist.tarball"], request).trim();
  if (tarballUrl !== request.tarballUrl) {
    throw new Error(
      `${request.label} npm tarball URL mismatch\nExpected: ${request.tarballUrl}\nActual:   ${tarballUrl}`,
    );
  }
  return { integrity, tarballUrl };
}

export function resolveReviewedNpmArchivePath(
  packageSpec: string,
  rootDirectory: string,
  filename: string,
): string {
  if (
    !filename ||
    isAbsolute(filename) ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw new Error(`npm pack ${packageSpec} reported unsafe archive filename: ${filename}`);
  }

  const root = resolve(rootDirectory);
  const archivePath = resolve(root, filename);
  if (!archivePath.startsWith(`${root}${sep}`)) {
    throw new Error(
      `npm pack ${packageSpec} reported archive path outside pack directory: ${filename}`,
    );
  }
  if (!existsSync(archivePath)) {
    throw new Error(`npm pack ${packageSpec} did not create reported archive: ${filename}`);
  }
  const archive = lstatSync(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink()) {
    throw new Error(`npm pack ${packageSpec} reported a non-file archive: ${filename}`);
  }
  return archivePath;
}

export function packReviewedNpmArchive(
  request: ReviewedNpmArchiveRequest,
  npmRunner: NpmRunner = runNpm,
): ReviewedNpmArchive {
  verifyReviewedNpmMetadata(request, npmRunner);
  const rootDirectory = mkdtempSync(
    join(request.tempDirectory ?? tmpdir(), "nemoclaw-reviewed-npm-pack-"),
  );
  try {
    const packJson = npmRunner(
      ["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"],
      request,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(packJson);
    } catch (error) {
      throw new Error(`npm pack ${request.packageSpec} did not return JSON: ${String(error)}`);
    }
    const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
    const filename =
      typeof entry === "object" && entry !== null && "filename" in entry
        ? String(entry.filename ?? "")
        : "";
    const actualIntegrity =
      typeof entry === "object" && entry !== null && "integrity" in entry
        ? String(entry.integrity ?? "")
        : "";
    if (!filename || !actualIntegrity) {
      throw new Error(`npm pack ${request.packageSpec} did not report filename and integrity`);
    }
    if (actualIntegrity !== request.expectedIntegrity) {
      throw new Error(
        `${request.label} downloaded tarball integrity mismatch\nExpected: ${request.expectedIntegrity}\nActual:   ${actualIntegrity}`,
      );
    }
    return {
      archivePath: resolveReviewedNpmArchivePath(request.packageSpec, rootDirectory, filename),
      rootDirectory,
    };
  } catch (error) {
    rmSync(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function removeReviewedNpmArchive(archive: ReviewedNpmArchive): void {
  rmSync(archive.rootDirectory, { recursive: true, force: true });
}

function normalizeRegistryOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`reviewed npm registry origin is invalid: ${value}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`reviewed npm registry must be a credential-free HTTPS origin: ${value}`);
  }
  return parsed.origin;
}

function readReviewedLock(lockfilePath: string): Record<string, Record<string, unknown>> {
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(lockfilePath, "utf-8"));
  } catch (error) {
    throw new Error(`reviewed npm lockfile is unreadable: ${String(error)}`);
  }
  if (typeof lock !== "object" || lock === null || Array.isArray(lock)) {
    throw new Error("reviewed npm lockfile must be a JSON object");
  }
  const lockRecord = lock as Record<string, unknown>;
  if (lockRecord.lockfileVersion !== 3) {
    throw new Error("reviewed npm lock requires lockfileVersion 3");
  }
  const packages = lockRecord.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new Error("reviewed npm lockfile is missing its packages map");
  }
  return packages as Record<string, Record<string, unknown>>;
}

function parseExactPackageSpec(packageSpec: string): { name: string; version: string } {
  if (!EXACT_NPM_PACKAGE_SPEC.test(packageSpec)) {
    throw new Error(`reviewed npm lock must use an exact npm package spec: ${packageSpec}`);
  }
  const separator = packageSpec.lastIndexOf("@");
  return { name: packageSpec.slice(0, separator), version: packageSpec.slice(separator + 1) };
}

function packageNameFromLockLocation(location: string): string {
  const marker = "node_modules/";
  const nestedMarkerIndex = location.lastIndexOf(`/${marker}`);
  const markerIndex =
    nestedMarkerIndex >= 0 ? nestedMarkerIndex + 1 : location.startsWith(marker) ? 0 : -1;
  const packageName = markerIndex >= 0 ? location.slice(markerIndex + marker.length) : "";
  if (!packageName) {
    throw new Error(`reviewed npm lock has an unsupported package location: ${location}`);
  }
  return packageName;
}

type LockDependency = Readonly<{ name: string; optional: boolean }>;

function lockDependencies(
  record: Readonly<Record<string, unknown>>,
  location: string,
): readonly LockDependency[] {
  const dependencies = new Map<string, boolean>();
  for (const [field, optional] of [
    ["dependencies", false],
    ["optionalDependencies", true],
  ] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `reviewed npm lock has an invalid ${field} map: ${location || "root package"}`,
      );
    }
    for (const name of Object.keys(value)) {
      if (!EXACT_NPM_PACKAGE_SPEC.test(`${name}@0.0.0`)) {
        throw new Error(
          `reviewed npm lock has an invalid dependency name: ${location || "root package"}: ${name}`,
        );
      }
      // npm gives optionalDependencies precedence when a package appears in
      // both maps, so the later optional map must replace the required entry.
      dependencies.set(name, optional);
    }
  }

  const peerDependencies = record.peerDependencies;
  const peerDependenciesMeta = record.peerDependenciesMeta;
  if (
    peerDependenciesMeta !== undefined &&
    (typeof peerDependenciesMeta !== "object" ||
      peerDependenciesMeta === null ||
      Array.isArray(peerDependenciesMeta))
  ) {
    throw new Error(
      `reviewed npm lock has an invalid peerDependenciesMeta map: ${location || "root package"}`,
    );
  }
  if (peerDependencies !== undefined) {
    if (
      typeof peerDependencies !== "object" ||
      peerDependencies === null ||
      Array.isArray(peerDependencies)
    ) {
      throw new Error(
        `reviewed npm lock has an invalid peerDependencies map: ${location || "root package"}`,
      );
    }
    for (const name of Object.keys(peerDependencies)) {
      if (!EXACT_NPM_PACKAGE_SPEC.test(`${name}@0.0.0`)) {
        throw new Error(
          `reviewed npm lock has an invalid dependency name: ${location || "root package"}: ${name}`,
        );
      }
      const peerMeta = (peerDependenciesMeta as Record<string, unknown> | undefined)?.[name];
      if (
        peerMeta !== undefined &&
        (typeof peerMeta !== "object" || peerMeta === null || Array.isArray(peerMeta))
      ) {
        throw new Error(
          `reviewed npm lock has invalid peer dependency metadata: ${location || "root package"}: ${name}`,
        );
      }
      const optional = (peerMeta as Record<string, unknown> | undefined)?.optional === true;
      if (!dependencies.has(name)) dependencies.set(name, optional);
    }
  }
  return [...dependencies].map(([name, optional]) => ({ name, optional }));
}

function assertNotProductionDev(
  productionLocations: ReadonlySet<string> | undefined,
  location: string,
  record: Readonly<Record<string, unknown>>,
): void {
  if (productionLocations?.has(location) && record.dev === true) {
    throw new Error(`reviewed npm lock marks a production dependency as dev: true: ${location}`);
  }
}

function resolveLockDependencyLocation(
  packages: Readonly<Record<string, Record<string, unknown>>>,
  requesterLocation: string,
  dependencyName: string,
): string | undefined {
  let ancestorLocation = requesterLocation;
  while (true) {
    const candidate = ancestorLocation
      ? `${ancestorLocation}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (!ancestorLocation) return undefined;
    const parentMarker = ancestorLocation.lastIndexOf("/node_modules/");
    ancestorLocation = parentMarker >= 0 ? ancestorLocation.slice(0, parentMarker) : "";
  }
}

function productionLockLocations(
  packages: Readonly<Record<string, Record<string, unknown>>>,
): ReadonlySet<string> {
  const root = packages[""];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("reviewed npm lock is missing its root package record");
  }

  const reachable = new Set<string>();
  const pending: Array<Readonly<{ location: string; record: Record<string, unknown> }>> = [
    { location: "", record: root },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const dependency of lockDependencies(current.record, current.location)) {
      const location = resolveLockDependencyLocation(packages, current.location, dependency.name);
      if (!location) {
        if (dependency.optional) continue;
        throw new Error(
          `reviewed npm lock is missing a production dependency: ${current.location || "root package"}: ${dependency.name}`,
        );
      }
      if (reachable.has(location)) continue;
      const record = packages[location];
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        throw new Error(`reviewed npm lock has an invalid package record: ${location}`);
      }
      reachable.add(location);
      pending.push({ location, record });
    }
  }
  return reachable;
}

function verifyReviewedLockDigest(
  lockfilePath: string,
  expectedLockSha256: string,
  label: string,
): void {
  if (!/^[0-9a-f]{64}$/.test(expectedLockSha256)) {
    throw new Error(`${label} must use a committed lowercase SHA-256 lock identity`);
  }
  const actualLockSha256 = createHash("sha256").update(readFileSync(lockfilePath)).digest("hex");
  if (actualLockSha256 !== expectedLockSha256) {
    throw new Error(
      `${label} lock SHA-256 mismatch\nExpected: ${expectedLockSha256}\nActual:   ${actualLockSha256}`,
    );
  }
}

function readReviewedLockPackages(
  packages: Readonly<Record<string, Record<string, unknown>>>,
  lockfilePath: string,
  registryOrigin: string,
  omitDev = false,
  allowEmpty = false,
  allowNestedShrinkwrap = false,
  reviewedRegistryPackages: readonly ReviewedNpmArchiveRequest[] = [],
  allowedNestedShrinkwrapPackages: readonly string[] = [],
  reviewedPackagesWithoutIntegrity: readonly ReviewedNpmPackageWithoutIntegrity[] = [],
): readonly ReviewedNpmArchiveRequest[] {
  const reviewed: ReviewedNpmArchiveRequest[] = [];
  const identities = new Map<string, ReviewedNpmArchiveRequest>();
  const reviewedRegistryIdentities = new Map<string, ReviewedNpmArchiveRequest>();
  const allowedNestedShrinkwrapIdentities = new Set(allowedNestedShrinkwrapPackages);
  const reviewedPackagesWithoutIntegrityBySpec = new Map(
    reviewedPackagesWithoutIntegrity.map((reviewed) => [reviewed.packageSpec, reviewed]),
  );
  for (const reviewedPackage of reviewedRegistryPackages) {
    requireReviewedRequest(reviewedPackage);
    let parsedTarball: URL;
    try {
      parsedTarball = new URL(reviewedPackage.tarballUrl);
    } catch {
      throw new Error(`${reviewedPackage.label} must use a valid reviewed npm tarball URL`);
    }
    if (
      parsedTarball.protocol !== "https:" ||
      parsedTarball.username ||
      parsedTarball.password ||
      reviewedRegistryIdentities.has(reviewedPackage.packageSpec)
    ) {
      throw new Error(
        `${reviewedPackage.label} must use one credential-free HTTPS package identity`,
      );
    }
    reviewedRegistryIdentities.set(reviewedPackage.packageSpec, reviewedPackage);
  }
  const productionLocations = omitDev ? productionLockLocations(packages) : undefined;
  for (const [location, value] of Object.entries(packages)) {
    if (location === "") continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`reviewed npm lock has an invalid package record: ${location}`);
    }
    const record = value as Record<string, unknown>;
    assertNotProductionDev(productionLocations, location, record);
    if (omitDev && record.dev === true) continue;
    const locationName = packageNameFromLockLocation(location);
    const packageName = typeof record.name === "string" ? record.name : locationName;
    const version = typeof record.version === "string" ? record.version : "";
    const packageSpec = `${packageName}@${version}`;
    if (
      !allowNestedShrinkwrap &&
      Object.prototype.hasOwnProperty.call(record, "hasShrinkwrap") &&
      !allowedNestedShrinkwrapIdentities.has(packageSpec)
    ) {
      throw new Error(
        `reviewed npm lock package must not delegate to nested shrinkwrap: ${location}`,
      );
    }
    const expectedIntegrity = typeof record.integrity === "string" ? record.integrity : "";
    const tarballUrl = typeof record.resolved === "string" ? record.resolved : "";
    const reviewedPackageWithoutIntegrity = reviewedPackagesWithoutIntegrityBySpec.get(packageSpec);
    if (expectedIntegrity) {
      requireReviewedRequest({
        expectedIntegrity,
        label: `locked npm package ${packageSpec}`,
        packageSpec,
        tarballUrl,
      });
    } else if (
      !reviewedPackageWithoutIntegrity ||
      reviewedPackageWithoutIntegrity.tarballUrl !== tarballUrl
    ) {
      throw new Error(
        `locked npm package ${packageSpec} must use a committed sha512 npm integrity value`,
      );
    }
    let parsedTarball: URL;
    try {
      parsedTarball = new URL(tarballUrl);
    } catch {
      throw new Error(`reviewed npm lock has an invalid tarball URL: ${location}`);
    }
    const reviewedRegistryIdentity = reviewedRegistryIdentities.get(packageSpec);
    if (reviewedRegistryIdentity) {
      if (
        reviewedRegistryIdentity.expectedIntegrity !== expectedIntegrity ||
        reviewedRegistryIdentity.tarballUrl !== tarballUrl ||
        parsedTarball.username ||
        parsedTarball.password
      ) {
        throw new Error(
          `reviewed npm lock package does not match its approved registry identity: ${location}`,
        );
      }
    } else if (
      parsedTarball.origin !== registryOrigin ||
      parsedTarball.username ||
      parsedTarball.password
    ) {
      throw new Error(`reviewed npm lock package must use the reviewed registry: ${location}`);
    }
    const prior = identities.get(packageSpec);
    if (prior) {
      if (prior.expectedIntegrity !== expectedIntegrity || prior.tarballUrl !== tarballUrl) {
        throw new Error(`reviewed npm lock has conflicting package identity: ${packageSpec}`);
      }
      continue;
    }
    const request = {
      expectedIntegrity,
      label: `locked npm package ${packageSpec}`,
      packageSpec,
      tarballUrl,
    };
    identities.set(packageSpec, request);
    if (!reviewedPackageWithoutIntegrity) reviewed.push(request);
  }
  if (!allowEmpty && reviewed.length === 0) {
    throw new Error(`reviewed npm lock contains no packages: ${lockfilePath}`);
  }
  return reviewed;
}

export function verifyReviewedNpmLockPackages(
  request: Readonly<{
    allowedNestedShrinkwrapPackages?: readonly string[];
    allowNestedShrinkwrap?: boolean;
    lockfilePath: string;
    omitDev?: boolean;
    reviewedRegistryPackages?: readonly ReviewedNpmArchiveRequest[];
    reviewedPackagesWithoutIntegrity?: readonly ReviewedNpmPackageWithoutIntegrity[];
    registryOrigin: string;
  }>,
): readonly string[] {
  const registryOrigin = normalizeRegistryOrigin(request.registryOrigin);
  return readReviewedLockPackages(
    readReviewedLock(request.lockfilePath),
    request.lockfilePath,
    registryOrigin,
    request.omitDev,
    true,
    request.allowNestedShrinkwrap,
    request.reviewedRegistryPackages,
    request.allowedNestedShrinkwrapPackages,
    request.reviewedPackagesWithoutIntegrity,
  ).map(({ packageSpec }) => packageSpec);
}

export function verifyReviewedNpmLock(
  request: ReviewedNpmLockRequest,
  npmRunner: NpmRunner = runNpm,
): readonly string[] {
  requireReviewedRequest(request);
  verifyReviewedLockDigest(request.lockfilePath, request.expectedLockSha256, request.label);
  const registryOrigin = normalizeRegistryOrigin(request.registryOrigin);
  const packages = readReviewedLock(request.lockfilePath);
  const { name, version } = parseExactPackageSpec(request.packageSpec);
  const root = packages[""];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("reviewed npm lock is missing its root package record");
  }
  const rootDependencies = root.dependencies;
  const rootOptionalDependencies = root.optionalDependencies;
  if (
    typeof rootDependencies !== "object" ||
    rootDependencies === null ||
    Array.isArray(rootDependencies) ||
    Object.keys(rootDependencies).length !== 1 ||
    (rootDependencies as Record<string, unknown>)[name] !== version ||
    (rootOptionalDependencies !== undefined &&
      (typeof rootOptionalDependencies !== "object" ||
        rootOptionalDependencies === null ||
        Array.isArray(rootOptionalDependencies) ||
        Object.keys(rootOptionalDependencies).length > 0))
  ) {
    throw new Error(`reviewed npm lock root must depend only on ${request.packageSpec}`);
  }

  const topLevel = packages[`node_modules/${name}`];
  if (!topLevel || typeof topLevel !== "object" || Array.isArray(topLevel)) {
    throw new Error(`reviewed npm lock is missing ${request.packageSpec}`);
  }
  if (topLevel.version !== version) {
    throw new Error(
      `reviewed npm lock version mismatch for ${name}: expected ${version}, found ${String(topLevel.version ?? "missing")}`,
    );
  }
  if (topLevel.integrity !== request.expectedIntegrity) {
    throw new Error(`reviewed npm lock integrity mismatch for ${request.packageSpec}`);
  }
  if (topLevel.resolved !== request.tarballUrl) {
    throw new Error(`reviewed npm lock tarball URL mismatch for ${request.packageSpec}`);
  }
  if (Object.prototype.hasOwnProperty.call(topLevel, "hasShrinkwrap")) {
    throw new Error(
      `reviewed npm lock must be authoritative for ${request.packageSpec}; nested shrinkwrap delegation is not allowed`,
    );
  }

  const reviewed = readReviewedLockPackages(packages, request.lockfilePath, registryOrigin);
  verifyReviewedNpmMetadata(request, npmRunner);
  return reviewed.map(({ packageSpec }) => packageSpec);
}

export function verifyInstalledNpmLock(
  request: ReviewedInstalledNpmLockRequest,
): readonly string[] {
  verifyReviewedLockDigest(request.lockfilePath, request.expectedLockSha256, request.label);
  const packages = readReviewedLock(request.lockfilePath);
  const installRoot = resolve(request.installRoot);
  const nodeModulesRoot = resolve(installRoot, "node_modules");
  const verified: string[] = [];
  const productionLocations = request.omitDev ? productionLockLocations(packages) : undefined;

  for (const [location, record] of Object.entries(packages)) {
    if (location === "") continue;
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`${request.label} has an invalid locked package record: ${location}`);
    }
    assertNotProductionDev(productionLocations, location, record);
    if (request.omitDev && record.dev === true) continue;
    const locationName = packageNameFromLockLocation(location);
    const expectedName = typeof record.name === "string" ? record.name : locationName;
    const expectedVersion = typeof record.version === "string" ? record.version : "";
    const packageSpec = `${expectedName}@${expectedVersion}`;
    if (!EXACT_NPM_PACKAGE_SPEC.test(packageSpec)) {
      throw new Error(`${request.label} has an invalid locked package identity: ${packageSpec}`);
    }
    const packageDirectory = resolve(installRoot, location);
    if (!packageDirectory.startsWith(`${nodeModulesRoot}${sep}`)) {
      throw new Error(`${request.label} has an unsafe installed package path: ${location}`);
    }
    let packageEntry;
    try {
      packageEntry = lstatSync(packageDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (record.optional === true) continue;
        throw new Error(`${request.label} is missing installed package: ${packageSpec}`);
      }
      throw error;
    }
    if (!packageEntry.isDirectory() || packageEntry.isSymbolicLink()) {
      throw new Error(
        `${request.label} installed package must be a non-symlink directory: ${location}`,
      );
    }

    const manifestPath = join(packageDirectory, "package.json");
    let manifest: unknown;
    let manifestDescriptor: number | undefined;
    try {
      manifestDescriptor = openSync(manifestPath, "r");
      const openedManifestEntry = fstatSync(manifestDescriptor);
      const pathManifestEntry = lstatSync(manifestPath);
      if (
        !openedManifestEntry.isFile() ||
        !pathManifestEntry.isFile() ||
        pathManifestEntry.isSymbolicLink() ||
        openedManifestEntry.dev !== pathManifestEntry.dev ||
        openedManifestEntry.ino !== pathManifestEntry.ino
      ) {
        throw new Error("manifest must be a non-symlink regular file");
      }
      manifest = JSON.parse(readFileSync(manifestDescriptor, "utf-8"));
    } catch (error) {
      throw new Error(
        `${request.label} installed package manifest is unreadable: ${location}: ${String(error)}`,
      );
    } finally {
      if (manifestDescriptor !== undefined) closeSync(manifestDescriptor);
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error(`${request.label} installed package manifest is invalid: ${location}`);
    }
    const installed = manifest as Record<string, unknown>;
    if (installed.name !== expectedName || installed.version !== expectedVersion) {
      throw new Error(
        `${request.label} installed package identity mismatch at ${location}: expected ${packageSpec}, found ${String(installed.name ?? "missing")}@${String(installed.version ?? "missing")}`,
      );
    }
    verified.push(packageSpec);
  }
  return verified;
}

export function verifyReviewedNpmCache(
  request: ReviewedNpmCacheRequest,
  npmRunner: NpmRunner = runNpm,
): readonly string[] {
  if (!isAbsolute(request.cacheDirectory)) {
    throw new Error(`reviewed npm cache path must be absolute: ${request.cacheDirectory}`);
  }
  const cacheDirectory = resolve(request.cacheDirectory);
  if (!existsSync(cacheDirectory)) {
    throw new Error(`reviewed npm cache does not exist: ${cacheDirectory}`);
  }
  const cache = lstatSync(cacheDirectory);
  if (!cache.isDirectory() || cache.isSymbolicLink()) {
    throw new Error(`reviewed npm cache must be a non-symlink directory: ${cacheDirectory}`);
  }

  const registryOrigin = normalizeRegistryOrigin(request.registryOrigin);
  const packages = readReviewedLockPackages(
    readReviewedLock(request.lockfilePath),
    request.lockfilePath,
    registryOrigin,
  );
  const env = {
    ...process.env,
    ...request.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_REGISTRY: `${registryOrigin}/`,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
  const verified: string[] = [];
  for (const reviewed of packages) {
    const archive = packReviewedNpmArchive(
      {
        ...reviewed,
        env,
        npmExecutable: request.npmExecutable,
        tempDirectory: request.tempDirectory,
      },
      npmRunner,
    );
    removeReviewedNpmArchive(archive);
    verified.push(reviewed.packageSpec);
  }
  return verified;
}

type ArchiveCliOptions = ReviewedNpmArchiveRequest &
  Readonly<{ mode: "archive"; verifyOnly: boolean }>;
type CacheCliOptions = ReviewedNpmCacheRequest & Readonly<{ mode: "cache" }>;
type LockCliOptions = ReviewedNpmLockRequest & Readonly<{ mode: "lock" }>;
type InstalledLockCliOptions = ReviewedInstalledNpmLockRequest &
  Readonly<{ mode: "installed-lock" }>;
type CliOptions = ArchiveCliOptions | CacheCliOptions | LockCliOptions | InstalledLockCliOptions;

function parseCliOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let verifyOnly = false;
  let verifyLock = false;
  let verifyInstalledLock = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (arg === "--verify-lock") {
      verifyLock = true;
      continue;
    }
    if (arg === "--verify-installed-lock") {
      verifyInstalledLock = true;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error(`Unknown argument: ${arg ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  if (values.has("--cache")) {
    if (
      verifyOnly ||
      verifyLock ||
      verifyInstalledLock ||
      values.has("--package-spec") ||
      values.has("--integrity") ||
      values.has("--tarball-url") ||
      values.has("--label")
    ) {
      throw new Error("reviewed npm cache verification cannot be combined with archive options");
    }
    return {
      cacheDirectory: required("--cache"),
      lockfilePath: required("--lockfile"),
      mode: "cache",
      npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
      registryOrigin: required("--registry-origin"),
      tempDirectory: values.get("--temp-directory"),
    };
  }
  if (verifyInstalledLock) {
    if (verifyOnly || verifyLock || values.has("--cache") || values.has("--registry-origin")) {
      throw new Error("installed npm lock verification cannot be combined with other modes");
    }
    return {
      expectedLockSha256: required("--lock-sha256"),
      installRoot: required("--install-root"),
      label: required("--label"),
      lockfilePath: required("--lockfile"),
      mode: "installed-lock",
    };
  }
  if (verifyLock) {
    if (verifyOnly || values.has("--cache")) {
      throw new Error("reviewed npm lock verification cannot be combined with other modes");
    }
    return {
      expectedIntegrity: required("--integrity"),
      expectedLockSha256: required("--lock-sha256"),
      label: required("--label"),
      lockfilePath: required("--lockfile"),
      mode: "lock",
      npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
      packageSpec: required("--package-spec"),
      registryOrigin: required("--registry-origin"),
      tarballUrl: required("--tarball-url"),
      tempDirectory: values.get("--temp-directory"),
    };
  }
  if (values.has("--lockfile") || values.has("--registry-origin") || values.has("--install-root")) {
    throw new Error(
      "--lockfile, --registry-origin, and --install-root require a matching lock mode",
    );
  }
  return {
    expectedIntegrity: required("--integrity"),
    label: required("--label"),
    mode: "archive",
    npmExecutable: process.env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
    packageSpec: required("--package-spec"),
    tarballUrl: required("--tarball-url"),
    tempDirectory: values.get("--temp-directory"),
    verifyOnly,
  };
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
}

if (isMainModule()) {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (options.mode === "cache") {
      const verified = verifyReviewedNpmCache(options);
      process.stdout.write(`Verified ${verified.length} locked npm cache archives\n`);
    } else if (options.mode === "installed-lock") {
      const verified = verifyInstalledNpmLock(options);
      process.stdout.write(`Verified ${verified.length} installed npm package identities\n`);
    } else if (options.mode === "lock") {
      const verified = verifyReviewedNpmLock(options);
      process.stdout.write(`Verified ${verified.length} locked npm packages\n`);
    } else if (options.verifyOnly) {
      verifyReviewedNpmMetadata(options);
    } else {
      process.stdout.write(`${packReviewedNpmArchive(options).archivePath}\n`);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
