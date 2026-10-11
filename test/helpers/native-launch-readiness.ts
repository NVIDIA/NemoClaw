// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
