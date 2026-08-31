// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Verifies Pi qualification receipts and their exact managed-image source revision. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";
import { parse as parseYaml } from "yaml";

import { directDockerfileCopySources } from "../lib/dockerfile-copy-sources.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PI_CANDIDATE_AUTHORITY_PATH = "src/lib/agent/candidate-authority.ts";
const PI_DOCKERFILES = ["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"] as const;
const PI_MANIFEST_PATH = "agents/pi/manifest.yaml";
const PI_QUALIFICATION_RECEIPT_PATHS = {
  "linux/amd64": "ci/pi-agent-qualification-v1-linux-amd64.json",
  "linux/arm64": "ci/pi-agent-qualification-v1-linux-arm64.json",
} as const;

type ReceiptPlatform = keyof typeof PI_QUALIFICATION_RECEIPT_PATHS;
type PiArtifactSources = Readonly<{
  candidateAuthority: string;
  manifest: string;
  qualificationReceipts: Readonly<Record<ReceiptPlatform, string>>;
  releasePackageJson: string;
}>;

type ReceiptVerification = Readonly<{
  failures: readonly string[];
  sourceRevision: string | null;
}>;

type LooseRecord = Record<string, unknown>;
type PiQualificationContract = Readonly<{
  reference: string;
  source: Readonly<{ cohort: string; release: string; revision: string }>;
  startupProfileContractVersion: number;
}>;

function asRecord(value: unknown): LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseRecord)
    : {};
}

function validatePiCandidateContract(
  value: unknown,
  platform: ReceiptPlatform,
): PiQualificationContract {
  const contract = asRecord(value);
  const source = asRecord(contract.source);
  const digest = contract.digest;
  const image = "ghcr.io/nvidia/nemoclaw/pi-sandbox";
  if (
    !isDeepStrictEqual(Object.keys(contract).sort(), [
      "agent",
      "capabilityContractVersion",
      "contractVersion",
      "digest",
      "image",
      "platform",
      "reference",
      "source",
      "startupProfileContractVersion",
    ]) ||
    !isDeepStrictEqual(Object.keys(source).sort(), [
      "cohort",
      "release",
      "repository",
      "revision",
    ]) ||
    contract.contractVersion !== 1 ||
    contract.agent !== "pi" ||
    contract.platform !== platform ||
    contract.image !== image ||
    typeof digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
    contract.reference !== `${image}@${digest}` ||
    source.repository !== "NVIDIA/NemoClaw" ||
    typeof source.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.revision) ||
    typeof source.release !== "string" ||
    !/^v[0-9]+(?:[.][0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(source.release) ||
    typeof source.cohort !== "string" ||
    !/^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u.test(source.cohort) ||
    contract.startupProfileContractVersion !== 1 ||
    contract.capabilityContractVersion !== 1
  ) {
    throw new Error("qualification receipt failed exact contract validation");
  }
  return contract as unknown as PiQualificationContract;
}

function publishedPiReceiptDigests(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    PI_CANDIDATE_AUTHORITY_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let digests: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === "pi" &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(sourceFile) === "Object.freeze"
    ) {
      const array = node.initializer.arguments[0];
      if (array && ts.isArrayLiteralExpression(array)) {
        digests = array.elements.flatMap((element) =>
          ts.isStringLiteral(element) && /^[a-f0-9]{64}$/u.test(element.text) ? [element.text] : [],
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return digests.sort();
}

function verifyPiQualificationReceipts(sources: PiArtifactSources): ReceiptVerification {
  const failures: string[] = [];
  const receipts = Object.entries(sources.qualificationReceipts).flatMap(([platform, contents]) => {
    const receiptPlatform = platform as ReceiptPlatform;
    try {
      const contract = validatePiCandidateContract(
        JSON.parse(contents) as unknown,
        receiptPlatform,
      );
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
  const publishedDigests = publishedPiReceiptDigests(sources.candidateAuthority);
  if (!isDeepStrictEqual(publishedDigests, expectedDigests)) {
    failures.push(
      `${PI_CANDIDATE_AUTHORITY_PATH}: accepted digests must match the exact Pi qualification receipts`,
    );
  }

  let sourceRevision: string | null = null;
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
    const publicationDrift = receipts
      .slice(1)
      .some(
        ({ contract }) =>
          contract.source.revision !== first.contract.source.revision ||
          contract.source.release !== first.contract.source.release ||
          contract.source.cohort !== first.contract.source.cohort,
      );
    if (publicationDrift) {
      failures.push(
        "Pi qualification receipts must identify one source revision, release, and cohort",
      );
    } else {
      sourceRevision = first.contract.source.revision;
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
  return { failures, sourceRevision };
}

function piImageSourcePaths(): string[] {
  const copiedSources = PI_DOCKERFILES.flatMap((dockerfile) =>
    directDockerfileCopySources(path.join(REPO_ROOT, dockerfile), dockerfile).map(
      ({ source }) => source,
    ),
  );
  return [...new Set([".dockerignore", ...PI_DOCKERFILES, ...copiedSources])].sort();
}

function verifyPiImageSourceRevision(sourceRevision: string): string[] {
  const comparison = spawnSync(
    "git",
    ["diff", "--quiet", sourceRevision, "HEAD", "--", ...piImageSourcePaths()],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  if (comparison.status === 0) return [];
  if (comparison.status === 1) {
    return [
      `Pi managed-image sources differ from qualification receipt revision ${sourceRevision}`,
    ];
  }
  const detail =
    comparison.error?.message ||
    comparison.stderr.trim() ||
    `git exited ${String(comparison.status)}`;
  return [`Pi managed-image source comparison failed: ${detail}`];
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function main(): void {
  const requiredArtifacts = [
    ...PI_DOCKERFILES,
    PI_CANDIDATE_AUTHORITY_PATH,
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
    candidateAuthority: readRepoFile(PI_CANDIDATE_AUTHORITY_PATH),
    manifest: readRepoFile(PI_MANIFEST_PATH),
    qualificationReceipts: Object.fromEntries(
      Object.entries(PI_QUALIFICATION_RECEIPT_PATHS).map(([platform, relativePath]) => [
        platform,
        readRepoFile(relativePath),
      ]),
    ) as PiArtifactSources["qualificationReceipts"],
    releasePackageJson: readRepoFile("package.json"),
  };
  const verification = verifyPiQualificationReceipts(sources);
  const failures = [
    ...verification.failures,
    ...(verification.sourceRevision
      ? verifyPiImageSourceRevision(verification.sourceRevision)
      : []),
  ];
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Pi qualification receipts match candidate authority and managed-image sources.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
