// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAuditConfig } from "../audit-reviewed-npm-graph.mts";
import { resolvePathWithinRoot } from "../lib/repository-input-path.mts";
import { stageReviewedArchiveWithNpm, type NpmCacheStager } from "../lib/reviewed-npm-cache.mts";
import {
  prepareCiNpmInstallWithReviewedConfig,
  requiresCandidateSdkAdmission,
} from "../lib/reviewed-ci-npm-install.mts";
import {
  reviewedNpmDependencyLocations,
  verifyReviewedNpmLockPackages,
} from "../lib/reviewed-npm-archive.mts";
import {
  readApprovedCandidateUpgrade,
  readCandidateUpgradeSource,
  type CandidateUpgradeIdentity,
  type UpgradeRequest,
} from "../../tools/e2e/candidate-upgrade-admission.mts";

const SDK = "@nvidia/openshell-sdk";
const CONFIG = "ci/reviewed-npm-audit.json";
const MANIFESTS = ["package.json", "nemoclaw/package.json"] as const;
const LOCKS = ["package-lock.json", "nemoclaw/package-lock.json"] as const;
type Config = ReturnType<typeof parseAuditConfig>;
type Sdk = Config["sourceRegistryPackage"];
type SdkInputIdentity = CandidateUpgradeIdentity & { mergeSha?: string };

function sdkIdentity(value: unknown): Sdk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Candidate SDK identity must be an object");
  }
  const record = value as Record<string, unknown>;
  const version =
    typeof record.packageSpec === "string"
      ? /^@nvidia\/openshell-sdk@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u.exec(
          record.packageSpec,
        )?.[1]
      : undefined;
  if (
    !version ||
    record.artifactName !== `nvidia-openshell-sdk-${version}.tgz` ||
    typeof record.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(record.integrity) ||
    `sha512-${Buffer.from(record.integrity.slice(7), "base64").toString("base64")}` !==
      record.integrity ||
    typeof record.tarballUrl !== "string" ||
    !record.tarballUrl.startsWith(`https://npm.pkg.github.com/download/${SDK}/${version}/`) ||
    !/^[a-f0-9]{40}$/u.test(record.tarballUrl.split("/").at(-1) ?? "") ||
    record.tarballUrl !==
      `https://npm.pkg.github.com/download/${SDK}/${version}/${record.tarballUrl.split("/").at(-1)}`
  ) {
    throw new Error("Candidate SDK requires an immutable official archive identity");
  }
  return {
    artifactName: record.artifactName as string,
    packageSpec: record.packageSpec as string,
    integrity: record.integrity,
    tarballUrl: record.tarballUrl,
    label: `OpenShell TypeScript SDK ${version}`,
  };
}

function manifestPin(source: string): string | undefined {
  const manifest = JSON.parse(source);
  const dependency = manifest.dependencies?.[SDK];
  const optional = manifest.optionalDependencies?.[SDK];
  if (dependency !== undefined && optional !== undefined && dependency !== optional) {
    throw new Error("Candidate SDK dependency declarations disagree");
  }
  const pin: unknown = optional ?? dependency;
  if (
    pin !== undefined &&
    (typeof pin !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(pin))
  ) {
    throw new Error("Candidate SDK manifests must use exact version pins");
  }
  return pin as string | undefined;
}

