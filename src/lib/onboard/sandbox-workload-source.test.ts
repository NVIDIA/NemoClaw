// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  CANDIDATE_MANAGED_IMAGE_AGENTS,
  type ManagedImageAgent,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import {
  resolveSandboxWorkloadSource,
  type SandboxWorkloadRuntimeCapabilities,
} from "./workload/source";

const SOURCE_REVISION = "2f03907c37822ea6f1ac9d1bf5c82a4a4568585f";
const MANAGED_IMAGE_PLATFORM = MANAGED_IMAGE_PLATFORMS[0];
const SOURCE_RELEASE = "v0.0.89";
const SOURCE_COHORT = "ghrun-7744-2";
const DIGESTS = {
  openclaw: `sha256:${"4d".repeat(32)}`,
  hermes: `sha256:${"5e".repeat(32)}`,
  "langchain-deepagents-code": `sha256:${"6f".repeat(32)}`,
  pi: `sha256:${"7a".repeat(32)}`,
} as const satisfies Record<ManagedImageAgent, `sha256:${string}`>;

function contractFor(agent: ManagedImageAgent): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = DIGESTS[agent];
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: SOURCE_REVISION,
      release: SOURCE_RELEASE,
      cohort: SOURCE_COHORT,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

const CATALOG: ManagedImageContractCatalog = Object.fromEntries(
  SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => [agent, contractFor(agent)]),
);

function managedRuntime(driverName: string): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName,
    managedImageSelectionPolicy: driverName === "docker" ? "prefer-managed" : "require-managed",
    legacyDockerfileBuilds: driverName === "docker",
    managedImages: {
      exactDigestReferences: true,
      platforms: [MANAGED_IMAGE_PLATFORM],
      startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
      capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
    },
  };
}

