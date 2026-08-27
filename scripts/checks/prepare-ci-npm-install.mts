#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import { verifyReviewedNpmLockPackages } from "../lib/reviewed-npm-archive.mts";
import { type CachePut, seedReviewedNpmCache } from "../lib/seed-reviewed-npm-cache.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAXIMUM_ARCHIVE_BYTES = 32 * 1024 * 1024;

type PreparationRequest = Readonly<{
  artifactDirectory?: string;
  cacheDirectory: string;
  mode: "artifact" | "registry";
  targetRoot: string;
}>;

type AuditConfig = ReturnType<typeof parseAuditConfig>;

export type ReviewedSourceRegistryPackage = Readonly<{
  artifactName: string;
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;

export type ReviewedSourceRegistryArtifactRequest = Readonly<{
  allowedNestedShrinkwrapPackages: readonly string[];
  artifactDirectory: string;
  cacheDirectory: string;
  lockfilePath: string;
  reviewed: ReviewedSourceRegistryPackage;
  reviewedPackagesWithoutIntegrity: readonly Readonly<{
    label: string;
    packageSpec: string;
    tarballUrl: string;
  }>[];
  registryOrigin: string;
}>;

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
  const archivePath = resolve(join(artifactDirectory, request.reviewed.artifactName));
  await seedReviewedNpmCache(
    {
      allowedNestedShrinkwrapPackages: request.allowedNestedShrinkwrapPackages,
      allowNestedShrinkwrap: false,
      archives: new Map([[request.reviewed.packageSpec, archivePath]]),
      cacheDirectory: request.cacheDirectory,
      lockfilePath: request.lockfilePath,
      maximumArchiveBytes: MAXIMUM_ARCHIVE_BYTES,
      registryOrigin: request.registryOrigin,
      reviewedPackagesWithoutIntegrity: request.reviewedPackagesWithoutIntegrity,
      reviewedRegistryPackages: [
        {
          expectedIntegrity: request.reviewed.integrity,
          label: request.reviewed.label,
          packageSpec: request.reviewed.packageSpec,
          tarballUrl: request.reviewed.tarballUrl,
        },
      ],
      selectedPackageSpecs: new Set([request.reviewed.packageSpec]),
      tarballsOnly: true,
    },
    put,
  );
}

function readTrustedAuditConfig(): AuditConfig {
  return parseAuditConfig(
    readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
  );
}

function inspectReviewedLocks(targetRoot: string, config: AuditConfig) {
  const reviewed = config.sourceRegistryPackage;
  const reviewedRegistryPackages = [
    {
      expectedIntegrity: reviewed.integrity,
      label: reviewed.label,
      packageSpec: reviewed.packageSpec,
      tarballUrl: reviewed.tarballUrl,
    },
  ];
  const lockfiles = ["package-lock.json", "nemoclaw/package-lock.json"].map((relativePath) => {
    const lockfilePath = join(targetRoot, relativePath);
    const packages = verifyReviewedNpmLockPackages({
      allowedNestedShrinkwrapPackages: config.sourceNestedShrinkwrapPackages,
      lockfilePath,
      registryOrigin: config.registryOrigin,
      reviewedPackagesWithoutIntegrity: config.sourceRegistryPackagesWithoutIntegrity,
      reviewedRegistryPackages,
    });
    return { lockfilePath, packages };
  });
  return {
    config,
    reviewed,
    reviewedLockfilePath: lockfiles.find(({ packages }) => packages.includes(reviewed.packageSpec))
      ?.lockfilePath,
  };
}

export function inspectCiNpmInstall(targetRoot: string) {
  const inspected = inspectReviewedLocks(resolve(targetRoot), readTrustedAuditConfig());
  return {
    artifactName: inspected.reviewed.artifactName,
    required: inspected.reviewedLockfilePath !== undefined,
  } as const;
}

async function prepareCiNpmInstallWithConfig(
  request: PreparationRequest,
  config: AuditConfig,
  put?: CachePut,
): Promise<void> {
  const targetRoot = resolve(request.targetRoot);
  const cacheDirectory = resolve(request.cacheDirectory);
  const { reviewed, reviewedLockfilePath } = inspectReviewedLocks(targetRoot, config);
  const sdkIsLocked = reviewedLockfilePath !== undefined;

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
  if (!reviewedLockfilePath) {
    throw new Error("reviewed OpenShell SDK artifact is not used by either lockfile");
  }
  await seedReviewedSourceRegistryArtifact(
    {
      allowedNestedShrinkwrapPackages: config.sourceNestedShrinkwrapPackages,
      artifactDirectory,
      cacheDirectory,
      lockfilePath: reviewedLockfilePath,
      registryOrigin: config.registryOrigin,
      reviewed,
      reviewedPackagesWithoutIntegrity: config.sourceRegistryPackagesWithoutIntegrity,
    },
    put,
  );
}

export async function prepareCiNpmInstallWithReviewedConfig(
  request: PreparationRequest,
  reviewedConfigSource: string,
  put?: CachePut,
): Promise<void> {
  return prepareCiNpmInstallWithConfig(request, parseAuditConfig(reviewedConfigSource), put);
}

export async function prepareCiNpmInstall(
  request: PreparationRequest,
  put?: CachePut,
): Promise<void> {
  return prepareCiNpmInstallWithConfig(request, readTrustedAuditConfig(), put);
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
  const mode = process.env.NEMOCLAW_CI_NPM_PACKAGE_MODE;
  const targetRoot = process.env.NEMOCLAW_CI_TARGET_ROOT;
  const task =
    mode === "inspect" && targetRoot
      ? Promise.resolve(inspectCiNpmInstall(targetRoot)).then((result) =>
          process.stdout.write(`${JSON.stringify(result)}\n`),
        )
      : prepareCiNpmInstall(requestFromEnvironment());
  task.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
