// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  validateInstallerSources,
  validateOpenShellFeatureGateSource,
} from "../../scripts/checks/extract-installer-pins.mts";
import { isDeepStrictEqual } from "node:util";
import { parseAuditConfig } from "../../scripts/audit-reviewed-npm-graph.mts";
import { reviewedNpmDependencyLocations } from "../../scripts/lib/reviewed-npm-archive.mts";

export type ProtectedOpenShellCandidateSources = Parameters<typeof validateInstallerSources>[0] & {
  featureGateSource: string;
};

function replaceOne(source: string, pattern: RegExp, replacement: string, label: string): string {
  if ([...source.matchAll(pattern)].length !== 1) {
    throw new Error(`Protected OpenShell projection requires one ${label}`);
  }
  return source.replace(pattern, replacement);
}

/**
 * Keep the test controller's code except for independently template-verified
 * OpenShell modules. Blueprint and fallback changes contain release data only.
 * The caller must bind both source sets to its authenticated dispatch commits.
 */
export function projectProtectedOpenShellSources(
  candidate: ProtectedOpenShellCandidateSources,
  trusted: { blueprintSource: string; versionSource: string },
): { releaseVersion: string; files: Record<string, string> } {
  const { releaseVersion } = validateInstallerSources(candidate);
  validateOpenShellFeatureGateSource(candidate.featureGateSource, releaseVersion);
  const qualified = [
    ...candidate.supervisorRuntimeSource.matchAll(
      /^const QUALIFIED_STABLE_OPENSHELL_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";$/gm,
    ),
  ];
  if (qualified.length !== 1 || qualified[0]![1] !== releaseVersion) {
    throw new Error("Protected OpenShell supervisor must select the candidate release");
  }
  let blueprintSource = trusted.blueprintSource;
  for (const bound of ["min", "max"] as const) {
    blueprintSource = replaceOne(
      blueprintSource,
      new RegExp(`^${bound}_openshell_version: "[0-9]+\\.[0-9]+\\.[0-9]+"$`, "gm"),
      `${bound}_openshell_version: "${releaseVersion}"`,
      `${bound} blueprint version`,
    );
  }
  const versionSource = replaceOne(
    trusted.versionSource,
    /^export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "[0-9]+\.[0-9]+\.[0-9]+";$/gm,
    `export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "${releaseVersion}";`,
    "fallback version",
  );
  return {
    releaseVersion,
    files: {
      "scripts/install-openshell.sh": candidate.installerSource,
      "src/lib/onboard/docker-driver-gateway-runtime.ts": candidate.supervisorRuntimeSource,
      "src/lib/onboard/openshell-feature-gate.ts": candidate.featureGateSource,
      "src/lib/onboard/openshell-version.ts": versionSource,
      "nemoclaw-blueprint/blueprint.yaml": blueprintSource,
    },
  };
}

const SDK_NAME = "@nvidia/openshell-sdk";
const SDK_LOCATION = `node_modules/${SDK_NAME}`;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Protected SDK manifests must contain JSON objects");
  }
  return value as JsonObject;
}

function sdkManifest(source: string) {
  const manifest = object(JSON.parse(source));
  const dependencies = object(manifest.optionalDependencies);
  const version = dependencies[SDK_NAME];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Protected SDK must use an exact optional dependency version");
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (manifest[field] !== undefined && Object.hasOwn(object(manifest[field]), SDK_NAME)) {
      throw new Error("Protected SDK has ambiguous dependency declarations");
    }
  }
  return { manifest, dependencies, version };
}

function sdkLock(source: string, version: string) {
  const lock = object(JSON.parse(source));
  if (lock.lockfileVersion !== 3) throw new Error("Protected SDK requires lockfileVersion 3");
  const packages = object(lock.packages) as Record<string, JsonObject>;
  const root = object(packages[""]);
  const sdk = object(packages[SDK_LOCATION]);
  if (object(root.optionalDependencies)[SDK_NAME] !== version || sdk.version !== version) {
    throw new Error("Protected SDK manifest and lock identities disagree");
  }
  return { lock, packages, root, sdk };
}

/** Select a reviewed SDK archive without adopting other candidate host dependencies. */
export function projectProtectedOpenShellSdk(
  candidate: { packageSource: string; lockSource: string },
  trusted: { packageSource: string; lockSource: string; auditSource: string },
  releaseVersion: string,
): { sdkVersion: string; sdkIntegrity: string; files: Record<string, string> } {
  const selected = sdkManifest(candidate.packageSource);
  if (selected.version !== releaseVersion)
    throw new Error("Protected SDK must match the selected OpenShell runtime");
  const baseline = sdkManifest(trusted.packageSource);
  const current = sdkLock(trusted.lockSource, baseline.version);
  const next = sdkLock(candidate.lockSource, selected.version);
  const config = parseAuditConfig(trusted.auditSource);
  const identities = [config.sourceRegistryPackage, config.sourceRegistryPackageReplacement].filter(
    Boolean,
  );
  for (const { sdk } of [current, next]) {
    const identity = identities.find(
      (entry) => entry?.packageSpec === `${SDK_NAME}@${String(sdk.version)}`,
    );
    if (!identity || sdk.resolved !== identity.tarballUrl || sdk.integrity !== identity.integrity) {
      throw new Error("Protected SDK archive is not trusted by the workflow commit");
    }
  }
  const metadata = ({
    version: _version,
    resolved: _resolved,
    integrity: _integrity,
    ...rest
  }: JsonObject) => rest;
  if (!isDeepStrictEqual(metadata(current.sdk), metadata(next.sdk))) {
    throw new Error("Protected SDK dependency metadata requires trusted controller review");
  }
  const currentGraph = reviewedNpmDependencyLocations(current.packages, SDK_NAME);
  const nextGraph = reviewedNpmDependencyLocations(next.packages, SDK_NAME);
  if (
    !isDeepStrictEqual([...currentGraph].sort(), [...nextGraph].sort()) ||
    [...currentGraph].some(
      (location) =>
        location !== SDK_LOCATION &&
        !isDeepStrictEqual(current.packages[location], next.packages[location]),
    )
  ) {
    throw new Error("Protected SDK transitive dependencies require trusted controller review");
  }
  baseline.dependencies[SDK_NAME] = selected.version;
  object(current.root.optionalDependencies)[SDK_NAME] = selected.version;
  current.packages[SDK_LOCATION] = {
    ...current.sdk,
    version: selected.version,
    resolved: next.sdk.resolved,
    integrity: next.sdk.integrity,
  };
  return {
    sdkVersion: selected.version,
    sdkIntegrity: String(next.sdk.integrity),
    files: {
      "package.json": `${JSON.stringify(baseline.manifest, null, 2)}\n`,
      "package-lock.json": `${JSON.stringify(current.lock, null, 2)}\n`,
    },
  };
}
