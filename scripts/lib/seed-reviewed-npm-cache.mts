#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyReviewedNpmLockPackages } from "./reviewed-npm-archive.mts";

export type CachePut = (
  cachePath: string,
  key: string,
  data: Buffer,
  options?: Readonly<{ metadata?: Readonly<Record<string, unknown>> }>,
) => Promise<unknown>;

export type ReviewedNpmCacheSeedRequest = Readonly<{
  archives: ReadonlyMap<string, string>;
  cacheDirectory: string;
  lockfilePath: string;
  registryOrigin: string;
}>;

type LockedPackage = Readonly<{
  dependencies?: Readonly<Record<string, unknown>>;
  integrity: string;
  name: string;
  optionalDependencies?: Readonly<Record<string, unknown>>;
  peerDependencies?: Readonly<Record<string, unknown>>;
  peerDependenciesMeta?: Readonly<Record<string, unknown>>;
  resolved: string;
  version: string;
}>;

const INSTALL_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

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
): readonly LockedPackage[] {
  const expectedSpecs = new Set(verifyReviewedNpmLockPackages({ lockfilePath, registryOrigin }));
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
    const optionalRecord = (field: string): Readonly<Record<string, unknown>> | undefined => {
      const value = record[field];
      return value === undefined
        ? undefined
        : requireObject(value, `reviewed npm cache seed ${packageSpec} ${field}`);
    };
    locked.push({
      dependencies: optionalRecord("dependencies"),
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

function readArchive(archivePath: string, packageSpec: string): Buffer {
  if (!isAbsolute(archivePath)) {
    throw new Error(`reviewed npm cache seed archive must be absolute: ${packageSpec}`);
  }
  const resolvedPath = resolve(archivePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolvedPath, "r");
    const opened = fstatSync(descriptor);
    const pathEntry = lstatSync(resolvedPath);
    if (
      !opened.isFile() ||
      !pathEntry.isFile() ||
      pathEntry.isSymbolicLink() ||
      opened.dev !== pathEntry.dev ||
      opened.ino !== pathEntry.ino
    ) {
      throw new Error("archive must be a non-symlink regular file");
    }
    return readFileSync(descriptor);
  } catch (error) {
    throw new Error(
      `reviewed npm cache seed archive is unreadable: ${packageSpec}: ${String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
  const locked = readLockedPackages(request.lockfilePath, registryOrigin);
  const expectedArchives = new Set(request.archives.keys());
  const cachePath = join(cacheDirectory, "_cacache");
  const seeded: string[] = [];
  for (const entry of locked) {
    const packageSpec = `${entry.name}@${entry.version}`;
    const archivePath = request.archives.get(packageSpec);
    if (!archivePath) throw new Error(`reviewed npm cache seed archive is missing: ${packageSpec}`);
    expectedArchives.delete(packageSpec);
    const archive = readArchive(archivePath, packageSpec);
    const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (actualIntegrity !== entry.integrity) {
      throw new Error(
        `reviewed npm cache seed integrity mismatch for ${packageSpec}\nExpected: ${entry.integrity}\nActual:   ${actualIntegrity}`,
      );
    }
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

    const version = {
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
      dist: { integrity: entry.integrity, tarball: entry.resolved },
      name: entry.name,
      ...(entry.optionalDependencies ? { optionalDependencies: entry.optionalDependencies } : {}),
      ...(entry.peerDependencies ? { peerDependencies: entry.peerDependencies } : {}),
      ...(entry.peerDependenciesMeta ? { peerDependenciesMeta: entry.peerDependenciesMeta } : {}),
      version: entry.version,
    };
    const packument = Buffer.from(
      JSON.stringify({
        "dist-tags": { latest: entry.version },
        name: entry.name,
        versions: { [entry.version]: version },
      }),
    );
    const url = packumentUrl(registryOrigin, entry.name);
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
    seeded.push(packageSpec);
  }
  if (expectedArchives.size > 0) {
    throw new Error(
      `reviewed npm cache seed received unlocked archives: ${[...expectedArchives].join(", ")}`,
    );
  }
  return seeded;
}

function parseCli(args: readonly string[]): ReviewedNpmCacheSeedRequest {
  let cacheDirectory = "";
  let lockfilePath = "";
  let registryOrigin = "";
  const archives = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? "argument"}`);
    if (flag === "--cache") cacheDirectory = value;
    else if (flag === "--lockfile") lockfilePath = value;
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
  if (!cacheDirectory || !lockfilePath || !registryOrigin || archives.size === 0) {
    throw new Error(
      "usage: seed-reviewed-npm-cache.mts --cache ABSOLUTE --lockfile FILE --registry-origin HTTPS_ORIGIN --archive PACKAGE@VERSION=ABSOLUTE",
    );
  }
  return { archives, cacheDirectory, lockfilePath, registryOrigin };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  seedReviewedNpmCache(parseCli(process.argv.slice(2)))
    .then((packages) => process.stdout.write(`Seeded ${packages.length} reviewed npm archives\n`))
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
