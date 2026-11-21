// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  LaunchReadinessFence,
  LaunchReadinessIdentity,
  LaunchReadinessLease,
} from "../../src/lib/state/launch-readiness-lease";
import type { SandboxEntry } from "../../src/lib/state/registry";

export function entry(agent = "openclaw"): SandboxEntry {
  return {
    name: "alpha",
    openshellDriver: "docker",
    openshellVersion: "0.0.99",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: "b".repeat(64),
    agent,
    agentVersion: "1.0.0",
    nemoclawVersion: "2.0.0",
    imageTag: "example@sha256:immutable",
    provider: null,
    model: null,
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  };
}

export function servingProfile(): NonNullable<SandboxEntry["servingProfileProvenance"]> {
  return {
    schemaVersion: 1,
    catalogDigest: `sha256:${"d".repeat(64)}`,
    preset: {
      id: "local-gpu",
      digest: `sha256:${"e".repeat(64)}`,
      displayName: "Local GPU",
      supportState: "supported",
    },
    recipe: {
      id: "vllm-local",
      digest: `sha256:${"f".repeat(64)}`,
      backend: "vllm",
    },
    model: { id: "model-a", revision: "revision-a" },
    runtimeImage: "example.com/runtime@sha256:immutable",
    estimatedImageDownloadBytes: 1_000,
    estimatedModelDownloadBytes: 2_000,
  };
}

export const launchReadinessPolicy = `version: 1
network_policies:
  public_api:
    name: Public API
    endpoints:
      - host: example.com
        port: 443
    binaries:
      - path: /usr/bin/curl
`;

export function fence(): LaunchReadinessFence {
  return {
    schemaVersion: 3,
    kind: "fence",
    epochId: "a".repeat(64),
    sandboxName: "alpha",
    fencedWallMs: 1,
    fencedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    publicationState: "ready",
    preservedLeaseStartedWallMs: null,
    preservedLeaseExpiresWallMs: null,
    preservedLeaseElapsedMs: null,
  };
}

export function lease(identity: LaunchReadinessIdentity): LaunchReadinessLease {
  return {
    schemaVersion: 3,
    kind: "lease",
    epochId: "a".repeat(64),
    sandboxName: "alpha",
    leaseStartedWallMs: 1,
    leaseExpiresWallMs: 86_400_001,
    elapsedAtPublicationMs: 0,
    publishedWallMs: 1,
    publishedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    identity,
  };
}
