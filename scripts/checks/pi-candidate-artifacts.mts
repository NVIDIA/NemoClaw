// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the Pi candidate runtime artifacts.
 *
 * Pi ships as a candidate managed image: CI builds and validates it, but it
 * stays out of the shipped managed-image agent cohort and the atomic all-agent
 * release cohort. This check binds the manifest, the locked package identity,
 * both image sources, the dependency review, and the managed-image contract to
 * one exact package version and integrity value, and verifies that the
 * candidate contract artifact name stays outside the all-agent cohort download
 * pattern.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANAGED_IMAGE_CONTRACT_PATH = "src/lib/onboard/managed-image/contract.ts";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const COHORT_CONTRACT_ARTIFACT_PREFIX = "managed-pr-contract-";
const CANDIDATE_CONTRACT_ARTIFACT_PREFIX = "managed-candidate-contract-";

const REQUIRED_ARTIFACTS = [
  "agents/pi/Dockerfile",
  "agents/pi/Dockerfile.base",
  "agents/pi/dependency-review.md",
  "agents/pi/generate-config.ts",
  "agents/pi/manifest.yaml",
  "agents/pi/pi-runtime/package-lock.json",
  "agents/pi/pi-runtime/package.json",
  "agents/pi/policy-additions.yaml",
  "agents/pi/start.sh",
] as const;

export type PiArtifactSources = Readonly<{
  dependencyReview: string;
  dockerfile: string;
  dockerfileBase: string;
  lock: string;
  managedImageContract: string;
  managedImagesWorkflow: string;
  manifest: string;
  packageJson: string;
}>;

function readDockerfileArg(source: string, name: string): string | null {
  const pattern = new RegExp(`^ARG ${name}=(.+)$`, "mu");
  return source.match(pattern)?.[1]?.trim() ?? null;
}

function readManifestField(source: string, name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*"?([^"\\n]+)"?\\s*$`, "mu");
  return source.match(pattern)?.[1]?.trim() ?? null;
}

function lockedPiRelease(lock: string): { version: string | null; integrity: string | null } {
  const parsed = JSON.parse(lock) as {
    packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>;
  };
  const entry = parsed.packages?.[`node_modules/${PI_PACKAGE}`];
  return { version: entry?.version ?? null, integrity: entry?.integrity ?? null };
}

function resolvedArchivesWithoutIntegrity(lock: string): string[] {
  const parsed = JSON.parse(lock) as {
    packages?: Record<string, { integrity?: string; resolved?: string }>;
  };
  return Object.entries(parsed.packages ?? {})
    .filter(
      ([, entry]) =>
        typeof entry.resolved === "string" &&
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? ""),
    )
    .map(([location]) => location);
}

function declaredPiDependency(packageJson: string): string | null {
  const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
  return parsed.dependencies?.[PI_PACKAGE] ?? null;
}

function verifyPinnedIdentity(sources: PiArtifactSources): string[] {
  const failures: string[] = [];
  const locked = lockedPiRelease(sources.lock);
  const declared = declaredPiDependency(sources.packageJson);
  const manifestVersion = readManifestField(sources.manifest, "expected_version");
  if (!locked.version || !locked.integrity) {
    return [`agents/pi/pi-runtime/package-lock.json: ${PI_PACKAGE} is not locked`];
  }
  const archivesWithoutIntegrity = resolvedArchivesWithoutIntegrity(sources.lock);
  if (archivesWithoutIntegrity.length > 0) {
    failures.push(
      `agents/pi/pi-runtime/package-lock.json: resolved archives must use committed SHA-512 integrity: ${archivesWithoutIntegrity.join(", ")}`,
    );
  }
  if (declared !== locked.version) {
    failures.push(
      `agents/pi/pi-runtime/package.json: ${PI_PACKAGE} must request the locked ${locked.version}`,
    );
  }
  if (manifestVersion !== locked.version) {
    failures.push(`agents/pi/manifest.yaml: expected_version must be ${locked.version}`);
  }
  for (const [label, source] of [
    ["agents/pi/Dockerfile.base", sources.dockerfileBase],
    ["agents/pi/Dockerfile", sources.dockerfile],
  ] as const) {
    if (readDockerfileArg(source, "PI_VERSION") !== locked.version) {
      failures.push(`${label}: PI_VERSION must be ${locked.version}`);
    }
  }
  if (readDockerfileArg(sources.dockerfileBase, "PI_PACKAGE") !== PI_PACKAGE) {
    failures.push(`agents/pi/Dockerfile.base: PI_PACKAGE must be ${PI_PACKAGE}`);
  }
  if (readDockerfileArg(sources.dockerfileBase, "PI_NPM_INTEGRITY") !== locked.integrity) {
    failures.push("agents/pi/Dockerfile.base: PI_NPM_INTEGRITY must match the locked integrity");
  }
  if (!sources.dockerfileBase.includes("ci --omit=dev --ignore-scripts")) {
    failures.push("agents/pi/Dockerfile.base: the Pi install must disable lifecycle scripts");
  }
  if (!sources.dependencyReview.includes(locked.integrity)) {
    failures.push("agents/pi/dependency-review.md: must record the locked npm integrity value");
  }
  const lockDigest = createHash("sha256").update(sources.lock).digest("hex");
  if (!sources.dependencyReview.includes(lockDigest)) {
    failures.push(`agents/pi/dependency-review.md: lockfile SHA-256 must be ${lockDigest}`);
  }
  return failures;
}

