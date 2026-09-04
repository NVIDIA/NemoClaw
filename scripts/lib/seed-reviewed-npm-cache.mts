#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  lockedArchives,
  type NpmPlatformTarget,
} from "../checks/materialize-locked-npm-cache-seed.mts";
import {
  readReviewedNpmArchiveFile,
  type ReviewedNpmArchiveRequest,
  type ReviewedNpmPackageWithoutIntegrity,
  verifyReviewedNpmLockPackages,
} from "./reviewed-npm-archive.mts";

export type CachePut = (
  cachePath: string,
  key: string,
  data: Buffer,
  options?: Readonly<{ metadata?: Readonly<Record<string, unknown>> }>,
) => Promise<unknown>;

export type ReviewedNpmCacheSeedRequest = Readonly<{
  allowedNestedShrinkwrapPackages?: readonly string[];
  allowNestedShrinkwrap?: boolean;
  archives: ReadonlyMap<string, string>;
  cacheDirectory: string;
  lockfilePath: string;
  maximumArchiveBytes?: number;
  packumentsOnly?: boolean;
  reviewedPackagesWithoutIntegrity?: readonly ReviewedNpmPackageWithoutIntegrity[];
  reviewedRegistryPackages?: readonly ReviewedNpmArchiveRequest[];
  registryOrigin: string;
  selectedPackageSpecs?: ReadonlySet<string>;
  tarballsOnly?: boolean;
}>;

type LockedPackage = Readonly<{
  bundleDependencies?: readonly string[];
  dependencies?: Readonly<Record<string, unknown>>;
  hasShrinkwrap?: true;
  integrity: string;
  name: string;
  optionalDependencies?: Readonly<Record<string, unknown>>;
  peerDependencies?: Readonly<Record<string, unknown>>;
  peerDependenciesMeta?: Readonly<Record<string, unknown>>;
  resolved: string;
  version: string;
}>;

const INSTALL_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const REVIEWED_CI_NPM_VERSIONS = new Set(["10.9.4", "10.9.8", "11.17.0", "11.18.0"]);

