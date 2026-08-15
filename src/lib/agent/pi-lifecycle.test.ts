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
  type ManagedImageContractV1,
  managedImageRuntimeIdentity,
} from "../onboard/managed-image/contract";
import {
  resolveSandboxWorkloadSource,
  type SandboxWorkloadRuntimeCapabilities,
} from "../onboard/workload/source";
import { loadAgent } from "./defs";

const CANDIDATE_ENV = { NEMOCLAW_CANDIDATE_AGENTS: "1" };
const PLATFORM = MANAGED_IMAGE_PLATFORMS[0];
const DIGEST = `sha256:${"7a".repeat(32)}` as const;

function piContract(): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES.pi;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent: "pi",
    platform: PLATFORM,
    image,
    digest: DIGEST,
    reference: `${image}@${DIGEST}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: "d".repeat(40),
      release: "v0.0.100",
      cohort: "ghrun-7927-1",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function capableRuntime(driverName: string): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: false,
    managedImages: {
      exactDigestReferences: true,
      platforms: [PLATFORM],
      startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
      capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
    },
  };
}

describe("Pi candidate lifecycle integration", () => {
  it("selects the identical Pi workload across injected compute runtimes (#7927)", () => {
    const sources = ["docker", "mxc-shaped-test", "portable-test"].map((driverName) =>
      resolveSandboxWorkloadSource({
        agentName: "pi",
        legacyDockerfilePath: "agents/pi/Dockerfile",
        runtime: capableRuntime(driverName),
        catalog: { pi: piContract() },
        candidateAgentsEnabled: true,
      }),
    );

    for (const source of sources) {
      expect(source).toEqual(sources[0]);
      expect(source).toMatchObject({ kind: "managed-image", reference: piContract().reference });
    }
  });

  it("keeps the Pi workload identity independent of the compute runtime (#7927)", () => {
    const identity = managedImageRuntimeIdentity("pi");

    expect(identity).toEqual({ uid: 999, gid: 999, workdir: "/sandbox" });
    expect(MANAGED_IMAGE_REPOSITORIES.pi).toBe("ghcr.io/nvidia/nemoclaw/pi-sandbox");
  });

  it("backs up only the state the Pi manifest declares persistent (#7927)", () => {
    const agent = loadAgent("pi", CANDIDATE_ENV);

    expect(agent.backupStateDirs).toEqual(["sessions", "prompts", "themes"]);
    expect(agent.nonBackupStateDirs).toEqual(["tools", "bin"]);
    expect(agent.stateFiles.map(({ path: statePath }) => statePath)).toEqual(["settings.json"]);
  });

  it("restores Pi user preferences only through the allowlisted key contract (#7927)", () => {
    const agent = loadAgent("pi", CANDIDATE_ENV);
    const settings = agent.stateFiles.find(({ path: statePath }) => statePath === "settings.json");

    expect(settings?.restore?.merge).toBe("key-allowlist");
    const userKeys =
      settings?.restore?.merge === "key-allowlist" ? settings.restore.userKeys : undefined;
    expect(userKeys?.map(({ key }) => key)).toContain("theme");
    expect(userKeys?.map(({ key }) => key)).not.toContain("models");
  });

  it("resolves Pi as a terminal runtime without a dashboard or MCP surface (#7927)", () => {
    const agent = loadAgent("pi", CANDIDATE_ENV);

    expect(agent.runtime?.kind).toBe("terminal");
    expect(agent.forwardPort).toBe(0);
    expect(agent.healthProbe).toBeNull();
    expect(agent.hasDevicePairing).toBe(false);
    expect(agent.mcpCapability.support).toBe("disabled");
  });
});