function readAgentList(source: string, name: string): string[] | null {
  const pattern = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`, "u");
  const body = source.match(pattern)?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/"([^"]+)"/gu)].map(([, agent]) => agent);
}

function readNumberConst(source: string, name: string): number | null {
  const pattern = new RegExp(`export const ${name} = (\\d+) as const;`, "u");
  const match = source.match(pattern)?.[1];
  return match === undefined ? null : Number(match);
}

function verifyCandidateRegistration(contractSource: string): string[] {
  const failures: string[] = [];
  const candidates = readAgentList(contractSource, "CANDIDATE_MANAGED_IMAGE_AGENTS");
  const shipped = readAgentList(contractSource, "SHIPPED_MANAGED_IMAGE_AGENTS");
  if (!candidates || !shipped) {
    return [`${MANAGED_IMAGE_CONTRACT_PATH}: managed-image agent cohorts are not readable`];
  }
  if (!candidates.includes("pi")) {
    failures.push(`${MANAGED_IMAGE_CONTRACT_PATH}: pi must be a candidate managed-image agent`);
  }
  if (shipped.includes("pi")) {
    failures.push(`${MANAGED_IMAGE_CONTRACT_PATH}: pi must stay out of the shipped agent cohort`);
  }
  if (!contractSource.includes('pi: "ghcr.io/nvidia/nemoclaw/pi-sandbox"')) {
    failures.push(
      `${MANAGED_IMAGE_CONTRACT_PATH}: pi must publish to ghcr.io/nvidia/nemoclaw/pi-sandbox`,
    );
  }
  return failures;
}

function verifyManagedImageDeclaration(sources: PiArtifactSources): string[] {
  const platforms = readAgentList(sources.managedImageContract, "MANAGED_IMAGE_PLATFORMS");
  const startupProfileContractVersion = readNumberConst(
    sources.managedImageContract,
    "MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION",
  );
  if (!platforms || startupProfileContractVersion === null) {
    return [
      `${MANAGED_IMAGE_CONTRACT_PATH}: MANAGED_IMAGE_PLATFORMS or MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION is not readable`,
    ];
  }
  const manifest = parseYaml(sources.manifest) as {
    managed_image?: { architectures?: unknown; startup_profile_contract_version?: unknown };
  };
  const failures: string[] = [];
  const architectures = manifest.managed_image?.architectures;
  const architecturesMatch =
    Array.isArray(architectures) &&
    architectures.length === platforms.length &&
    platforms.every((platform, index) => architectures[index] === platform);
  if (!architecturesMatch) {
    failures.push(
      `agents/pi/manifest.yaml: managed_image.architectures must be ${JSON.stringify(platforms)}`,
    );
  }
  if (manifest.managed_image?.startup_profile_contract_version !== startupProfileContractVersion) {
    failures.push(
      `agents/pi/manifest.yaml: managed_image.startup_profile_contract_version must be ${startupProfileContractVersion}`,
    );
  }
  return failures;
}

function verifyCohortSeparation(workflow: string): string[] {
  const failures: string[] = [];
  const candidateArtifactPattern = new RegExp(
    `name: ${CANDIDATE_CONTRACT_ARTIFACT_PREFIX}[^\\n]*`,
    "u",
  );
  if (!candidateArtifactPattern.test(workflow)) {
    failures.push(
      `.github/workflows/managed-images.yaml: the Pi candidate lane must upload a ${CANDIDATE_CONTRACT_ARTIFACT_PREFIX}* contract`,
    );
  }
  if (CANDIDATE_CONTRACT_ARTIFACT_PREFIX.startsWith(COHORT_CONTRACT_ARTIFACT_PREFIX)) {
    failures.push(
      "the candidate contract artifact prefix must not match the all-agent cohort download pattern",
    );
  }
  const cohortDownloadPattern = new RegExp(
    `pattern: ${COHORT_CONTRACT_ARTIFACT_PREFIX}[^\\n]*`,
    "u",
  );
  if (!cohortDownloadPattern.test(workflow)) {
    failures.push(
      ".github/workflows/managed-images.yaml: the all-agent cohort download pattern is missing",
    );
  }
  return failures;
}

export function verifyPiCandidateArtifacts(sources: PiArtifactSources): string[] {
  return [
    ...verifyPinnedIdentity(sources),
    ...verifyCandidateRegistration(sources.managedImageContract),
    ...verifyCohortSeparation(sources.managedImagesWorkflow),
    ...verifyManagedImageDeclaration(sources),
  ];
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function main(): void {
  const missing = REQUIRED_ARTIFACTS.filter(
    (relativePath) => !fs.existsSync(path.join(REPO_ROOT, relativePath)),
  );
  if (missing.length > 0) {
    console.error(missing.map((relativePath) => `${relativePath}: missing`).join("\n"));
    process.exit(1);
  }
  const failures = verifyPiCandidateArtifacts({
    dependencyReview: readRepoFile("agents/pi/dependency-review.md"),
    dockerfile: readRepoFile("agents/pi/Dockerfile"),
    dockerfileBase: readRepoFile("agents/pi/Dockerfile.base"),
    lock: readRepoFile("agents/pi/pi-runtime/package-lock.json"),
    managedImageContract: readRepoFile(MANAGED_IMAGE_CONTRACT_PATH),
    managedImagesWorkflow: readRepoFile(".github/workflows/managed-images.yaml"),
    manifest: readRepoFile("agents/pi/manifest.yaml"),
    packageJson: readRepoFile("agents/pi/pi-runtime/package.json"),
  });
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Pi candidate runtime artifacts are pinned and stay outside the release cohort.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
