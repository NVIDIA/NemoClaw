// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "./managed-image/contract";
import {
  CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES,
  type ManagedImageRuntimeProfileRegistry,
  resolveSandboxWorkloadRuntimeCapabilities,
} from "./workload/runtime";

const AMD64_MANAGED_IMAGE_V1_SUPPORT = {
  exactDigestReferences: true,
  platforms: [MANAGED_IMAGE_PLATFORMS[0]],
  startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
  capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
} as const;
const ARM64_MANAGED_IMAGE_V1_SUPPORT = {
  ...AMD64_MANAGED_IMAGE_V1_SUPPORT,
  platforms: [MANAGED_IMAGE_PLATFORMS[1]],
} as const;
const COMPLETE_MANAGED_IMAGE_V1_SUPPORT = {
  ...AMD64_MANAGED_IMAGE_V1_SUPPORT,
  platforms: MANAGED_IMAGE_PLATFORMS,
} as const;

describe("sandbox workload runtime capabilities", () => {
  it("registers managed-image v1 capabilities for the Docker compute driver (#7744)", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, "x64"),
    ).toEqual({
      driverName: "docker",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: true,
      managedImages: AMD64_MANAGED_IMAGE_V1_SUPPORT,
    });
  });

  it("selects the complete multi-architecture managed cohort on arm64 (#7744)", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, "arm64"),
    ).toEqual({
      driverName: "docker",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: true,
      managedImages: ARM64_MANAGED_IMAGE_V1_SUPPORT,
    });
  });

  it("does not fall back to the canonical Dockerfile on an unsupported stock host (#7744)", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, "s390x"),
    ).toEqual({
      driverName: "docker",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: true,
      managedImages: null,
    });
  });

  it("preserves the registered Kubernetes legacy-build behavior (#7744)", () => {
    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName: "kubernetes" })).toEqual({
      driverName: "kubernetes",
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: true,
      managedImages: null,
    });
  });

  it("fails unknown drivers closed instead of inferring Dockerfile support (#7744)", () => {
    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName: "future-runtime" })).toEqual({
      driverName: "future-runtime",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: null,
    });
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
  ])("fails inherited-object driver name %s closed (#7744)", (driverName) => {
    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName })).toEqual({
      driverName,
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: null,
    });
  });

  it.each([
    "podman",
    "mxc",
  ])("lets the %s driver register the same portable contract without Docker coupling (#7744)", (driverName) => {
    const profiles: ManagedImageRuntimeProfileRegistry = {
      ...CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES,
      [driverName]: {
        support: COMPLETE_MANAGED_IMAGE_V1_SUPPORT,
        hostArchitectures: ["amd64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
    };

    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName }, profiles, "x64")).toEqual({
      driverName,
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: AMD64_MANAGED_IMAGE_V1_SUPPORT,
    });
  });

  it("returns a defensive copy of registered capability arrays (#7744)", () => {
    const first = resolveSandboxWorkloadRuntimeCapabilities(
      { driverName: "docker" },
      undefined,
      "x64",
    );
    const second = resolveSandboxWorkloadRuntimeCapabilities(
      { driverName: "docker" },
      undefined,
      "x64",
    );

    expect(first.managedImages).not.toBe(second.managedImages);
    expect(first.managedImages?.platforms).not.toBe(second.managedImages?.platforms);
  });
});