describe("sandbox workload source resolution", () => {
  it.each(
    SHIPPED_MANAGED_IMAGE_AGENTS,
  )("selects the published managed image for stock %s on a capable runtime (#7744)", (agent) => {
    const source = resolveSandboxWorkloadSource({
      agentName: agent,
      legacyDockerfilePath: `agents/${agent}/Dockerfile`,
      runtime: managedRuntime("podman"),
      catalog: CATALOG,
    });

    expect(source).toEqual({
      kind: "managed-image",
      reference: contractFor(agent).reference,
      contract: contractFor(agent),
    });
  });

  it("uses the same contract with an MXC-shaped capable driver (#7744)", () => {
    const source = resolveSandboxWorkloadSource({
      agentName: "hermes",
      legacyDockerfilePath: "agents/hermes/Dockerfile",
      runtime: managedRuntime("mxc"),
      catalog: CATALOG,
    });

    expect(source).toMatchObject({
      kind: "managed-image",
      reference: contractFor("hermes").reference,
    });
  });

  it("preserves an explicit custom Dockerfile on a driver that supports local builds (#7744)", () => {
    const source = resolveSandboxWorkloadSource({
      agentName: "openclaw",
      legacyDockerfilePath: "Dockerfile",
      customDockerfilePath: "/workspace/custom/Dockerfile",
      runtime: managedRuntime("docker"),
      catalog: CATALOG,
    });

    expect(source).toEqual({
      kind: "legacy-dockerfile",
      dockerfilePath: "/workspace/custom/Dockerfile",
      reason: "custom-dockerfile",
    });
  });

  it("rejects a custom Dockerfile on a buildless driver before image selection (#7744)", () => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "openclaw",
        legacyDockerfilePath: "Dockerfile",
        customDockerfilePath: "/workspace/custom/Dockerfile",
        runtime: managedRuntime("podman"),
        catalog: CATALOG,
      }),
    ).toThrow("cannot use the legacy Dockerfile workload for custom-dockerfile");
  });

  it("preserves the legacy path when the current driver lacks managed-image capabilities (#7744)", () => {
    const source = resolveSandboxWorkloadSource({
      agentName: "langchain-deepagents-code",
      legacyDockerfilePath: "agents/langchain-deepagents-code/Dockerfile",
      runtime: {
        driverName: "kubernetes",
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: true,
        managedImages: null,
      },
      catalog: CATALOG,
    });

    expect(source).toEqual({
      kind: "legacy-dockerfile",
      dockerfilePath: "agents/langchain-deepagents-code/Dockerfile",
      reason: "runtime-unsupported",
    });
  });

  it("preserves the legacy path for an unshipped custom agent on Docker (#7744)", () => {
    const source = resolveSandboxWorkloadSource({
      agentName: "company-agent",
      legacyDockerfilePath: "/workspace/company-agent/Dockerfile",
      runtime: managedRuntime("docker"),
      catalog: CATALOG,
    });

    expect(source).toMatchObject({
      kind: "legacy-dockerfile",
      reason: "agent-not-managed",
    });
  });

  it("rejects an unshipped custom agent on a buildless driver (#7744)", () => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "company-agent",
        legacyDockerfilePath: "/workspace/company-agent/Dockerfile",
        runtime: managedRuntime("mxc"),
        catalog: CATALOG,
      }),
    ).toThrow("selected agent is not a shipped managed agent");
  });

  it("fails closed when a supplied stock-agent contract does not match (#7744)", () => {
    const mismatchedCatalog = {
      ...CATALOG,
      openclaw: contractFor("hermes"),
    };

    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "openclaw",
        legacyDockerfilePath: "Dockerfile",
        runtime: managedRuntime("podman"),
        catalog: mismatchedCatalog,
        policy: "require-managed",
      }),
    ).toThrow("failed closed validation");
  });

  it("fails closed when managed selection is required but the catalog has no exact contract (#7744)", () => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "hermes",
        legacyDockerfilePath: "agents/hermes/Dockerfile",
        runtime: managedRuntime("podman"),
        catalog: {},
        policy: "require-managed",
      }),
    ).toThrow("catalog has no exact contract");
  });

  it("fails closed when managed selection is required but the driver cannot apply profile v1 (#7744)", () => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "langchain-deepagents-code",
        legacyDockerfilePath: "agents/langchain-deepagents-code/Dockerfile",
        runtime: {
          driverName: "podman",
          managedImageSelectionPolicy: "require-managed",
          legacyDockerfileBuilds: false,
          managedImages: {
            exactDigestReferences: true,
            platforms: [MANAGED_IMAGE_PLATFORM],
            startupProfileContractVersions: [],
            capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
          },
        },
        catalog: CATALOG,
        policy: "require-managed",
      }),
    ).toThrow("does not support startup profile contract v1");
  });

  it("does not hide a malformed supplied contract behind the legacy fallback (#7744)", () => {
    const mutableCatalog = {
      ...CATALOG,
      hermes: {
        ...contractFor("hermes"),
        reference: `${MANAGED_IMAGE_REPOSITORIES.hermes}:${SOURCE_RELEASE}`,
      },
    };

    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "hermes",
        legacyDockerfilePath: "agents/hermes/Dockerfile",
        runtime: managedRuntime("podman"),
        catalog: mutableCatalog,
      }),
    ).toThrow("failed closed validation");
  });

  it.each(
    CANDIDATE_MANAGED_IMAGE_AGENTS,
  )("refuses candidate %s while candidate selection is disabled (#7927)", (agent) => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: agent,
        legacyDockerfilePath: `agents/${agent}/Dockerfile`,
        runtime: managedRuntime("docker"),
        catalog: { ...CATALOG, [agent]: contractFor(agent) },
      }),
    ).toThrow(
      `Managed image workload is required for '${agent}', but the selected agent is a release candidate and candidate selection is disabled.`,
    );
  });

  it.each(
    CANDIDATE_MANAGED_IMAGE_AGENTS,
  )("selects the exact candidate digest for %s behind the gate (#7927)", (agent) => {
    const source = resolveSandboxWorkloadSource({
      agentName: agent,
      legacyDockerfilePath: `agents/${agent}/Dockerfile`,
      runtime: managedRuntime("docker"),
      catalog: { ...CATALOG, [agent]: contractFor(agent) },
      candidateAgentsEnabled: true,
    });

    expect(source).toEqual({
      kind: "managed-image",
      reference: contractFor(agent).reference,
      contract: contractFor(agent),
    });
  });

  it("never builds a host Dockerfile for a gated candidate on a buildless runtime (#7927)", () => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "pi",
        legacyDockerfilePath: "agents/pi/Dockerfile",
        runtime: managedRuntime("podman"),
        catalog: CATALOG,
      }),
    ).toThrow("release candidate and candidate selection is disabled");
  });

  it("keeps an unknown agent distinct from a gated candidate (#7927)", () => {
    expect(() =>
      resolveSandboxWorkloadSource({
        agentName: "not-an-agent",
        legacyDockerfilePath: "agents/not-an-agent/Dockerfile",
        runtime: managedRuntime("podman"),
        catalog: CATALOG,
        candidateAgentsEnabled: true,
      }),
    ).toThrow("the selected agent is not a shipped managed agent");
  });
});
