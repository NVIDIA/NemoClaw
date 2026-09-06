// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "./managed-image/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./runtime-provider/current";
import { createRuntimeProviderBundleRegistry } from "./runtime-provider/registry";
import { resolveSandboxWorkloadRuntimeCapabilities } from "./workload/runtime";
import type { PortableAgentRuntimeProviderSupport } from "./workload/portable-agent-runtime";
import { createInMemoryRuntimeProviderBundle } from "../../../test/helpers/runtime-provider-bundle";

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
const PORTABLE_AGENT_RUNTIME_V1_SUPPORT = {
  exactDigestReferences: true,
  agents: ["hermes"],
  platforms: MANAGED_IMAGE_PLATFORMS,
  contractVersions: [1],
  capabilityContractVersions: [1],
  tokenizedStartupCommands: true,
  openshellSandboxCommand: true,
  openshellNonRootIdentity: true,
  openshellWorkspaceOwnership: true,
  ownerOnlyPrivateState: true,
} as const satisfies PortableAgentRuntimeProviderSupport;

describe("sandbox workload runtime capabilities", () => {
  it("registers managed-image v1 capabilities for the Docker compute driver (#7744)", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, "x64"),
    ).toEqual({
      driverName: "docker",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: true,
      managedImages: AMD64_MANAGED_IMAGE_V1_SUPPORT,
      portableAgentRuntime: null,
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
      portableAgentRuntime: null,
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
      portableAgentRuntime: null,
    });
  });

  it("preserves the registered Kubernetes legacy-build behavior (#7744)", () => {
    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName: "kubernetes" })).toEqual({
      driverName: "kubernetes",
      managedImageSelectionPolicy: "prefer-managed",
      legacyDockerfileBuilds: true,
      managedImages: null,
      portableAgentRuntime: null,
    });
  });

  it("fails unknown drivers closed instead of inferring Dockerfile support (#7744)", () => {
    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName: "future-runtime" })).toEqual({
      driverName: "future-runtime",
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: null,
      portableAgentRuntime: null,
    });
  });

  it.each(["__proto__", "constructor", "toString"])(
    "fails inherited-object driver name %s closed (#7744)",
    (driverName) => {
      expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName })).toEqual({
        driverName,
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
        managedImages: null,
        portableAgentRuntime: null,
      });
    },
  );

  it("projects a complete portable bundle into workload capabilities (#11079)", () => {
    const driverName = "portable-test";
    const providers = createRuntimeProviderBundleRegistry([
      ...Object.entries(CURRENT_RUNTIME_PROVIDER_BUNDLES),
      [
        driverName,
        createInMemoryRuntimeProviderBundle({
          providerId: driverName,
          workloadProfile: {
            support: COMPLETE_MANAGED_IMAGE_V1_SUPPORT,
            portableAgentRuntimeSupport: PORTABLE_AGENT_RUNTIME_V1_SUPPORT,
            hostArchitectures: ["amd64"],
            managedImageSelectionPolicy: "require-managed",
            legacyDockerfileBuilds: false,
          },
        }),
      ],
    ]);

    expect(resolveSandboxWorkloadRuntimeCapabilities({ driverName }, providers, "x64")).toEqual({
      driverName,
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
      managedImages: AMD64_MANAGED_IMAGE_V1_SUPPORT,
      portableAgentRuntime: {
        ...PORTABLE_AGENT_RUNTIME_V1_SUPPORT,
        agents: ["hermes"],
        platforms: ["linux/amd64"],
        contractVersions: [1],
        capabilityContractVersions: [1],
      },
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
    expect(first.portableAgentRuntime).toBeNull();
  });
});
