#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import { packReviewedNpmArchive, removeReviewedNpmArchive } from "../lib/reviewed-npm-archive.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function packageReviewedOpenShellSdk(
  outputDirectory: string,
  includeReplacement = false,
  dependencies: Readonly<{
    pack?: typeof packReviewedNpmArchive;
    readAuditConfig?: () => string;
    remove?: typeof removeReviewedNpmArchive;
  }> = {},
): string {
  if (!outputDirectory) {
    throw new Error("reviewed OpenShell SDK output directory is required");
  }
  const config = parseAuditConfig(
    dependencies.readAuditConfig?.() ??
      readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
  );
  if (includeReplacement && !config.sourceRegistryPackageReplacement) {
    throw new Error("reviewed OpenShell SDK replacement metadata is required");
  }
  const reviewedPackages =
    includeReplacement && config.sourceRegistryPackageReplacement
      ? [config.sourceRegistryPackage, config.sourceRegistryPackageReplacement]
      : [config.sourceRegistryPackage];
  const archives: ReturnType<typeof packReviewedNpmArchive>[] = [];
  const pack = dependencies.pack ?? packReviewedNpmArchive;
  const remove = dependencies.remove ?? removeReviewedNpmArchive;
  const output = resolve(outputDirectory);
  try {
    rmSync(output, { force: true, recursive: true });
    mkdirSync(output, { recursive: true });
    for (const reviewed of reviewedPackages) {
      const archive = pack({
        env: process.env,
        expectedIntegrity: reviewed.integrity,
        label: reviewed.label,
        packageSpec: reviewed.packageSpec,
        tarballUrl: reviewed.tarballUrl,
      });
      archives.push(archive);
      copyFileSync(archive.archivePath, join(output, reviewed.artifactName));
    }
    return reviewedPackages.length === 1 ? join(output, reviewedPackages[0]!.artifactName) : output;
  } finally {
    for (const archive of archives) remove(archive);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputDirectory = process.env.NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY;
  if (!outputDirectory) {
    console.error("NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY is required");
    process.exit(1);
  }
  const includeReplacementValue = process.env.NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_REPLACEMENT;
  if (includeReplacementValue !== undefined && includeReplacementValue !== "1") {
    console.error("NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_REPLACEMENT must be 1 when set");
    process.exit(1);
  }
  try {
    process.stdout.write(
      `${packageReviewedOpenShellSdk(outputDirectory, includeReplacementValue === "1")}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
