// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxEntry } from "../state/registry/types";
import { MANAGED_IMAGE_REPOSITORIES } from "./managed-image/contract";
import {
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./runtime-provider/current";
import { prepareManagedWorkloadCloneHandoff } from "./workload/clone";

const ORIGINS = ["https://launchpad.example.test:8443"];

function openClawSource(
  profile: ManagedStartupProfile,
  recordedOrigins: readonly string[] | undefined,
): SandboxEntry {
  const encodedProfile = encodeManagedStartupProfile(profile);
  const workload = {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.99",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123456-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  } as const;
  return {
    name: "source",
    agent: "openclaw",
    openshellDriver: "docker",
    imageTag: workload.reference,
    workload,
    lifecycleGeneration: "generation-source-current",
    lifecycleLiveIdentityFingerprint: "f".repeat(64),
    provider: profile.inference!.upstreamProvider,
    model: profile.inference!.model,
    endpointUrl: profile.inference!.upstreamEndpointUrl,
    endpointSource: null,
    credentialEnv: "NVIDIA_API_KEY",
    preferredInferenceApi: profile.inference!.api,
    toolDisclosure: profile.tools.disclosure,
    dashboardPort: 18_789,
    dashboardRemoteBindPrepared: false,
    ...(recordedOrigins ? { dashboardOrigins: [...recordedOrigins] } : {}),
  } as SandboxEntry;
}

function cloneOf(profile: ManagedStartupProfile, recordedOrigins?: readonly string[]) {
  const entry = openClawSource(profile, recordedOrigins);
  return prepareManagedWorkloadCloneHandoff({
    source: entry,
    snapshot: {
      sandboxName: entry.name,
      agentType: "openclaw",
      workload: entry.workload,
      runtimeSnapshot: {
        schemaVersion: 1,
        providerId: "docker",
        providerHandle: "docker:snapshot:source",
        lifecycleState: "running",
        lifecycleGeneration: "generation-source-1",
        runtime: {
          schemaVersion: 1,
          providerId: "docker",
          runtime: { kind: "docker-workload", handle: "docker:runtime:source" },
          acceleration: { kind: "none" },
        },
      },
      restoreAuthority: {
        schemaVersion: 1,
        backupPath: "/tmp/nemoclaw-managed-clone-source",
        contentSha256: "c".repeat(64),
      },
    },
    destinationSandboxName: "destination",
    destinationDashboardPort: 20_789,
    provider: CURRENT_RUNTIME_PROVIDER_BUNDLES.docker!,
    getHermesInferenceProviderName: vi.fn(() => "unused"),
  } as unknown as Parameters<typeof prepareManagedWorkloadCloneHandoff>[0]);
}

describe("clone dashboard origins (#13177)", () => {
  it("records the source profile's origins on the clone's registry entry", () => {
    const base = managedStartupE2eProfile("openclaw");
    const profile = validateManagedStartupProfile({
      ...base,
      dashboard: { ...base.dashboard, extraOrigins: ORIGINS },
    });

    const handoff = cloneOf(profile, ORIGINS);

    expect(handoff.rebound.profile.dashboard).toMatchObject({ extraOrigins: ORIGINS });
    expect(handoff.registryFields.dashboardOrigins).toEqual(ORIGINS);
  });

  it("follows the source's current record when re-onboarding removed the origins", () => {
    const base = managedStartupE2eProfile("openclaw");
    const profile = validateManagedStartupProfile({
      ...base,
      dashboard: { ...base.dashboard, extraOrigins: ORIGINS },
    });

    const handoff = cloneOf(profile, undefined);

    expect(handoff.rebound.profile.dashboard).not.toHaveProperty("extraOrigins");
    expect(handoff.registryFields).not.toHaveProperty("dashboardOrigins");
  });

  it("records no origins for a clone whose profile has none", () => {
    const handoff = cloneOf(validateManagedStartupProfile(managedStartupE2eProfile("openclaw")));

    expect(handoff.registryFields).not.toHaveProperty("dashboardOrigins");
  });
});
