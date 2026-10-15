#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import {
  packReviewedNpmArchive,
  readReviewedNpmArchiveFile,
  removeReviewedNpmArchive,
} from "../lib/reviewed-npm-archive.mts";
import type {
  CandidateUpgradeIdentity,
  UpgradeRequest,
} from "../../tools/e2e/candidate-upgrade-admission.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function packageReviewedOpenShellSdk(
  outputDirectory: string,
  replacementMode: "exclude" | "require" | "if-present" = "exclude",
  dependencies: Readonly<{
    pack?: typeof packReviewedNpmArchive;
    readAuditConfig?: () => string;
    remove?: typeof removeReviewedNpmArchive;
    env?: NodeJS.ProcessEnv;
  }> = {},
): string {
  if (!outputDirectory) {
    throw new Error("reviewed OpenShell SDK output directory is required");
  }
  const config = parseAuditConfig(
    dependencies.readAuditConfig?.() ??
      readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
  );
  if (replacementMode === "require" && !config.sourceRegistryPackageReplacement) {
    throw new Error("reviewed OpenShell SDK replacement metadata is required");
  }
  const reviewedPackages =
    replacementMode !== "exclude" && config.sourceRegistryPackageReplacement
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
        env: dependencies.env ?? process.env,
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

/** Package admitted SDK bytes with trusted code; revocation prevents publication of this output. */
export async function packageApprovedCandidateOpenShellSdk(
  outputDirectory: string,
  input: CandidateUpgradeIdentity,
  request: UpgradeRequest,
  dependencies: Parameters<typeof packageReviewedOpenShellSdk>[2] = {},
): Promise<string> {
  const identity = Object.freeze({ ...input });
  if (!isAbsolute(outputDirectory) || lstatSync(outputDirectory, { throwIfNoEntry: false })) {
    throw new Error("Candidate SDK output must be a new absolute directory");
  }
  // The ordinary main producer uses a sparse checkout without candidate admission code.
  const { readApprovedOpenShellSdkConfig } = await import("./candidate-openshell-sdk.mts");
  const trustedSource =
    dependencies.readAuditConfig?.() ??
    readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8");
  const before = await readApprovedOpenShellSdkConfig(identity, request, trustedSource);
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...environment } = dependencies.env ?? process.env;
  try {
    const artifact = packageReviewedOpenShellSdk(outputDirectory, "exclude", {
      ...dependencies,
      env: { ...environment, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
      readAuditConfig: () => before.configSource,
    });
    const sdk = parseAuditConfig(before.configSource).sourceRegistryPackage;
    readReviewedNpmArchiveFile({
      archivePath: artifact,
      expectedIntegrity: sdk.integrity,
      label: sdk.label,
      maximumBytes: 32 * 1024 * 1024,
    });
    const after = await readApprovedOpenShellSdkConfig(identity, request, trustedSource);
    if (
      before.configSource !== after.configSource ||
      JSON.stringify(before.sources) !== JSON.stringify(after.sources) ||
      before.commentId !== after.commentId ||
      before.reviewer !== after.reviewer
    ) {
      throw new Error("Candidate SDK admission changed during packaging");
    }
    return artifact;
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function packageCandidateOpenShellSdkIfRequired(
  outputDirectory: string,
  identity: CandidateUpgradeIdentity,
  request: UpgradeRequest,
  dependencies: Parameters<typeof packageReviewedOpenShellSdk>[2] = {},
) {
  const { readCandidateSdkPackageDecision } = await import("./candidate-openshell-sdk.mts");
  const source =
    dependencies.readAuditConfig?.() ??
    readFileSync(join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"), "utf8");
  const before = await readCandidateSdkPackageDecision(identity, request, source);
  if (!before.required) return before;
  const artifact = await packageApprovedCandidateOpenShellSdk(
    outputDirectory,
    identity,
    request,
    dependencies,
  );
  try {
    const after = await readCandidateSdkPackageDecision(identity, request, source);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Candidate SDK publication identity changed");
    return { ...before, artifact };
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputDirectory = process.env.NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY;
  if (!outputDirectory) {
    console.error("NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY is required");
    process.exit(1);
  }
  const includeReplacementValue = process.env.NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_REPLACEMENT;
  const includeAvailableReplacementValue =
    process.env.NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_AVAILABLE_REPLACEMENT;
  if (includeReplacementValue !== undefined && includeReplacementValue !== "1") {
    console.error("NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_REPLACEMENT must be 1 when set");
    process.exit(1);
  }
  if (includeAvailableReplacementValue !== undefined && includeAvailableReplacementValue !== "1") {
    console.error("NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_AVAILABLE_REPLACEMENT must be 1 when set");
    process.exit(1);
  }
  if (includeReplacementValue !== undefined && includeAvailableReplacementValue !== undefined) {
    console.error("OpenShell SDK replacement modes are mutually exclusive");
    process.exit(1);
  }
  try {
    const candidateMode = process.env.NEMOCLAW_OPEN_SHELL_SDK_CANDIDATE;
    if (candidateMode !== undefined && candidateMode !== "1") {
      throw new Error("NEMOCLAW_OPEN_SHELL_SDK_CANDIDATE must be 1 when set");
    }
    if (candidateMode === "1" && (includeReplacementValue || includeAvailableReplacementValue)) {
      throw new Error("Candidate SDK packaging selects only the admitted lock identity");
    }
    const replacementMode =
      includeReplacementValue === "1"
        ? "require"
        : includeAvailableReplacementValue === "1"
          ? "if-present"
          : "exclude";
    const artifact =
      candidateMode === "1"
        ? await packageApprovedCandidateOpenShellSdk(
            outputDirectory,
            {
              prNumber: Number(process.env.UPGRADE_PR_NUMBER),
              candidateSha: process.env.CANDIDATE_SHA ?? "",
              baseSha: process.env.UPGRADE_BASE_SHA ?? "",
            },
            async (path) => {
              const { githubRequest } = await import("../../tools/e2e/base-image-publication.mts");
              return githubRequest(path, process.env.GITHUB_TOKEN ?? "");
            },
          )
        : packageReviewedOpenShellSdk(outputDirectory, replacementMode);
    process.stdout.write(`${artifact}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
