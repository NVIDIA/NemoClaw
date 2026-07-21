// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXED_TAR_VERSION = "7.5.19";
export const FIXED_TAR_INTEGRITY =
  "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==";
export const FIXED_TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz";

const OPENCLAW_TAR_LAYOUTS = new Map([
  ["2026.5.18", { direct: "7.5.15", fsSafe: "7.5.13", shrinkwrap: false }],
  ["2026.5.22", { direct: "7.5.15", shrinkwrap: true }],
  ["2026.5.27", { direct: "7.5.15", shrinkwrap: true }],
  ["2026.6.10", { direct: "7.5.16", fsSafe: "7.5.13", shrinkwrap: true }],
]);

type JsonRecord = Record<string, unknown>;

export type HistoricalReleasePlan = {
  releaseTag: string;
  openClawVersion: string;
  vulnerableTarVersion: string;
  revisionTag: string;
};

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function readJson(file: string, label: string): JsonRecord {
  try {
    return record(JSON.parse(readFileSync(file, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  }
}

function directory(pathname: string, label: string): void {
  const metadata = lstatSync(pathname);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

function rejectUnsafeMembers(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`replacement tar package contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafeMembers(path.join(root, entry.name));
  }
}

function discoverTarRoots(root: string, current = root, found: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(current, entry.name);
    if (
      entry.name === "tar" &&
      path.basename(current) === "node_modules" &&
      lstatSync(path.join(child, "package.json")).isFile()
    ) {
      found.push(path.relative(root, child));
      continue;
    }
    discoverTarRoots(root, child, found);
  }
  return found.sort();
}

function packageDependencies(manifest: JsonRecord, label: string): JsonRecord {
  return record(manifest.dependencies, `${label} dependencies`);
}

function lockPackages(lock: JsonRecord): JsonRecord {
  if (lock.lockfileVersion !== 3) throw new Error("OpenClaw shrinkwrap must use lockfileVersion 3");
  return record(lock.packages, "OpenClaw shrinkwrap packages");
}

export function planHistoricalRelease(releaseTag: string): HistoricalReleasePlan {
  const match = /^v0\.0\.(\d+)$/u.exec(releaseTag);
  if (!match) throw new Error("release tag must use the v0.0.N format");
  const patch = Number(match[1]);
  let openClawVersion: string;
  if (patch >= 50 && patch <= 51) openClawVersion = "2026.5.18";
  else if (patch >= 52 && patch <= 58) openClawVersion = "2026.5.22";
  else if (patch >= 59 && patch <= 74) openClawVersion = "2026.5.27";
  else if (patch >= 75 && patch <= 89) openClawVersion = "2026.6.10";
  else throw new Error("release tag is outside the reviewed v0.0.50 through v0.0.89 range");

  return {
    releaseTag,
    openClawVersion,
    vulnerableTarVersion: OPENCLAW_TAR_LAYOUTS.get(openClawVersion)?.direct as string,
    revisionTag: `${releaseTag}-cve-2026-59873.1`,
  };
}

export function patchOpenClawTar(options: {
  openClawRoot: string;
  replacementRoot: string;
  expectedOpenClawVersion: string;
}): void {
  const openClawRoot = path.resolve(options.openClawRoot);
  const replacementRoot = path.resolve(options.replacementRoot);
  directory(openClawRoot, "OpenClaw root");
  directory(replacementRoot, "replacement tar root");
  rejectUnsafeMembers(replacementRoot);

  const expectedTarLayout = OPENCLAW_TAR_LAYOUTS.get(options.expectedOpenClawVersion);
  if (!expectedTarLayout) {
    throw new Error(
      `OpenClaw ${options.expectedOpenClawVersion} is not a reviewed backport target`,
    );
  }

  const manifestPath = path.join(openClawRoot, "package.json");
  const shrinkwrapPath = path.join(openClawRoot, "npm-shrinkwrap.json");
  const manifest = readJson(manifestPath, "OpenClaw package manifest");
  const replacementTar = readJson(
    path.join(replacementRoot, "package.json"),
    "replacement tar manifest",
  );
  const dependencies = packageDependencies(manifest, "OpenClaw package manifest");

  const observed = {
    openClawVersion: manifest.version,
    manifestTarVersion: dependencies.tar,
  };
  const expected = {
    openClawVersion: options.expectedOpenClawVersion,
    manifestTarVersion: expectedTarLayout.direct,
  };
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(
      `historical OpenClaw dependency state does not match the reviewed target\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(observed)}`,
    );
  }
  if (replacementTar.name !== "tar" || replacementTar.version !== FIXED_TAR_VERSION) {
    throw new Error(`replacement package must be tar@${FIXED_TAR_VERSION}`);
  }

  dependencies.tar = FIXED_TAR_VERSION;
  let shrinkwrap: JsonRecord | undefined;
  if (expectedTarLayout.shrinkwrap) {
    shrinkwrap = readJson(shrinkwrapPath, "OpenClaw shrinkwrap");
    const packages = lockPackages(shrinkwrap);
    const rootLock = record(packages[""], "OpenClaw shrinkwrap root package");
    const rootDependencies = packageDependencies(rootLock, "OpenClaw shrinkwrap root package");
    const tarLock = record(packages["node_modules/tar"], "OpenClaw shrinkwrap tar package");
    if (
      rootDependencies.tar !== expectedTarLayout.direct ||
      tarLock.version !== expectedTarLayout.direct
    ) {
      throw new Error("OpenClaw shrinkwrap tar dependency does not match the review");
    }
    rootDependencies.tar = FIXED_TAR_VERSION;
    tarLock.version = FIXED_TAR_VERSION;
    tarLock.resolved = FIXED_TAR_TARBALL;
    tarLock.integrity = FIXED_TAR_INTEGRITY;
  } else if (existsSync(shrinkwrapPath)) {
    throw new Error("OpenClaw shrinkwrap presence does not match the review");
  }

  const tarTargets = [
    { relativeRoot: "node_modules/tar", version: expectedTarLayout.direct },
    ...(expectedTarLayout.fsSafe
      ? [
          {
            relativeRoot: "node_modules/@openclaw/fs-safe/node_modules/tar",
            version: expectedTarLayout.fsSafe,
          },
        ]
      : []),
  ];
  const discovered = discoverTarRoots(openClawRoot);
  const expectedRoots = tarTargets.map((target) => target.relativeRoot).sort();
  if (JSON.stringify(discovered) !== JSON.stringify(expectedRoots)) {
    throw new Error(
      `installed tar package layout does not match the review\nExpected: ${JSON.stringify(expectedRoots)}\nActual:   ${JSON.stringify(discovered)}`,
    );
  }

  for (const target of tarTargets) {
    const installedTarRoot = path.join(openClawRoot, target.relativeRoot);
    directory(installedTarRoot, "installed tar root");
    const installedTar = readJson(
      path.join(installedTarRoot, "package.json"),
      "installed tar manifest",
    );
    if (installedTar.name !== "tar" || installedTar.version !== target.version) {
      throw new Error(
        `${target.relativeRoot} must contain reviewed tar@${target.version}, found ${String(installedTar.version)}`,
      );
    }
    const stagedTarRoot = `${installedTarRoot}.nemoclaw-cve-2026-59873`;
    rmSync(stagedTarRoot, { recursive: true, force: true });
    cpSync(replacementRoot, stagedTarRoot, { recursive: true, dereference: false });
    rmSync(installedTarRoot, { recursive: true, force: true });
    renameSync(stagedTarRoot, installedTarRoot);
  }

  if (expectedTarLayout.fsSafe) {
    const fsSafeManifestPath = path.join(
      openClawRoot,
      "node_modules",
      "@openclaw",
      "fs-safe",
      "package.json",
    );
    const fsSafeManifest = readJson(fsSafeManifestPath, "@openclaw/fs-safe package manifest");
    const optionalDependencies = record(
      fsSafeManifest.optionalDependencies,
      "@openclaw/fs-safe optional dependencies",
    );
    if (optionalDependencies.tar !== expectedTarLayout.fsSafe) {
      throw new Error("@openclaw/fs-safe tar dependency does not match the review");
    }
    optionalDependencies.tar = FIXED_TAR_VERSION;
    writeFileSync(fsSafeManifestPath, `${JSON.stringify(fsSafeManifest, null, 2)}\n`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (shrinkwrap) writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
}

export function verifyOpenClawTarRevision(options: {
  openClawRoot: string;
  expectedOpenClawVersion: string;
}): void {
  const openClawRoot = path.resolve(options.openClawRoot);
  const expectedLayout = OPENCLAW_TAR_LAYOUTS.get(options.expectedOpenClawVersion);
  if (!expectedLayout) throw new Error("OpenClaw version is not a reviewed backport target");
  const packageJson = readJson(
    path.join(openClawRoot, "package.json"),
    "OpenClaw package manifest",
  );
  if (
    packageJson.version !== options.expectedOpenClawVersion ||
    packageDependencies(packageJson, "OpenClaw package manifest").tar !== FIXED_TAR_VERSION
  ) {
    throw new Error("patched OpenClaw package metadata is inconsistent");
  }

  const expectedRoots = [
    "node_modules/tar",
    ...(expectedLayout.fsSafe ? ["node_modules/@openclaw/fs-safe/node_modules/tar"] : []),
  ].sort();
  const discovered = discoverTarRoots(openClawRoot);
  if (JSON.stringify(discovered) !== JSON.stringify(expectedRoots)) {
    throw new Error("patched OpenClaw tar package layout is inconsistent");
  }
  for (const relativeRoot of discovered) {
    const tarPackage = readJson(
      path.join(openClawRoot, relativeRoot, "package.json"),
      "patched tar manifest",
    );
    if (tarPackage.name !== "tar" || tarPackage.version !== FIXED_TAR_VERSION) {
      throw new Error(`${relativeRoot} is not patched to tar@${FIXED_TAR_VERSION}`);
    }
  }

  const shrinkwrapPath = path.join(openClawRoot, "npm-shrinkwrap.json");
  if (expectedLayout.shrinkwrap) {
    const packages = lockPackages(readJson(shrinkwrapPath, "OpenClaw shrinkwrap"));
    const rootDependencies = packageDependencies(
      record(packages[""], "OpenClaw shrinkwrap root package"),
      "OpenClaw shrinkwrap root package",
    );
    const tarLock = record(packages["node_modules/tar"], "OpenClaw shrinkwrap tar package");
    if (
      rootDependencies.tar !== FIXED_TAR_VERSION ||
      tarLock.version !== FIXED_TAR_VERSION ||
      tarLock.resolved !== FIXED_TAR_TARBALL ||
      tarLock.integrity !== FIXED_TAR_INTEGRITY
    ) {
      throw new Error("patched OpenClaw shrinkwrap is inconsistent");
    }
  } else if (existsSync(shrinkwrapPath)) {
    throw new Error("patched OpenClaw unexpectedly contains a shrinkwrap");
  }

  if (expectedLayout.fsSafe) {
    const fsSafePackage = readJson(
      path.join(openClawRoot, "node_modules", "@openclaw", "fs-safe", "package.json"),
      "@openclaw/fs-safe package manifest",
    );
    const optionalDependencies = record(
      fsSafePackage.optionalDependencies,
      "@openclaw/fs-safe optional dependencies",
    );
    if (optionalDependencies.tar !== FIXED_TAR_VERSION) {
      throw new Error("patched @openclaw/fs-safe package metadata is inconsistent");
    }
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function main(): void {
  if (process.argv.includes("--plan")) {
    process.stdout.write(`${JSON.stringify(planHistoricalRelease(argument("--plan")))}\n`);
    return;
  }
  const openClawRoot = argument("--openclaw-root");
  const expectedOpenClawVersion = argument("--expected-openclaw-version");
  if (process.argv.includes("--verify")) {
    verifyOpenClawTarRevision({ openClawRoot, expectedOpenClawVersion });
    return;
  }
  patchOpenClawTar({
    openClawRoot,
    replacementRoot: argument("--replacement-root"),
    expectedOpenClawVersion,
  });
  verifyOpenClawTarRevision({ openClawRoot, expectedOpenClawVersion });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
