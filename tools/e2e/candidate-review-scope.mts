// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CandidateUpgradeIdentity, UpgradeRequest } from "./candidate-upgrade-admission.mts";

const PREFIX = "/repos/NVIDIA/NemoClaw";
const SHA = /^[a-f0-9]{40}$/u;

// These are the trusted controllers and installer verifier, including the API transport.
// SDK admission also depends on the package verifier and its archive/audit helpers.
function governsAdmission(path: string, sdk: boolean): boolean {
  return (
    path.startsWith("tools/e2e/candidate-") ||
    [
      "tools/e2e/base-image-publication.mts",
      "tools/e2e/protected-openshell-workspace.mts",
      "scripts/checks/extract-installer-pins.mts",
      "scripts/checks/openshell-trust-data.mts",
      "scripts/check-installer-hash.sh",
      "ci/openshell-upgrade-trust.json",
      ".github/actions/ci-installer-hash-check/action.yaml",
      ".github/workflows/candidate-upgrade-admission.yaml",
      ".github/workflows/candidate-review-signal.yaml",
      ".github/workflows/installer-hash-check.yaml",
      ".github/workflows/managed-images.yaml",
      ".github/workflows/e2e.yaml",
    ].includes(path) ||
    (sdk &&
      (path.startsWith("scripts/lib/") ||
        path.startsWith(".github/actions/") ||
        [
          "scripts/audit-reviewed-npm-graph.mts",
          "ci/reviewed-npm-audit.json",
          "scripts/checks/candidate-openshell-sdk.mts",
          "scripts/checks/package-openshell-sdk-for-pr.mts",
          "scripts/checks/prepare-ci-npm-install.mts",
          "scripts/checks/resolve-managed-pr-base.sh",
          ".github/workflows/pr.yaml",
        ].includes(path)))
  );
}

async function compare(request: UpgradeRequest, base: string, head: string) {
  const value = await request(`${PREFIX}/compare/${base}...${head}?per_page=1`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Candidate review comparison is unavailable");
  const result = value as {
    status?: string;
    base_commit?: { sha?: string };
    merge_base_commit?: { sha?: string };
    files?: { filename: string; previous_filename?: string }[];
  };
  if (
    result.base_commit?.sha !== base ||
    typeof result.merge_base_commit?.sha !== "string" ||
    !SHA.test(result.merge_base_commit.sha) ||
    !["ahead", "behind", "diverged", "identical"].includes(result.status ?? "")
  )
    throw new Error("Candidate review comparison has invalid commit identities");
  return result;
}

function changedPaths(result: Awaited<ReturnType<typeof compare>>): string[] {
  // GitHub returns at most 300 files, only on the first comparison page. At the cap,
  // completeness is unknown. A fresh review avoids carrying authority over that gap.
  if (!Array.isArray(result.files) || result.files.length >= 300)
    throw new Error("Candidate review comparison has an incomplete file list; refresh the review");
  return result.files.flatMap((file) => {
    if (
      !file ||
      typeof file.filename !== "string" ||
      file.filename.length === 0 ||
      (file.previous_filename !== undefined && typeof file.previous_filename !== "string")
    )
      throw new Error("Candidate review comparison has an invalid file path");
    return file.previous_filename === undefined
      ? [file.filename]
      : [file.filename, file.previous_filename];
  });
}

/** Reuse a review only for unchanged inputs and policy, never as test or merge evidence. */
export async function candidateReviewCoversInputs(
  identity: CandidateUpgradeIdentity,
  reviewedSha: string,
  paths: readonly string[],
  request: UpgradeRequest,
): Promise<boolean> {
  const sdk = paths.some((path) => path === "package.json" || path === "nemoclaw/package.json");
  if (reviewedSha !== identity.candidateSha) {
    const candidate = await compare(request, reviewedSha, identity.candidateSha);
    if (candidate.status !== "ahead" || candidate.merge_base_commit!.sha !== reviewedSha)
      return false;
    if (changedPaths(candidate).some((path) => paths.includes(path) || governsAdmission(path, sdk)))
      return false;
  }
  // GitHub reviews bind a candidate commit, not a base commit. Its common ancestor
  // with main is a conservative policy baseline. Require synchronization and a new
  // review when governing policy changed after that baseline.
  const ancestry = await compare(request, identity.baseSha, reviewedSha);
  const reviewedBase = ancestry.merge_base_commit!.sha!;
  if (reviewedBase !== identity.baseSha) {
    const policy = await compare(request, reviewedBase, identity.baseSha);
    if (policy.status !== "ahead" || policy.merge_base_commit!.sha !== reviewedBase)
      throw new Error("Candidate review policy history is inconsistent");
    if (changedPaths(policy).some((path) => governsAdmission(path, sdk))) return false;
  }
  return true;
}