function packageNameFromLockLocation(location: string): string {
  const marker = "node_modules/";
  const markerIndex = location.lastIndexOf(marker);
  const name = markerIndex >= 0 ? location.slice(markerIndex + marker.length) : "";
  if (!name) throw new Error(`reviewed npm cache seed has unsupported lock location: ${location}`);
  return name;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readLockedPackages(
  lockfilePath: string,
  registryOrigin: string,
  request: Pick<
    ReviewedNpmCacheSeedRequest,
    | "allowedNestedShrinkwrapPackages"
    | "allowNestedShrinkwrap"
    | "reviewedPackagesWithoutIntegrity"
    | "reviewedRegistryPackages"
  > = {},
): readonly LockedPackage[] {
  const expectedSpecs = new Set(
    verifyReviewedNpmLockPackages({
      allowedNestedShrinkwrapPackages: request.allowedNestedShrinkwrapPackages,
      allowNestedShrinkwrap: request.allowNestedShrinkwrap ?? true,
      lockfilePath,
      reviewedPackagesWithoutIntegrity: request.reviewedPackagesWithoutIntegrity,
      reviewedRegistryPackages: request.reviewedRegistryPackages,
      registryOrigin,
    }),
  );
  const lock = requireObject(
    JSON.parse(readFileSync(lockfilePath, "utf8")) as unknown,
    "reviewed npm cache seed lockfile",
  );
  const packages = requireObject(lock.packages, "reviewed npm cache seed packages");
  const locked: LockedPackage[] = [];
  for (const [location, unknownRecord] of Object.entries(packages)) {
    if (location === "") continue;
    const record = requireObject(unknownRecord, `reviewed npm cache seed package ${location}`);
    const name =
      typeof record.name === "string" ? record.name : packageNameFromLockLocation(location);
    const version = typeof record.version === "string" ? record.version : "";
    const integrity = typeof record.integrity === "string" ? record.integrity : "";
    const resolved = typeof record.resolved === "string" ? record.resolved : "";
    const packageSpec = `${name}@${version}`;
    if (!expectedSpecs.has(packageSpec)) continue;
    if (record.hasShrinkwrap !== undefined && record.hasShrinkwrap !== true) {
      throw new Error(`reviewed npm cache seed ${packageSpec} has invalid shrinkwrap metadata`);
    }
    const bundleDependencies = record.bundleDependencies;
    if (
      bundleDependencies !== undefined &&
      (!Array.isArray(bundleDependencies) ||
        bundleDependencies.some((dependency) => typeof dependency !== "string"))
    ) {
      throw new Error(`reviewed npm cache seed ${packageSpec} has invalid bundled dependencies`);
    }
    const optionalRecord = (field: string): Readonly<Record<string, unknown>> | undefined => {
      const value = record[field];
      return value === undefined
        ? undefined
        : requireObject(value, `reviewed npm cache seed ${packageSpec} ${field}`);
    };
    locked.push({
      ...(bundleDependencies ? { bundleDependencies: bundleDependencies as string[] } : {}),
      dependencies: optionalRecord("dependencies"),
      ...(record.hasShrinkwrap === true ? { hasShrinkwrap: true as const } : {}),
      integrity,
      name,
      optionalDependencies: optionalRecord("optionalDependencies"),
      peerDependencies: optionalRecord("peerDependencies"),
      peerDependenciesMeta: optionalRecord("peerDependenciesMeta"),
      resolved,
      version,
    });
    expectedSpecs.delete(packageSpec);
  }
  if (expectedSpecs.size > 0) {
    throw new Error(
      `reviewed npm cache seed could not resolve locked packages: ${[...expectedSpecs].join(", ")}`,
    );
  }
  return locked;
}

export function lockedArchivesFromDirectory(
  archiveDirectory: string,
  lockfilePath: string,
  registryOrigin: string,
  target: NpmPlatformTarget,
): ReadonlyMap<string, string> {
  if (!isAbsolute(archiveDirectory)) {
    throw new Error(
      `reviewed npm cache seed archive directory must be absolute: ${archiveDirectory}`,
    );
  }
  const directory = resolve(archiveDirectory);
  const directoryEntry = lstatSync(directory);
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new Error(
      `reviewed npm cache seed archive directory must be a non-symlink directory: ${directory}`,
    );
  }

  const selectedArchives = lockedArchives(readFileSync(lockfilePath, "utf8"), target);
  const expectedByResolved = new Map(
    selectedArchives.map((archive) => [archive.resolved, archive.archive]),
  );
  const unmatchedResolved = new Set(expectedByResolved.keys());
  const archives = new Map<string, string>();
  for (const entry of readLockedPackages(lockfilePath, registryOrigin)) {
    const packageSpec = `${entry.name}@${entry.version}`;
    const archiveName = expectedByResolved.get(entry.resolved);
    if (!archiveName) continue;
    if (!archiveName.endsWith(".tgz") || archiveName === ".tgz") {
      throw new Error(`reviewed npm cache seed lock has an unsafe archive name: ${packageSpec}`);
    }
    unmatchedResolved.delete(entry.resolved);
    archives.set(packageSpec, join(directory, archiveName));
  }
  if (unmatchedResolved.size > 0) {
    throw new Error("reviewed npm cache seed could not map every selected lock archive");
  }

  const actualNames = readdirSync(directory).sort();
  const expected = selectedArchives.map(({ archive }) => archive).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw new Error("reviewed npm cache seed archive directory is incomplete or contains extras");
  }
  return archives;
}

function packumentUrl(registryOrigin: string, packageName: string): string {
  if (!packageName.startsWith("@")) return `${registryOrigin}/${packageName}`;
  const separator = packageName.indexOf("/");
  if (separator <= 1 || separator === packageName.length - 1) {
    throw new Error(`reviewed npm cache seed has invalid scoped package: ${packageName}`);
  }
  return `${registryOrigin}/${packageName.slice(0, separator)}%2f${packageName.slice(separator + 1)}`;
}

function loadCachePut(): CachePut {
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  if (!REVIEWED_CI_NPM_VERSIONS.has(npmVersion)) {
    throw new Error(
      `reviewed npm cache seed does not support npm@${npmVersion}; expected npm@10.9.4, npm@10.9.8, npm@11.17.0, or npm@11.18.0`,
    );
  }
  const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const require = createRequire(import.meta.url);
  const cacachePath = require.resolve("cacache", {
    paths: [join(npmRoot, "npm", "node_modules")],
  });
  const cacache = require(cacachePath) as Readonly<{ put: CachePut }>;
  return cacache.put;
}

