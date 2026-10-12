// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateInstallerSources } from "../../scripts/checks/extract-installer-pins.mts";
import { githubRequest } from "./base-image-publication.mts";

const SOURCE_PATHS = {
  blueprintSource: "nemoclaw-blueprint/blueprint.yaml",
  installerSource: "scripts/install-openshell.sh",
  brevInstallerSource: "scripts/brev-launchable-ci-cpu.sh",
  supervisorRuntimeSource: "src/lib/onboard/docker-driver-gateway-runtime.ts",
} as const;

// Runs from the trusted workflow checkout, before any candidate code executes.
// Candidate files are inert inputs to the existing release/template verifier.
export async function candidateOpenShellVersion(
  repository: string,
  candidateSha: string,
  request: (path: string) => Promise<unknown>,
): Promise<string> {
  if (repository !== "NVIDIA/NemoClaw" || !/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("OpenShell selection requires an exact NVIDIA/NemoClaw candidate SHA");
  }
  const sources = {} as Record<keyof typeof SOURCE_PATHS, string>;
  for (const [key, sourcePath] of Object.entries(SOURCE_PATHS)) {
    const value = await request(`/repos/${repository}/contents/${sourcePath}?ref=${candidateSha}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Missing candidate source: ${sourcePath}`);
    }
    const blob = value as Record<string, unknown>;
    if (
      blob.type !== "file" ||
      blob.path !== sourcePath ||
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      blob.content.length > 1_500_000 ||
      typeof blob.size !== "number" ||
      blob.size < 1 ||
      blob.size > 1024 * 1024 ||
      blob.submodule_git_url !== undefined ||
      blob.target !== undefined
    ) {
      throw new Error(`Invalid candidate source: ${sourcePath}`);
    }
    const bytes = Buffer.from(blob.content, "base64");
    if (bytes.length !== blob.size || bytes.includes(0)) {
      throw new Error(`Invalid candidate source bytes: ${sourcePath}`);
    }
    sources[key as keyof typeof SOURCE_PATHS] = bytes.toString("utf8");
  }
  return validateInstallerSources(sources).releaseVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GitHub output path is required");
  const version = await candidateOpenShellVersion(
    process.env.CANDIDATE_REPOSITORY ?? "",
    process.env.CANDIDATE_SHA ?? "",
    (url) => githubRequest(url, process.env.GITHUB_TOKEN ?? ""),
  );
  appendFileSync(output, `version=${version}\n`);
  console.log(`Reviewed candidate OpenShell release: ${version}`);
}
