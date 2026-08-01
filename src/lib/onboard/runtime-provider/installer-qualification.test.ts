// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { defineRuntimeProviderActivationDeclaration } from "./activation";
import {
  normalizeRuntimeProviderInstallerQualificationReceipt,
  RUNTIME_PROVIDER_INSTALLER_QUALIFICATION_SCHEMA_VERSION,
  type RuntimeProviderInstallerQualificationReceipt,
  runtimeProviderInstallerQualificationTargets,
} from "./installer-qualification";

const SHA = "a".repeat(40);
const SHA256 = "b".repeat(64);

function receipt(
  providerId: string,
  overrides: Partial<RuntimeProviderInstallerQualificationReceipt> = {},
): RuntimeProviderInstallerQualificationReceipt {
  return {
    schemaVersion: RUNTIME_PROVIDER_INSTALLER_QUALIFICATION_SCHEMA_VERSION,
    activationContractVersion: 1,
    providerId,
    platform: "linux/amd64",
    rootMode: "rootless",
    dockerAvailability: "unavailable",
    sourceRevision: SHA,
    installer: {
      kind: "release-installer",
      exitCode: 0,
      script: { path: "qualification/install.sh", sha256: SHA256 },
      invocation: { path: "qualification/invocation.json", sha256: SHA256 },
    },
    runtime: {
      authorityId: `${providerId}-endpoint:${SHA256}`,
      engineName: providerId,
      engineVersion: "5.6.2",
    },
    ...overrides,
  };
}

describe("runtime provider installer qualification", () => {
  it("derives the complete multiarch Docker-unavailable target set from activation", () => {
    const declaration = defineRuntimeProviderActivationDeclaration("podman");

    expect(runtimeProviderInstallerQualificationTargets(declaration)).toEqual([
      {
        providerId: "podman",
        platform: "linux/amd64",
        rootMode: "rootless",
        dockerAvailability: "unavailable",
      },
      {
        providerId: "podman",
        platform: "linux/arm64",
        rootMode: "rootless",
        dockerAvailability: "unavailable",
      },
    ]);
  });

  it.each([
    "podman",
    "test-mxc-native",
  ])("normalizes a secret-free %s release-installer receipt through the same contract", (providerId) => {
    const declaration = defineRuntimeProviderActivationDeclaration(providerId);
    const normalized = normalizeRuntimeProviderInstallerQualificationReceipt(
      declaration,
      receipt(providerId, { platform: "linux/arm64" }),
    );

    expect(normalized).toMatchObject({
      providerId,
      platform: "linux/arm64",
      rootMode: "rootless",
      dockerAvailability: "unavailable",
      installer: { kind: "release-installer", exitCode: 0 },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.installer)).toBe(true);
    expect(Object.isFrozen(normalized.runtime)).toBe(true);
  });

  it.each([
    ["provider", { providerId: "other" }, "does not match activation"],
    ["platform", { platform: "linux/s390x" }, "outside the activation declaration"],
    ["root mode", { rootMode: "rootful" }, "outside the activation declaration"],
    ["Docker availability", { dockerAvailability: "available" }, "Docker must be unavailable"],
    ["source revision", { sourceRevision: "main" }, "exact lowercase Git SHA"],
  ])("rejects invalid %s evidence", (_label, overrides, message) => {
    const declaration = defineRuntimeProviderActivationDeclaration("podman");
    expect(() =>
      normalizeRuntimeProviderInstallerQualificationReceipt(
        declaration,
        receipt("podman", overrides as Partial<RuntimeProviderInstallerQualificationReceipt>),
      ),
    ).toThrow(message);
  });

  it("rejects unsuccessful installation and inexact artifacts", () => {
    const declaration = defineRuntimeProviderActivationDeclaration("podman");
    const unsuccessful = {
      ...receipt("podman"),
      installer: { ...receipt("podman").installer, exitCode: 1 },
    } as unknown as RuntimeProviderInstallerQualificationReceipt;
    expect(() =>
      normalizeRuntimeProviderInstallerQualificationReceipt(declaration, unsuccessful),
    ).toThrow("must complete successfully");

    const unsafeArtifact = receipt("podman", {
      installer: {
        ...receipt("podman").installer,
        script: { path: "../install.sh", sha256: "latest" },
      },
    });
    expect(() =>
      normalizeRuntimeProviderInstallerQualificationReceipt(declaration, unsafeArtifact),
    ).toThrow("repository-relative and traversal-free");
  });

  it("returns only the bounded receipt schema", () => {
    const declaration = defineRuntimeProviderActivationDeclaration("podman");
    const untrusted = {
      ...receipt("podman"),
      secret: "must-not-survive",
      runtime: { ...receipt("podman").runtime, token: "must-not-survive" },
    } as RuntimeProviderInstallerQualificationReceipt & { secret: string };

    const normalized = normalizeRuntimeProviderInstallerQualificationReceipt(
      declaration,
      untrusted,
    );
    expect(normalized).not.toHaveProperty("secret");
    expect(normalized.runtime).not.toHaveProperty("token");
  });
});
