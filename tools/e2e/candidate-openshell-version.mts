// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  validateInstallerSources,
  readOpenShellTrustRegistry,
} from "../../scripts/checks/extract-installer-pins.mts";
import { readCandidateUpgradeSource } from "./candidate-upgrade-admission.mts";
import { githubRequest } from "./base-image-publication.mts";
import {
  CANDIDATE_OPENSHELL_SOURCES as SOURCE_PATHS,
  readCandidateOpenShellRegistry,
  reviewedCandidateOpenShellTrust,
  registryCoveredByTrusted,
} from "./candidate-openshell-trust.mts";

// Runs from the trusted workflow checkout, before any candidate code executes.
// Candidate files are inert inputs to the existing release/template verifier.
export async function candidateOpenShellVersion(
  repository: string,
  candidateSha: string,
  request: (path: string) => Promise<unknown>,
  review?: { prNumber: number; baseSha: string },
): Promise<string> {
  if (repository !== "NVIDIA/NemoClaw" || !/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("OpenShell selection requires an exact NVIDIA/NemoClaw candidate SHA");
  }
  const sources = {} as Record<keyof typeof SOURCE_PATHS, string>;
  for (const [key, sourcePath] of Object.entries(SOURCE_PATHS)) {
    sources[key as keyof typeof SOURCE_PATHS] = await readCandidateUpgradeSource(
      request,
      candidateSha,
      sourcePath,
    );
  }
  if (review) {
    const registry = await readCandidateOpenShellRegistry(candidateSha, request);
    if (!registryCoveredByTrusted(registry, readOpenShellTrustRegistry())) {
      const approved = await reviewedCandidateOpenShellTrust({ ...review, candidateSha }, request);
      return approved.selected.releaseVersion;
    }
  }
  return validateInstallerSources(sources).releaseVersion;
}

/** Fixed upstream binary identities for the two releases used by the MCP qualification jobs. */
export function reviewedOpenShellMcpRuntime(version: string) {
  let sourceSha: string;
  let supervisorDigest: string;
  let cli: string;
  let gateway: string;
  let standaloneSandbox: string;
  switch (version) {
    case "0.0.116":
      sourceSha = "d1155aa70042d3e2ee49dbfa15346b108b7c1d92";
      supervisorDigest = "c8c42aef16c200063e32cbf72e553e4ead027085427b555efafd95063ecead42";
      cli = "24e85062073d512d1951c76cd3890b7bce1ab01cc36a08f88b3b43c067a402da";
      gateway = "780fc7ad871e2163f3fb866a2d0254ee682fc0d83e6261a84b350c8dcdd9f47b";
      standaloneSandbox = "326ee26df8f8575ba761470757a12fe5c1cdc904ba064b81946692dd0328dd40";
      break;
    case "0.1.3":
      sourceSha = "e1f3c82caa3ed3b65de22889ae7ef32a774878ef";
      supervisorDigest = "4ab2b970cdb02c7518ba4ccbbadb4861ae9a8d0b8770e5b160697f0453b0a8e4";
      cli = "557f8e2af1d91221211bb29cc7152d975084d2a8c9ab8c549d46c4370ccf492e";
      gateway = "a6d230ccf79f777602e5a7d101775edcb8f59a29dc569d8cd41544ebb8e44fda";
      standaloneSandbox = "23147b42d31bd0b13e1a9ed7b3834b8e6075836cba0872fffa9e7d481f6dd281";
      break;
    default:
      throw new Error("The selected OpenShell release has no reviewed MCP runtime provenance");
  }
  return {
    supervisorImage: `ghcr.io/nvidia/openshell/supervisor@sha256:${supervisorDigest}`,
    provenance: {
      schemaVersion: 1,
      sourceRepository: "NVIDIA/OpenShell",
      releaseTag: `v${version}`,
      sourceSha,
      artifacts: {
        cli: { binarySha256: cli },
        gateway: { binarySha256: gateway },
        standaloneSandbox: { binarySha256: standaloneSandbox },
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GitHub output path is required");
  const version = await candidateOpenShellVersion(
    process.env.CANDIDATE_REPOSITORY ?? "",
    process.env.CANDIDATE_SHA ?? "",
    (url) => githubRequest(url, process.env.GITHUB_TOKEN ?? ""),
    process.env.UPGRADE_PR_NUMBER
      ? {
          prNumber: Number(process.env.UPGRADE_PR_NUMBER),
          baseSha: process.env.UPGRADE_BASE_SHA ?? "",
        }
      : undefined,
  );
  const runtime =
    process.env.MCP_RUNTIME_REQUIRED === "true" ? reviewedOpenShellMcpRuntime(version) : null;
  appendFileSync(
    output,
    `version=${version}\n` +
      (runtime
        ? `supervisor_image=${runtime.supervisorImage}\nruntime_provenance=${JSON.stringify(runtime.provenance)}\n`
        : ""),
  );
  console.log(`Reviewed candidate OpenShell release: ${version}`);
}
