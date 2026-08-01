// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeRuntimeProviderActivationDeclaration,
  RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION,
  type RuntimeProviderActivationDeclaration,
  type RuntimeProviderActivationPlatform,
  type RuntimeProviderActivationRootMode,
} from "./activation";

export const RUNTIME_PROVIDER_INSTALLER_QUALIFICATION_SCHEMA_VERSION = 1 as const;

export interface RuntimeProviderInstallerArtifactReceipt {
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeProviderInstallerQualificationTarget {
  readonly providerId: string;
  readonly platform: RuntimeProviderActivationPlatform;
  readonly rootMode: RuntimeProviderActivationRootMode;
  readonly dockerAvailability: "unavailable";
}

/**
 * Secret-free proof that the release installer and provider preflight ran on
 * one declared native target. Producing this receipt does not register or
 * select the provider.
 */
export interface RuntimeProviderInstallerQualificationReceipt {
  readonly schemaVersion: typeof RUNTIME_PROVIDER_INSTALLER_QUALIFICATION_SCHEMA_VERSION;
  readonly activationContractVersion: typeof RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION;
  readonly providerId: string;
  readonly platform: RuntimeProviderActivationPlatform;
  readonly rootMode: RuntimeProviderActivationRootMode;
  readonly dockerAvailability: "unavailable";
  readonly sourceRevision: string;
  readonly installer: {
    readonly kind: "release-installer";
    readonly exitCode: 0;
    readonly script: RuntimeProviderInstallerArtifactReceipt;
    readonly invocation: RuntimeProviderInstallerArtifactReceipt;
  };
  readonly runtime: {
    readonly authorityId: string;
    readonly engineName: string;
    readonly engineVersion: string;
  };
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class RuntimeProviderInstallerQualificationError extends Error {
  constructor(message: string) {
    super(`Runtime provider installer qualification is invalid: ${message}`);
    this.name = "RuntimeProviderInstallerQualificationError";
  }
}

function singleLine(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RuntimeProviderInstallerQualificationError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized !== value ||
    value.length > 512 ||
    /[\r\n\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new RuntimeProviderInstallerQualificationError(
      `${label} must be a trimmed, non-empty single-line string of at most 512 characters`,
    );
  }
  return normalized;
}

function artifact(
  input: RuntimeProviderInstallerArtifactReceipt,
  label: string,
): Readonly<RuntimeProviderInstallerArtifactReceipt> {
  const artifactPath = singleLine(input?.path, `${label} path`);
  if (
    artifactPath.startsWith("/") ||
    artifactPath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(artifactPath) ||
    artifactPath.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new RuntimeProviderInstallerQualificationError(
      `${label} path must be repository-relative and traversal-free`,
    );
  }
  if (!SHA256_PATTERN.test(input?.sha256)) {
    throw new RuntimeProviderInstallerQualificationError(
      `${label} sha256 must be an exact lowercase SHA-256 digest`,
    );
  }
  return Object.freeze({ path: artifactPath, sha256: input.sha256 });
}

export function runtimeProviderInstallerQualificationTargets(
  declaration: RuntimeProviderActivationDeclaration,
): readonly Readonly<RuntimeProviderInstallerQualificationTarget>[] {
  const activation = normalizeRuntimeProviderActivationDeclaration(declaration);
  return Object.freeze(
    activation.platforms.flatMap((platform) =>
      activation.rootModes.map((rootMode) =>
        Object.freeze({
          providerId: activation.providerId,
          platform,
          rootMode,
          dockerAvailability: "unavailable" as const,
        }),
      ),
    ),
  );
}

export function normalizeRuntimeProviderInstallerQualificationReceipt(
  declaration: RuntimeProviderActivationDeclaration,
  input: RuntimeProviderInstallerQualificationReceipt,
): Readonly<RuntimeProviderInstallerQualificationReceipt> {
  const activation = normalizeRuntimeProviderActivationDeclaration(declaration);
  if (
    input?.schemaVersion !== RUNTIME_PROVIDER_INSTALLER_QUALIFICATION_SCHEMA_VERSION ||
    input.activationContractVersion !== activation.contractVersion
  ) {
    throw new RuntimeProviderInstallerQualificationError("contract version is unsupported");
  }
  if (input.providerId !== activation.providerId) {
    throw new RuntimeProviderInstallerQualificationError(
      `provider '${input.providerId}' does not match activation '${activation.providerId}'`,
    );
  }
  if (!activation.platforms.includes(input.platform)) {
    throw new RuntimeProviderInstallerQualificationError(
      `platform '${input.platform}' is outside the activation declaration`,
    );
  }
  if (!activation.rootModes.includes(input.rootMode)) {
    throw new RuntimeProviderInstallerQualificationError(
      `root mode '${input.rootMode}' is outside the activation declaration`,
    );
  }
  if (input.dockerAvailability !== "unavailable") {
    throw new RuntimeProviderInstallerQualificationError("Docker must be unavailable");
  }
  if (!SHA_PATTERN.test(input.sourceRevision)) {
    throw new RuntimeProviderInstallerQualificationError(
      "source revision must be an exact lowercase Git SHA",
    );
  }
  if (input.installer?.kind !== "release-installer" || input.installer.exitCode !== 0) {
    throw new RuntimeProviderInstallerQualificationError(
      "the release installer must complete successfully",
    );
  }
  const script = artifact(input.installer.script, "installer script");
  const invocation = artifact(input.installer.invocation, "installer invocation");
  const runtime = Object.freeze({
    authorityId: singleLine(input.runtime?.authorityId, "runtime authority id"),
    engineName: singleLine(input.runtime?.engineName, "runtime engine name"),
    engineVersion: singleLine(input.runtime?.engineVersion, "runtime engine version"),
  });

  return Object.freeze({
    schemaVersion: RUNTIME_PROVIDER_INSTALLER_QUALIFICATION_SCHEMA_VERSION,
    activationContractVersion: activation.contractVersion,
    providerId: activation.providerId,
    platform: input.platform,
    rootMode: input.rootMode,
    dockerAvailability: "unavailable",
    sourceRevision: input.sourceRevision,
    installer: Object.freeze({
      kind: "release-installer",
      exitCode: 0,
      script,
      invocation,
    }),
    runtime,
  });
}