export async function seedReviewedNpmCache(
  request: ReviewedNpmCacheSeedRequest,
  put: CachePut = loadCachePut(),
): Promise<readonly string[]> {
  if (!isAbsolute(request.cacheDirectory)) {
    throw new Error(`reviewed npm cache seed path must be absolute: ${request.cacheDirectory}`);
  }
  const cacheDirectory = resolve(request.cacheDirectory);
  if (!existsSync(cacheDirectory) || !lstatSync(cacheDirectory).isDirectory()) {
    throw new Error(
      `reviewed npm cache seed path must be an existing directory: ${cacheDirectory}`,
    );
  }
  const parsedRegistry = new URL(request.registryOrigin);
  if (
    parsedRegistry.protocol !== "https:" ||
    parsedRegistry.username ||
    parsedRegistry.password ||
    parsedRegistry.pathname !== "/" ||
    parsedRegistry.search ||
    parsedRegistry.hash
  ) {
    throw new Error(
      `reviewed npm cache seed registry origin is invalid: ${request.registryOrigin}`,
    );
  }
  const registryOrigin = parsedRegistry.origin;
  if (request.packumentsOnly && request.tarballsOnly) {
    throw new Error("reviewed npm cache seed cannot select both packuments-only and tarballs-only");
  }
  const locked = readLockedPackages(request.lockfilePath, registryOrigin, request);
  const selectedPackageSpecs =
    request.selectedPackageSpecs ??
    new Set(locked.map(({ name, version }) => `${name}@${version}`));
  const expectedArchives = request.packumentsOnly
    ? new Set<string>()
    : new Set(selectedPackageSpecs);
  const unexpectedArchives = new Set(request.archives.keys());
  const cachePath = join(cacheDirectory, "_cacache");
  const packumentVersions = new Map<string, Record<string, unknown>>();
  const seeded: string[] = [];
  for (const entry of locked) {
    const packageSpec = `${entry.name}@${entry.version}`;
    if (!selectedPackageSpecs.has(packageSpec)) continue;
    if (!request.packumentsOnly) {
      const archivePath = request.archives.get(packageSpec);
      if (!archivePath)
        throw new Error(`reviewed npm cache seed archive is missing: ${packageSpec}`);
      expectedArchives.delete(packageSpec);
      unexpectedArchives.delete(packageSpec);
      const archive = readReviewedNpmArchiveFile({
        archivePath,
        expectedIntegrity: entry.integrity,
        label: `reviewed npm cache seed ${packageSpec}`,
        maximumBytes: request.maximumArchiveBytes,
      });
      await put(cachePath, `make-fetch-happen:request-cache:${entry.resolved}`, archive, {
        metadata: {
          options: { compress: true },
          reqHeaders: {},
          resHeaders: {
            "cache-control": "public, immutable, max-age=31557600",
            "content-type": "application/octet-stream",
          },
          time: 0,
          url: entry.resolved,
        },
      });
      await put(cachePath, `pacote:tarball:${packageSpec}`, archive);
    }

    if (!request.tarballsOnly) {
      const version = {
        ...(entry.bundleDependencies ? { bundleDependencies: entry.bundleDependencies } : {}),
        ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
        dist: { integrity: entry.integrity, tarball: entry.resolved },
        ...(entry.hasShrinkwrap ? { hasShrinkwrap: true } : {}),
        name: entry.name,
        ...(entry.optionalDependencies ? { optionalDependencies: entry.optionalDependencies } : {}),
        ...(entry.peerDependencies ? { peerDependencies: entry.peerDependencies } : {}),
        ...(entry.peerDependenciesMeta ? { peerDependenciesMeta: entry.peerDependenciesMeta } : {}),
        version: entry.version,
      };
      const versions = packumentVersions.get(entry.name) ?? {};
      versions[entry.version] = version;
      packumentVersions.set(entry.name, versions);
    }
    seeded.push(packageSpec);
  }
  for (const [packageName, versions] of [...packumentVersions].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const versionNames = Object.keys(versions).sort((left, right) => left.localeCompare(right));
    const packument = Buffer.from(
      JSON.stringify({
        "dist-tags": { latest: versionNames.at(-1) },
        name: packageName,
        versions,
      }),
    );
    const url = packumentUrl(registryOrigin, packageName);
    for (const accept of [INSTALL_ACCEPT, "application/json"]) {
      await put(cachePath, `make-fetch-happen:request-cache:${url}`, packument, {
        metadata: {
          options: { compress: true },
          reqHeaders: { accept },
          resHeaders: {
            "cache-control": "public, max-age=31557600",
            "content-type":
              accept === "application/json"
                ? "application/json"
                : "application/vnd.npm.install-v1+json",
            vary: "accept",
          },
          time: 0,
          url,
        },
      });
    }
  }
  const unlockedArchives = new Set([...expectedArchives, ...unexpectedArchives]);
  if (unlockedArchives.size > 0) {
    throw new Error(
      `reviewed npm cache seed received unlocked archives: ${[...unlockedArchives].join(", ")}`,
    );
  }
  return seeded;
}