function selectPolicy(sources: Readonly<Record<string, string>>, trusted: Config): Config {
  const candidate = JSON.parse(sources[CONFIG]!);
  const identities = [candidate.sourceRegistryPackage, candidate.sourceRegistryPackageReplacement]
    .filter((value) => value !== undefined)
    .map(sdkIdentity);
  const pins = MANIFESTS.map((path) => manifestPin(sources[path]!));
  const versions = new Set(pins.filter((pin) => pin !== undefined));
  if (versions.size !== 1) throw new Error("Candidate SDK manifests must select one identity");
  const version = [...versions][0];
  const selected = identities.filter((value) => value.packageSpec === `${SDK}@${version}`);
  if (selected.length !== 1) throw new Error("Candidate SDK identity is missing or ambiguous");
  const reviewed = selected[0]!;
  for (const prior of [trusted.sourceRegistryPackage, trusted.sourceRegistryPackageReplacement]) {
    if (
      prior?.packageSpec === reviewed.packageSpec &&
      !isDeepStrictEqual(sdkIdentity(prior), reviewed)
    ) {
      throw new Error("Candidate SDK cannot replace an existing trusted artifact identity");
    }
  }
  // Candidate data selects the SDK only. npm, registry, audit and exception policy stay trusted.
  const { sourceRegistryPackageReplacement: _replacement, ...policy } = trusted;
  const config = { ...policy, sourceRegistryPackage: reviewed };
  const temporary = mkdtempSync(join(tmpdir(), "nemoclaw-approved-sdk-locks-"));
  try {
    mkdirSync(join(temporary, "nemoclaw"));
    for (const [index, path] of LOCKS.entries()) {
      const lock = JSON.parse(sources[path]!);
      const lockedPin = manifestPin(JSON.stringify(lock.packages?.[""] ?? {}));
      if (lockedPin !== pins[index]) throw new Error("Candidate SDK manifest and lock disagree");
      if (pins[index] !== undefined) {
        const entry = lock.packages?.[`node_modules/${SDK}`];
        if (
          entry?.version !== version ||
          entry?.resolved !== reviewed.tarballUrl ||
          entry?.integrity !== reviewed.integrity
        ) {
          throw new Error("Candidate SDK lock must resolve the declared top-level identity");
        }
        reviewedNpmDependencyLocations(lock.packages, SDK);
      }
      const lockfilePath = join(temporary, path);
      writeFileSync(lockfilePath, sources[path]!, { flag: "wx", mode: 0o600 });
      const packages = verifyReviewedNpmLockPackages({
        lockfilePath,
        allowedNestedShrinkwrapPackages: trusted.sourceNestedShrinkwrapPackages,
        registryOrigin: trusted.registryOrigin,
        reviewedPackagesWithoutIntegrity: trusted.sourceRegistryPackagesWithoutIntegrity,
        reviewedRegistryPackages: [{ ...reviewed, expectedIntegrity: reviewed.integrity }],
      });
      if ((pins[index] !== undefined) !== packages.includes(reviewed.packageSpec)) {
        throw new Error("Candidate SDK lock does not contain its declared dependency");
      }
    }
    return config;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Acquire candidate SDK inputs under live admission, then apply the trusted package policy. */
export async function readApprovedOpenShellSdkConfig(
  identity: SdkInputIdentity,
  request: UpgradeRequest,
  trustedConfigSource: string,
) {
  const trusted = parseAuditConfig(trustedConfigSource);
  const admission = await readApprovedCandidateUpgrade(
    identity,
    [CONFIG, ...MANIFESTS, ...LOCKS],
    request,
  );
  const policy = selectPolicy(admission.sources, trusted);
  let sources = admission.sources;
  if (identity.mergeSha !== undefined) {
    const merged = await readApprovedCandidateUpgrade(
      identity,
      [...MANIFESTS, ...LOCKS],
      request,
      identity.mergeSha,
    );
    if (merged.commentId !== admission.commentId || merged.reviewer !== admission.reviewer)
      throw new Error("Candidate SDK admission changed during merge verification");
    sources = { ...sources, ...merged.sources };
    // The merge can update other dependencies, but cannot select a different SDK or audit policy.
    if (!isDeepStrictEqual(selectPolicy(sources, trusted), policy))
      throw new Error("Candidate SDK identity changed in the merge commit");
  }
  return {
    configSource: JSON.stringify(policy),
    sources,
    reviewer: admission.reviewer,
    commentId: admission.commentId,
  };
}

function verifyCheckoutSources(targetRoot: string, sources: Readonly<Record<string, string>>) {
  for (const path of [...MANIFESTS, ...LOCKS]) {
    const file = resolvePathWithinRoot(targetRoot, path, "Candidate SDK input");
    const descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        throw new Error("Candidate SDK input must be a bounded regular file");
      }
      if (readFileSync(descriptor, "utf8") !== sources[path]) {
        throw new Error(`Candidate SDK checkout differs from admitted commit: ${path}`);
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

function artifactDecision(
  identity: CandidateUpgradeIdentity,
  admitted: Awaited<ReturnType<typeof readApprovedOpenShellSdkConfig>>,
) {
  return {
    required: true,
    candidate: true,
    artifactName: parseAuditConfig(admitted.configSource).sourceRegistryPackage.artifactName,
    bundleName: `candidate-openshell-sdk-${identity.prNumber}-${identity.candidateSha}-${identity.baseSha}-${admitted.commentId}`,
  } as const;
}

export async function inspectApprovedCandidateOpenShellSdk(
  targetRoot: string,
  identity: SdkInputIdentity,
  request: UpgradeRequest,
  trustedSource: string,
) {
  const admitted = await readApprovedOpenShellSdkConfig(identity, request, trustedSource);
  verifyCheckoutSources(targetRoot, admitted.sources);
  return artifactDecision(identity, admitted);
}

/** The producer needs no new archive when the locks use an existing trusted SDK version. */
export async function readCandidateSdkPackageDecision(
  identity: CandidateUpgradeIdentity,
  request: UpgradeRequest,
  trustedSource: string,
) {
  const locks = await Promise.all(
    LOCKS.map((path) => readCandidateUpgradeSource(request, identity.candidateSha, path)),
  );
  if (!requiresCandidateSdkAdmission(locks, trustedSource)) return { required: false } as const;
  return artifactDecision(
    identity,
    await readApprovedOpenShellSdkConfig(identity, request, trustedSource),
  );
}

/** Verify admitted sources and archive bytes before releasing them to the npm cache. */
export async function prepareApprovedCandidateOpenShellSdk(
  preparation: Parameters<typeof prepareCiNpmInstallWithReviewedConfig>[0],
  input: SdkInputIdentity,
  request: UpgradeRequest,
  trustedConfigSource: string,
  stage: NpmCacheStager = stageReviewedArchiveWithNpm,
): Promise<void> {
  if (preparation.mode !== "artifact")
    throw new Error("Candidate SDK installation requires artifact mode");
  const identity = Object.freeze({ ...input });
  const before = await readApprovedOpenShellSdkConfig(identity, request, trustedConfigSource);
  verifyCheckoutSources(preparation.targetRoot, before.sources);
  const verified: Parameters<NpmCacheStager>[0][] = [];
  await prepareCiNpmInstallWithReviewedConfig(preparation, before.configSource, (archive) => {
    verified.push(archive);
  });
  const after = await readApprovedOpenShellSdkConfig(identity, request, trustedConfigSource);
  if (!isDeepStrictEqual(before, after))
    throw new Error("Candidate SDK admission changed during verification");
  verifyCheckoutSources(preparation.targetRoot, after.sources);
  // Staging receives only the bytes already checked, not a path that could be replaced.
  for (const archive of verified) stage(archive);
}
