// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORM,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "./managed-image/contract";
import {
  CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES,
  type ManagedImageRuntimeProfileRegistry,
  resolveSandboxWorkloadRuntimeCapabilities,
} from "./workload/runtime";

const MANAGED_IMAGE_V1_SUPPORT = {
  exactDigestReferences: true,
  platforms: [MANAGED_IMAGE_PLATFORM],
  startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
  capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
} as const;

describe("sandbox workload runtime capabilities", () => {
  it("registers managed-image v1 support for the Docker compute driver (#7744)", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, "x64"),
    ).toEqual({
      driverName: "docker",
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: true,
      managedImages: MANAGED_IMAGE_V1_SUPPORT,
    });
  });

  it("registers Podman as a buildless managed-image v1 runtime on amd64 (#7744)", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "podman" }, undefined, "x64"),
    ).toEqual({
      driverName: "podman",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: MANAGED_IMAGE_V1_SUPPORT,
    });
  });

  it.each([
    "arm64",
    "s390x",
  ])("does not select an amd64-only managed cohort on a %s host (#7744)", (architecture) => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, architecture),
    ).toEqual({
      driverName: "docker",
      managedImageSelectionPolicy: "prefer-managed",
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

  it("lets an MXC-shaped driver inject the same portable contract without Docker coupling (#7744)", () => {
    const driverName = "mxc";
    const profiles: ManagedImageRuntimeProfileRegistry = {
      ...CURRENT_MANAGED_IMAGE_RUNTIME_PROFILES,
      [driverName]: {
        support: MANAGED_IMAGE_V1_SUPPORT,
        hostArchitectures: ["amd64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
    };

    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName }, profiles, "x64")).toEqual({
      driverName,
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: MANAGED_IMAGE_V1_SUPPORT,
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
