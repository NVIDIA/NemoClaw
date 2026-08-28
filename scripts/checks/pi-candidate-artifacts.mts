// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies that Pi qualification receipts match the repository candidate
 * authority and the managed-image contract.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { parse as parseYaml } from "yaml";

import { CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS } from "../../src/lib/agent/candidate-authority.ts";
import { validateCandidateContract } from "../../tools/managed-images/validate-candidate-contract.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PI_CANDIDATE_AUTHORITY_PATH = "src/lib/agent/candidate-authority.ts";
const PI_MANIFEST_PATH = "agents/pi/manifest.yaml";
const PI_QUALIFICATION_RECEIPT_PATHS = {
  "linux/amd64": "ci/pi-agent-qualification-v1-linux-amd64.json",
  "linux/arm64": "ci/pi-agent-qualification-v1-linux-arm64.json",
} as const;

type ReceiptPlatform = keyof typeof PI_QUALIFICATION_RECEIPT_PATHS;
type PiArtifactSources = Readonly<{
  manifest: string;
  qualificationReceipts: Readonly<Record<ReceiptPlatform, string>>;
  releasePackageJson: string;
}>;

function verifyPiQualificationReceipts(sources: PiArtifactSources): string[] {
  const failures: string[] = [];
  const receipts = Object.entries(sources.qualificationReceipts).flatMap(([platform, contents]) => {
    const receiptPlatform = platform as ReceiptPlatform;
    try {
      const contract = validateCandidateContract(JSON.parse(contents) as unknown, receiptPlatform);
      if (contract.agent !== "pi") throw new Error("qualification receipt agent must be pi");
      return [{ contents, contract }];
    } catch (error) {
      failures.push(
        `${PI_QUALIFICATION_RECEIPT_PATHS[receiptPlatform]}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  });
  const expectedDigests = receipts
    .map(({ contents }) => createHash("sha256").update(contents, "utf8").digest("hex"))
    .sort();
  const publishedDigests = [...CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS.pi].sort();
  if (!isDeepStrictEqual(publishedDigests, expectedDigests)) {
    failures.push(
      `${PI_CANDIDATE_AUTHORITY_PATH}: accepted digests must match the exact Pi qualification receipts`,
    );
  }
  if (receipts.length === Object.keys(PI_QUALIFICATION_RECEIPT_PATHS).length) {
    const first = receipts[0]!;
    const manifest = parseYaml(sources.manifest) as {
      managed_image?: { architectures?: unknown; startup_profile_contract_version?: unknown };
    };
    const receiptPlatforms = Object.keys(PI_QUALIFICATION_RECEIPT_PATHS);
    if (!isDeepStrictEqual(manifest.managed_image?.architectures, receiptPlatforms)) {
      failures.push(
        `${PI_MANIFEST_PATH}: managed_image.architectures must match the qualification receipts`,
      );
    }
    if (
      manifest.managed_image?.startup_profile_contract_version !==
      first.contract.startupProfileContractVersion
    ) {
      failures.push(
        `${PI_MANIFEST_PATH}: managed_image.startup_profile_contract_version must match the qualification receipts`,
      );
    }
    const releasePackage = JSON.parse(sources.releasePackageJson) as { version?: unknown };
    const currentRelease =
      typeof releasePackage.version === "string" ? `v${releasePackage.version}` : null;
    if (
      receipts
        .slice(1)
        .some(
          ({ contract }) =>
            contract.source.revision !== first.contract.source.revision ||
            contract.source.release !== first.contract.source.release ||
            contract.source.cohort !== first.contract.source.cohort,
        )
    ) {
      failures.push(
        "Pi qualification receipts must identify one source revision, release, and cohort",
      );
    }
    if (
      currentRelease === null ||
      receipts.some(({ contract }) => contract.source.release !== currentRelease)
    ) {
      failures.push(
        currentRelease === null
          ? "package.json: version must be a string"
          : `Pi qualification receipts must identify current release ${currentRelease}`,
      );
    }
    if (new Set(receipts.map(({ contract }) => contract.reference)).size !== receipts.length) {
      failures.push("Pi qualification receipts must identify unique platform image digests");
    }
  }
  return failures;
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function main(): void {
  const requiredArtifacts = [
    PI_MANIFEST_PATH,
    "package.json",
    ...Object.values(PI_QUALIFICATION_RECEIPT_PATHS),
  ];
  const missing = requiredArtifacts.filter(
    (relativePath) => !fs.existsSync(path.join(REPO_ROOT, relativePath)),
  );
  if (missing.length > 0) {
    console.error(missing.map((relativePath) => `${relativePath}: missing`).join("\n"));
    process.exit(1);
  }
  const sources: PiArtifactSources = {
    manifest: readRepoFile(PI_MANIFEST_PATH),
    qualificationReceipts: Object.fromEntries(
      Object.entries(PI_QUALIFICATION_RECEIPT_PATHS).map(([platform, relativePath]) => [
        platform,
        readRepoFile(relativePath),
      ]),
    ) as PiArtifactSources["qualificationReceipts"],
    releasePackageJson: readRepoFile("package.json"),
  };
  const failures = [...verifyPiQualificationReceipts(sources)];
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Pi qualification receipts match candidate authority and managed-image contract.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
