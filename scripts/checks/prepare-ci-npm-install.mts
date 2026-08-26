#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import { verifyReviewedNpmLockPackages } from "../lib/reviewed-npm-archive.mts";
import type { CachePut } from "../lib/seed-reviewed-npm-cache.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAXIMUM_ARCHIVE_BYTES = 32 * 1024 * 1024;

type PreparationRequest = Readonly<{
  artifactDirectory?: string;
  cacheDirectory: string;
  mode: "artifact" | "registry";
  targetRoot: string;
}>;

export type ReviewedSourceRegistryPackage = Readonly<{
  artifactName: string;
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;

export type ReviewedSourceRegistryArtifactRequest = Readonly<{
  artifactDirectory: string;
  cacheDirectory: string;
  reviewed: ReviewedSourceRegistryPackage;
}>;

function loadCachePut(): CachePut {
  const require = createRequire(import.meta.url);
  const npmRoot = String(
    require("node:child_process").execFileSync("npm", ["root", "-g"], { encoding: "utf8" }),
  ).trim();
  const cacachePath = require.resolve("cacache", { paths: [join(npmRoot, "npm", "node_modules")] });
  return (require(cacachePath) as Readonly<{ put: CachePut }>).put;
}

function readRegularArchive(file: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const opened = fstatSync(descriptor);
    const pathEntry = lstatSync(file);
    if (
      !opened.isFile() ||
      !pathEntry.isFile() ||
      pathEntry.isSymbolicLink() ||
      opened.dev !== pathEntry.dev ||
      opened.ino !== pathEntry.ino ||
      opened.size > MAXIMUM_ARCHIVE_BYTES
    ) {
      throw new Error("archive must be one bounded non-symlink regular file");
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function seedReviewedSourceRegistryArtifact(
  request: ReviewedSourceRegistryArtifactRequest,
  put?: CachePut,
): Promise<void> {
  if (!isAbsolute(request.artifactDirectory)) {
    throw new Error("reviewed OpenShell SDK artifact directory must be absolute");
  }
  const artifactDirectory = resolve(request.artifactDirectory);
  if (!existsSync(artifactDirectory)) {
    throw new Error("reviewed OpenShell SDK artifact is required");
  }
  const directoryEntry = lstatSync(artifactDirectory);
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new Error("reviewed OpenShell SDK artifact path must be a non-symlink directory");
  }
  const entries = readdirSync(artifactDirectory);
  if (entries.length !== 1 || entries[0] !== request.reviewed.artifactName) {
    throw new Error("reviewed OpenShell SDK artifact directory has unexpected contents");
  }
  const archive = readRegularArchive(join(artifactDirectory, request.reviewed.artifactName));
  const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (actualIntegrity !== request.reviewed.integrity) {
    throw new Error(
      "reviewed OpenShell SDK artifact integrity does not match the approved package",
    );
  }
  const cachePut = put ?? loadCachePut();
  const cachePath = join(resolve(request.cacheDirectory), "_cacache");
  await cachePut(
    cachePath,
    `make-fetch-happen:request-cache:${request.reviewed.tarballUrl}`,
    archive,
    {
      metadata: {
        options: { compress: true },
        reqHeaders: {},
        resHeaders: {
          "cache-control": "public, immutable, max-age=31557600",
          "content-type": "application/octet-stream",
        },
        time: 0,
        url: request.reviewed.tarballUrl,
      },
    },
  );
  await cachePut(cachePath, `pacote:tarball:${request.reviewed.packageSpec}`, archive);
}

export async function prepareCiNpmInstall(
  request: PreparationRequest,
  put?: CachePut,
): Promise<void> {
  const targetRoot = resolve(request.targetRoot);
  const cacheDirectory = resolve(request.cacheDirectory);
  const config = parseAuditConfig(
    readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
  );
  if (config.sourceRegistryPackages.length !== 1) {
    throw new Error("reviewed npm configuration must name one source-registry package");
  }
  const reviewed = config.sourceRegistryPackages[0];
  const reviewedRegistryPackages = [
    {
      expectedIntegrity: reviewed.integrity,
      label: reviewed.label,
      packageSpec: reviewed.packageSpec,
      tarballUrl: reviewed.tarballUrl,
    },
  ];
  const packageSets = ["package-lock.json", "nemoclaw/package-lock.json"].map((relativePath) =>
    verifyReviewedNpmLockPackages({
      allowedNestedShrinkwrapPackages: config.sourceNestedShrinkwrapPackages,
      lockfilePath: join(targetRoot, relativePath),
      registryOrigin: config.registryOrigin,
      reviewedRegistryPackages,
      reviewedPackagesWithoutIntegrity: config.sourceRegistryPackagesWithoutIntegrity,
    }),
  );
  const sdkIsLocked = packageSets.some((packages) => packages.includes(reviewed.packageSpec));

  if (request.mode === "registry") return;
  if (!request.artifactDirectory) {
    if (sdkIsLocked) throw new Error("reviewed OpenShell SDK artifact is required");
    return;
  }
  if (!isAbsolute(request.artifactDirectory)) {
    throw new Error("reviewed OpenShell SDK artifact directory must be absolute");
  }
  const artifactDirectory = resolve(request.artifactDirectory);
  if (!existsSync(artifactDirectory)) {
    if (sdkIsLocked) throw new Error("reviewed OpenShell SDK artifact is required");
    return;
  }
  if (!sdkIsLocked) {
    throw new Error("reviewed OpenShell SDK artifact is not used by either lockfile");
  }
  await seedReviewedSourceRegistryArtifact({ artifactDirectory, cacheDirectory, reviewed }, put);
}

function requestFromEnvironment(): PreparationRequest {
  const mode = process.env.NEMOCLAW_CI_NPM_PACKAGE_MODE;
  const targetRoot = process.env.NEMOCLAW_CI_TARGET_ROOT;
  const cacheDirectory = process.env.NEMOCLAW_CI_NPM_CACHE;
  if ((mode !== "artifact" && mode !== "registry") || !targetRoot || !cacheDirectory) {
    throw new Error("trusted CI npm preparation environment is incomplete");
  }
  return {
    artifactDirectory: process.env.NEMOCLAW_OPEN_SHELL_SDK_ARTIFACT_DIRECTORY,
    cacheDirectory,
    mode,
    targetRoot,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareCiNpmInstall(requestFromEnvironment()).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
