#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import {
  readReviewedNpmArchiveFile,
  verifyReviewedNpmLockPackages,
} from "../lib/reviewed-npm-archive.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAXIMUM_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_NPM_DIAGNOSTIC_INPUT_CHARACTERS = 4096;
const MAXIMUM_NPM_DIAGNOSTIC_CHARACTERS = 512;
const NPM_DIAGNOSTIC_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/giu;
const NPM_DIAGNOSTIC_AUTH_HEADER_PATTERN =
  /(\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=])[^\r\n]*/giu;
const NPM_DIAGNOSTIC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9._-]*(?:auth|credential|key|pass|passwd|password|secret|token)[A-Za-z0-9._-]*)[ \t]*(?:=|:)[ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s]+)/giu;
const NPM_DIAGNOSTIC_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu;
const NPM_DIAGNOSTIC_TOKEN_PATTERN =
  /\b(?:github_pat_|ghp_|glpat-|gsk_|hf_|nvcf-|nvapi-|pypi-|sk-(?:ant-|proj-)?|tvly-|xapp-|xox[bpas]-)[A-Za-z0-9_-]{8,}/giu;
const NPM_DIAGNOSTIC_JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu;
const NPM_DIAGNOSTIC_OPAQUE_VALUE_PATTERN = /\b[A-Za-z0-9_+/=-]{32,}\b/gu;

type PreparationRequest = Readonly<{
  artifactDirectory?: string;
  cacheDirectory: string;
  mode: "artifact" | "registry";
  targetRoot: string;
}>;

type AuditConfig = ReturnType<typeof parseAuditConfig>;

type NpmCacheStageRequest = Readonly<{
  archive: Buffer;
  artifactName: string;
  cacheDirectory: string;
}>;

type NpmCacheStager = (request: NpmCacheStageRequest) => void;

function npmCacheFailureDiagnostic(
  stderr: string,
  request: NpmCacheStageRequest,
  stagingRoot: string,
): string {
  return stderr
    .slice(0, MAXIMUM_NPM_DIAGNOSTIC_INPUT_CHARACTERS)
    .replace(NPM_DIAGNOSTIC_PRIVATE_KEY_PATTERN, "<REDACTED>")
    .replace(NPM_DIAGNOSTIC_URL_PATTERN, "<REDACTED_URL>")
    .replace(NPM_DIAGNOSTIC_AUTH_HEADER_PATTERN, "$1 <REDACTED>")
    .replace(NPM_DIAGNOSTIC_CREDENTIAL_ASSIGNMENT_PATTERN, "$1<REDACTED>")
    .replace(/\bBearer[ \t]+\S+/giu, "Bearer <REDACTED>")
    .replace(NPM_DIAGNOSTIC_TOKEN_PATTERN, "<REDACTED>")
    .replace(NPM_DIAGNOSTIC_JWT_PATTERN, "<REDACTED>")
    .replace(NPM_DIAGNOSTIC_OPAQUE_VALUE_PATTERN, "<REDACTED>")
    .replaceAll(stagingRoot, "<staging-root>")
    .replaceAll(request.cacheDirectory, "<npm-cache>")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, MAXIMUM_NPM_DIAGNOSTIC_CHARACTERS);
}

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

function stageReviewedArchiveWithNpm(request: NpmCacheStageRequest): void {
  const stagingRoot = mkdtempSync(join(tmpdir(), "nemoclaw-reviewed-npm-cache-add-"));
  try {
    const archivePath = join(stagingRoot, request.artifactName);
    writeFileSync(archivePath, request.archive, { mode: 0o600 });
    const result = spawnSync(
      "npm",
      [
        "cache",
        "add",
        archivePath,
        "--cache",
        request.cacheDirectory,
        "--offline",
        "--ignore-scripts",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const diagnostic = npmCacheFailureDiagnostic(result.stderr, request, stagingRoot);
      const detail = diagnostic ? `: ${diagnostic}` : "";
      throw new Error(
        `npm could not stage the reviewed OpenShell SDK archive (exit ${String(result.status ?? "unavailable")})${detail}`,
      );
    }
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
}

export async function seedReviewedSourceRegistryArtifact(
  request: ReviewedSourceRegistryArtifactRequest,
  stage: NpmCacheStager = stageReviewedArchiveWithNpm,
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
  const reviewedRegistryPackage = {
    expectedIntegrity: request.reviewed.integrity,
    label: request.reviewed.label,
    packageSpec: request.reviewed.packageSpec,
    tarballUrl: request.reviewed.tarballUrl,
  };
  const lockedPackages = verifyReviewedNpmLockPackages({
    allowedNestedShrinkwrapPackages: request.allowedNestedShrinkwrapPackages,
    allowNestedShrinkwrap: false,
    lockfilePath: request.lockfilePath,
    registryOrigin: request.registryOrigin,
    reviewedPackagesWithoutIntegrity: request.reviewedPackagesWithoutIntegrity,
    reviewedRegistryPackages: [reviewedRegistryPackage],
  });
  if (!lockedPackages.includes(request.reviewed.packageSpec)) {
    throw new Error("reviewed OpenShell SDK artifact is not used by the selected lockfile");
  }
  const cacheDirectory = resolve(request.cacheDirectory);
  if (
    !isAbsolute(request.cacheDirectory) ||
    !existsSync(cacheDirectory) ||
    !lstatSync(cacheDirectory).isDirectory()
  ) {
    throw new Error("reviewed OpenShell SDK cache must be an existing absolute directory");
  }
  const archive = readReviewedNpmArchiveFile({
    archivePath,
    expectedIntegrity: request.reviewed.integrity,
    label: request.reviewed.label,
    maximumBytes: MAXIMUM_ARCHIVE_BYTES,
  });
  stage({ archive, artifactName: request.reviewed.artifactName, cacheDirectory });
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
  stage?: NpmCacheStager,
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
    stage,
  );
}

export async function prepareCiNpmInstallWithReviewedConfig(
  request: PreparationRequest,
  reviewedConfigSource: string,
  stage?: NpmCacheStager,
): Promise<void> {
  return prepareCiNpmInstallWithConfig(request, parseAuditConfig(reviewedConfigSource), stage);
}

export async function prepareCiNpmInstall(
  request: PreparationRequest,
  stage?: NpmCacheStager,
): Promise<void> {
  return prepareCiNpmInstallWithConfig(request, readTrustedAuditConfig(), stage);
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
