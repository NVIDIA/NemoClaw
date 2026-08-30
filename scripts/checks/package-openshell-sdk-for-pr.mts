#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import { packReviewedNpmArchive, removeReviewedNpmArchive } from "../lib/reviewed-npm-archive.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function packageReviewedOpenShellSdk(outputDirectory: string): string {
  if (!outputDirectory) {
    throw new Error("reviewed OpenShell SDK output directory is required");
  }
  const config = parseAuditConfig(
    readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
  );
  const reviewed = config.sourceRegistryPackage;
  const archive = packReviewedNpmArchive({
    env: process.env,
    expectedIntegrity: reviewed.integrity,
    label: reviewed.label,
    packageSpec: reviewed.packageSpec,
    tarballUrl: reviewed.tarballUrl,
  });
  const output = resolve(outputDirectory);
  try {
    rmSync(output, { force: true, recursive: true });
    mkdirSync(output, { recursive: true });
    const artifact = join(output, reviewed.artifactName);
    copyFileSync(archive.archivePath, artifact);
    return artifact;
  } finally {
    removeReviewedNpmArchive(archive);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputDirectory = process.env.NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY;
  if (!outputDirectory) {
    console.error("NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY is required");
    process.exit(1);
  }
  try {
    process.stdout.write(`${packageReviewedOpenShellSdk(outputDirectory)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