function parseCli(args: readonly string[]): ReviewedNpmCacheSeedRequest {
  let cacheDirectory = "";
  let lockfilePath = "";
  let registryOrigin = "";
  let archiveDirectory = "";
  let cpu = "";
  let libc = "";
  let os = "";
  let packumentsOnly = false;
  const archives = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--packuments-only") {
      packumentsOnly = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--archive-directory") archiveDirectory = value;
    else if (flag === "--cache") cacheDirectory = value;
    else if (flag === "--cpu") cpu = value;
    else if (flag === "--libc") libc = value;
    else if (flag === "--lockfile") lockfilePath = value;
    else if (flag === "--os") os = value;
    else if (flag === "--registry-origin") registryOrigin = value;
    else if (flag === "--archive") {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) {
        throw new Error(
          `reviewed npm cache seed archive must use package@version=/absolute/path: ${value}`,
        );
      }
      const packageSpec = value.slice(0, separator);
      if (archives.has(packageSpec)) {
        throw new Error(`reviewed npm cache seed archive is duplicated: ${packageSpec}`);
      }
      archives.set(packageSpec, value.slice(separator + 1));
    } else throw new Error(`unknown reviewed npm cache seed option: ${flag}`);
    index += 1;
  }
  if (!cacheDirectory || !lockfilePath || !registryOrigin) {
    throw new Error(
      "usage: seed-reviewed-npm-cache.mts --cache ABSOLUTE --lockfile FILE --registry-origin HTTPS_ORIGIN (--archive PACKAGE@VERSION=ABSOLUTE | --archive-directory ABSOLUTE | --packuments-only)",
    );
  }
  if (packumentsOnly && (archiveDirectory || archives.size > 0)) {
    throw new Error("reviewed npm cache seed packuments-only mode does not accept archives");
  }
  if (archiveDirectory && archives.size > 0) {
    throw new Error(
      "reviewed npm cache seed accepts either explicit archives or one archive directory",
    );
  }
  if (archiveDirectory && (!cpu || !libc || !os)) {
    throw new Error("reviewed npm cache seed archive directory requires --os, --cpu, and --libc");
  }
  if (!archiveDirectory && (cpu || libc || os)) {
    throw new Error("reviewed npm cache seed platform target requires an archive directory");
  }
  const selectedArchives = archiveDirectory
    ? lockedArchivesFromDirectory(archiveDirectory, lockfilePath, registryOrigin, {
        cpu,
        libc,
        os,
      })
    : archives;
  if (!packumentsOnly && selectedArchives.size === 0) {
    throw new Error("reviewed npm cache seed requires at least one locked archive");
  }
  return {
    archives: selectedArchives,
    cacheDirectory,
    lockfilePath,
    ...(packumentsOnly ? { packumentsOnly: true } : {}),
    registryOrigin,
    ...(archiveDirectory ? { selectedPackageSpecs: new Set(selectedArchives.keys()) } : {}),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  seedReviewedNpmCache(parseCli(process.argv.slice(2)))
    .then((packages) =>
      process.stdout.write(`Seeded ${packages.length} reviewed npm cache entries\n`),
    )
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
