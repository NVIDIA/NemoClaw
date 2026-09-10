// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import type { SandboxEntry } from "../../state/registry/types";
import { fingerprintOpenShellSandboxId } from "../openshell/sandbox-identity";

const sandboxId = "123e4567-e89b-42d3-a456-426614174000";
const identityFingerprint = fingerprintOpenShellSandboxId(sandboxId) as string;
export const endpoint = "https://integrate.api.nvidia.com/v1";
export const readFailureCanary = "credential-canary-value";
export const imageRef = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64);
export const startupInput = {
  agent: "openclaw",
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia-prod",
    model: "model-a",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-completions",
    primaryModelRef: "inference/model-a",
    compatibility: {},
  },
  dashboard: {
    agent: "openclaw",
    mode: "loopback",
    url: "http://127.0.0.1:18789",
    port: 18_789,
    bindAddress: "127.0.0.1",
    wslExposure: false,
  },
  webSearch: null,
  toolDisclosure: "progressive",
  hermesToolGateways: [],
  messagingPlan: null,
  dcodeAutoApprovalMode: null,
  observabilityEnabled: null,
  environment: {},
  corporateCa: null,
} satisfies ManagedStartupProfileBuilderInput;
export const startup = buildManagedStartupProfile(startupInput);

export const entry = {
  name: "alpha",
  createdAt: "not-export-evidence",
  agent: "openclaw",
  openshellDriver: "docker",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: identityFingerprint,
  provider: "nvidia-prod",
  model: "model-a",
  preferredInferenceApi: "openai-completions",
  endpointUrl: endpoint,
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  imageTag: imageRef,
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: imageRef,
    platform: "linux/amd64",
    release: "v1.0.0",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-1-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: startup.encodedProfile,
    startupProfileSha256: startup.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  },
} satisfies SandboxEntry;

export function inventory(resourceVersion = 7, policyVersion = 3) {
  return {
    sandbox: {
      metadata: {
        id: sandboxId,
        name: "alpha",
        workspace: "default",
        resourceVersion: BigInt(resourceVersion),
      },
      status: { phase: 2, currentPolicyVersion: policyVersion },
      spec: { template: { image: imageRef }, providers: [] },
    },
  };
}
export function provider() {
  return {
    provider: {
      metadata: {
        id: "provider-id",
        name: "nvidia-prod",
        workspace: "default",
        resourceVersion: 8n,
      },
      type: "openai",
      credentials: { NVIDIA_INFERENCE_API_KEY: readFailureCanary },
      config: { OPENAI_BASE_URL: endpoint },
    },
  };
}
export function configuration(revision = 3) {
  return {
    policy: {
      version: 1,
      process: { run_as_user: "sandbox", run_as_group: "sandbox" },
      filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/sandbox"] },
      network_policies: {
        api: {
          name: "api",
          endpoints: [{ host: "api.example.com", port: 443 }],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    },
    workspace: "default",
    version: revision,
    policyHash: "a".repeat(64),
    configRevision: 11n,
    providerEnvRevision: 12n,
    policySource: 1,
    globalPolicyVersion: 0,
  };
}
