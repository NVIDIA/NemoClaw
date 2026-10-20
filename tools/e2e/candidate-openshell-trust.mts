// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  readOpenShellTrustRegistry,
  resolveOpenShellTrustRegistry,
  installerReleaseTsv,
  readInstallerInput,
  validateInstallerSources,
} from "../../scripts/checks/extract-installer-pins.mts";
import {
  readApprovedCandidateUpgrade,
  readCandidateUpgradeSource,
  type CandidateUpgradeIdentity,
  type UpgradeRequest,
} from "./candidate-upgrade-admission.mts";
import { pathToFileURL } from "node:url";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { githubRequest } from "./base-image-publication.mts";
import {
  parseOpenShellTrustRegistry,
  type OpenShellTrustRegistry,
} from "../../scripts/checks/openshell-trust-data.mts";

export const CANDIDATE_OPENSHELL_TRUST_PATH = "ci/openshell-upgrade-trust.json";
const emptyRegistry = (): OpenShellTrustRegistry => ({
  schemaVersion: 1,
  releases: [],
  revokedTemplateSha256: [],
});
export const CANDIDATE_OPENSHELL_SOURCES = {
  blueprintSource: "nemoclaw-blueprint/blueprint.yaml",
  installerSource: "scripts/install-openshell.sh",
  brevInstallerSource: "scripts/brev-launchable-ci-cpu.sh",
  supervisorRuntimeSource: "src/lib/onboard/docker-driver-gateway-runtime.ts",
} as const;

/** Establish absence from a complete immutable directory listing, never from an API error. */
export async function readCandidateOpenShellRegistry(
  candidateSha: string,
  request: UpgradeRequest,
): Promise<OpenShellTrustRegistry> {
  if (!/^[a-f0-9]{40}$/u.test(candidateSha))
    throw new Error("Candidate registry requires an immutable commit");
  const entries = await request(`/repos/NVIDIA/NemoClaw/contents/ci?ref=${candidateSha}`);
  // GitHub caps directory responses at 1,000 entries. At the cap, absence is inconclusive.
  if (!Array.isArray(entries) || entries.length >= 1000)
    throw new Error("Candidate registry directory listing is incomplete or invalid");
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !/^ci\/[A-Za-z0-9_.-]+$/u.test(entry.path) ||
      paths.has(entry.path)
    )
      throw new Error("Candidate registry directory listing is invalid");
    paths.add(entry.path);
    if (
      entry.path === CANDIDATE_OPENSHELL_TRUST_PATH &&
      (entry.type !== "file" || entry.submodule_git_url !== undefined || entry.target !== undefined)
    )
      throw new Error("Candidate registry must be a regular file");
  }
  return paths.has(CANDIDATE_OPENSHELL_TRUST_PATH)
    ? parseOpenShellTrustRegistry(
        await readCandidateUpgradeSource(request, candidateSha, CANDIDATE_OPENSHELL_TRUST_PATH),
      )
    : emptyRegistry();
}

function candidateRegistrySource(root: string): string | undefined {
  const parent = lstatSync(join(root, "ci"));
  if (parent.isSymbolicLink() || !parent.isDirectory())
    throw new Error("Candidate registry parent must be a real directory");
  const path = join(root, CANDIDATE_OPENSHELL_TRUST_PATH);
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
  return readInstallerInput(path, "candidate OpenShell registry");
}

/** Read the approved manifest and its consumers from the same immutable commit, without execution. */
export async function reviewedCandidateOpenShellTrust(
  identity: CandidateUpgradeIdentity,
  request: UpgradeRequest,
) {
  const admission = await readApprovedCandidateUpgrade(
    identity,
    [...Object.values(CANDIDATE_OPENSHELL_SOURCES), CANDIDATE_OPENSHELL_TRUST_PATH],
    request,
  );
  const registry = parseOpenShellTrustRegistry(admission.sources[CANDIDATE_OPENSHELL_TRUST_PATH]!);
  const releases = resolveOpenShellTrustRegistry(registry, readOpenShellTrustRegistry());
  const sources = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      key,
      admission.sources[path]!,
    ]),
  ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
  const selected = validateInstallerSources(sources, releases);
  if (!registry.releases.some((release) => release.version === selected.releaseVersion))
    throw new Error("Upgrade trust registry does not select the candidate release");
  return {
    registrySource: admission.sources[CANDIDATE_OPENSHELL_TRUST_PATH]!,
    sources,
    releases,
    selected,
    reviewer: admission.reviewer,
    commentId: admission.commentId,
  };
}

/** Older candidate data needs no new approval when trusted history already covers it. */
export function registryCoveredByTrusted(
  candidate: OpenShellTrustRegistry,
  trusted: OpenShellTrustRegistry,
): boolean {
  try {
    resolveOpenShellTrustRegistry(trusted, candidate);
    return true;
  } catch {
    return false;
  }
}

/** Verify base-covered trust without a new approval; new trust must pass live admission. */
export async function verifyCandidateInstallerTrust(
  root: string,
  identity: CandidateUpgradeIdentity,
  request: UpgradeRequest,
) {
  if (!isAbsolute(root))
    throw new Error("Candidate verification requires an absolute checkout root");
  const registrySource = candidateRegistrySource(root);
  const registry =
    registrySource === undefined ? emptyRegistry() : parseOpenShellTrustRegistry(registrySource);
  const base = readOpenShellTrustRegistry();
  if (registryCoveredByTrusted(registry, base)) {
    const sources = Object.fromEntries(
      Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
        key,
        readInstallerInput(join(root, path), path),
      ]),
    ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
    return validateInstallerSources(sources, resolveOpenShellTrustRegistry(base));
  }
  const approved = await reviewedCandidateOpenShellTrust(identity, request);
  if (registrySource !== approved.registrySource)
    throw new Error("Candidate registry differs from the approved commit");
  assertCandidateInstallerCheckout(root, approved.sources);
  return approved.selected;
}

/** Refuse a green hash check for bytes other than the independently approved commit. */
export function assertCandidateInstallerCheckout(
  root: string,
  sources: Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>,
): void {
  if (!isAbsolute(root))
    throw new Error("Candidate verification requires an absolute checkout root");
  for (const [key, path] of Object.entries(CANDIDATE_OPENSHELL_SOURCES)) {
    if (readInstallerInput(join(root, path), path) !== sources[key as keyof typeof sources]) {
      throw new Error(`Candidate checkout differs from the approved commit: ${path}`);
    }
  }
}

// This command emits inert records only. The shell check still fetches and hashes
// upstream assets; it never executes the approved candidate installer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2 || !process.env.GITHUB_TOKEN)
    throw new Error("Candidate installer verification requires authenticated GitHub access");
  const selected = await verifyCandidateInstallerTrust(
    process.env.UPGRADE_CANDIDATE_ROOT ?? "",
    {
      prNumber: Number(process.env.UPGRADE_PR_NUMBER),
      candidateSha: process.env.UPGRADE_CANDIDATE_SHA ?? "",
      baseSha: process.env.UPGRADE_BASE_SHA ?? "",
    },
    (url) => githubRequest(url, process.env.GITHUB_TOKEN!),
  );
  process.stdout.write(installerReleaseTsv(selected));
}
