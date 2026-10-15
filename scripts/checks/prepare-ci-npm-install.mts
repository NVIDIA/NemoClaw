#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  inspectCiNpmInstall,
  prepareCiNpmInstall,
  requiresCandidateSdkAdmission,
  type PreparationRequest,
} from "../lib/reviewed-ci-npm-install.mts";

export {
  inspectCiNpmInstall,
  prepareCiNpmInstall,
  prepareCiNpmInstallWithReviewedConfig,
  requiresCandidateSdkAdmission,
  seedReviewedSourceRegistryArtifact,
  type ReviewedSourceRegistryArtifactRequest,
  type ReviewedSourceRegistryPackage,
} from "../lib/reviewed-ci-npm-install.mts";

const TRUSTED_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  const main = async () => {
    const candidate = process.env.NEMOCLAW_OPEN_SHELL_SDK_CANDIDATE;
    if (candidate !== undefined && candidate !== "1") {
      throw new Error("NEMOCLAW_OPEN_SHELL_SDK_CANDIDATE must be 1 when set");
    }
    const mode = process.env.NEMOCLAW_CI_NPM_PACKAGE_MODE;
    const targetRoot = process.env.NEMOCLAW_CI_TARGET_ROOT;
    const trustedSource = readFileSync(
      join(TRUSTED_REPOSITORY_ROOT, "ci/reviewed-npm-audit.json"),
      "utf8",
    );
    const candidateRequired =
      candidate === "1" ||
      (process.env.GITHUB_EVENT_NAME === "pull_request" &&
        targetRoot !== undefined &&
        requiresCandidateSdkAdmission(
          ["package-lock.json", "nemoclaw/package-lock.json"].map((path) =>
            readFileSync(join(targetRoot, path), "utf8"),
          ),
          trustedSource,
        ));
    if (candidateRequired) {
      if (mode !== "artifact" && mode !== "inspect")
        throw new Error("Candidate SDK installation requires artifact mode");
      const token = process.env.GITHUB_TOKEN ?? "";
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      const { prepareApprovedCandidateOpenShellSdk, inspectApprovedCandidateOpenShellSdk } =
        await import("./candidate-openshell-sdk.mts");
      const { githubRequest } = await import("../../tools/e2e/base-image-publication.mts");
      const identity = {
        prNumber: Number(process.env.UPGRADE_PR_NUMBER),
        candidateSha: process.env.CANDIDATE_SHA ?? "",
        baseSha: process.env.UPGRADE_BASE_SHA ?? "",
        mergeSha:
          process.env.GITHUB_EVENT_NAME === "pull_request" ? process.env.GITHUB_SHA : undefined,
      };
      const request = (path: string) => githubRequest(path, token);
      if (mode === "inspect" && targetRoot) {
        process.stdout.write(
          `${JSON.stringify(await inspectApprovedCandidateOpenShellSdk(targetRoot, identity, request, trustedSource))}\n`,
        );
      } else {
        await prepareApprovedCandidateOpenShellSdk(
          requestFromEnvironment(),
          identity,
          request,
          trustedSource,
        );
      }
      return;
    }
    if (mode === "inspect" && targetRoot) {
      process.stdout.write(`${JSON.stringify(inspectCiNpmInstall(targetRoot))}\n`);
    } else {
      await prepareCiNpmInstall(requestFromEnvironment());
    }
  };
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
