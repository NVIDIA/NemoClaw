// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fingerprintOpenShellSandboxId } from "../sandbox/openshell-identity";
import {
  buildManagedStartupProfile,
  type ManagedStartupProfileBuilderInput,
} from "../../onboard/managed-startup/profile-builder";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type { CanonicalExportPolicy, ObservedExportSnapshot } from "./export-evidence";

export const sandboxId = "018f47e2-9d93-7d15-9c41-3ecf70b2550f";
export const fingerprint = fingerprintOpenShellSandboxId(sandboxId)!;
export const endpoint = "https://api.openai.com/v1";
export const imageRef = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64);
export const hermesImageRef = "ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:" + "c".repeat(64);
export const policy =
  "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
export const canonicalPolicy = {
  filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/sandbox"] },
  network_policies: {
    api: {
      binaries: [{ path: "/usr/bin/curl" }],
      endpoints: [{ host: "api.example.com", port: 443 }],
      name: "api",
    },
  },
  process: { run_as_group: "sandbox", run_as_user: "sandbox" },
  version: 1,
} as unknown as CanonicalExportPolicy;
export function profileInput(
  overrides: Partial<ManagedStartupProfileBuilderInput> = {},
): ManagedStartupProfileBuilderInput {
  return {
    agent: "openclaw",
    inference: {
      routeProvider: "openai",
      upstreamProvider: "openai-api",
      model: "gpt-5",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "openai/gpt-5",
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
    ...overrides,
  };
}

export function hermesProfileInput(): ManagedStartupProfileBuilderInput {
  return {
    ...profileInput(),
    agent: "hermes",
    inference: {
      ...profileInput().inference,
      primaryModelRef: null,
      compatibility: null,
    },
    dashboard: {
      agent: "hermes",
      mode: "disabled",
      url: "http://127.0.0.1:18789",
      browserUrl: "http://127.0.0.1:18789",
      publicPort: null,
      internalPort: null,
      tuiEnabled: false,
    },
  };
}

export function managedWorkload(
  input = profileInput(),
  reference = imageRef,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const built = buildManagedStartupProfile(input);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference,
    platform: "linux/amd64",
    release: "v1.0.0",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-1-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: built.encodedProfile,
    startupProfileSha256: built.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

export function entry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: fingerprint,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    provider: "openai-api",
    model: "gpt-5",
    preferredInferenceApi: "openai-responses",
    endpointUrl: endpoint,
    credentialEnv: "OPENAI_API_KEY",
    imageTag: imageRef,
    workload: managedWorkload(),
    ...overrides,
  };
}

export function snapshot(overrides: Partial<ObservedExportSnapshot> = {}): ObservedExportSnapshot {
  return {
    kind: "observed",
    sandboxName: "alpha",
    registry: entry(),
    sandbox: {
      sandboxId,
      fingerprint,
      resourceVersion: "7",
      workspace: "default",
      imageRef,
      providerNames: [],
      policyVersion: 3,
    },
    gateway: {
      name: "nemoclaw",
      port: 8080,
      management: "nemoclaw",
      stateRootOwned: true,
    },
    inference: {
      topology: "hosted",
      provider: "openai-api",
      model: "gpt-5",
      api: "openai-responses",
      endpoint,
      endpointEvidence: {
        endpoint,
        provider: {
          gatewayName: "nemoclaw",
          workspace: "default",
          name: "openai-api",
          id: "provider-id",
          resourceVersion: "8",
        },
        source: { kind: "provider-config", key: "OPENAI_BASE_URL" },
      },
      credentialEnv: "OPENAI_API_KEY",
    },
    policy: {
      sandboxId,
      revision: "3",
      document: policy,
    },
    configuration: {
      sandboxId,
      workspace: "default",
      revision: 3,
      policyHash: "a".repeat(64),
      configRevision: "1",
      providerEnvRevision: "2",
      policySource: "sandbox",
      globalPolicyVersion: 0,
    },
    ...overrides,
  };
}

export const tunedEnvironment = {
  NEMOCLAW_CONTEXT_WINDOW: "65536",
  NEMOCLAW_MAX_TOKENS: "8192",
  NEMOCLAW_REASONING: "true",
  NEMOCLAW_REASONING_EFFORT: "high",
  NEMOCLAW_AGENT_TIMEOUT: "900",
  NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m",
};

export function hermesSnapshot(
  registryOverrides: Partial<SandboxEntry> = {},
): ObservedExportSnapshot {
  const workload = managedWorkload(hermesProfileInput(), hermesImageRef);
  return snapshot({
    registry: entry({
      agent: "hermes",
      imageTag: hermesImageRef,
      workload,
      hermesApiPort: 8642,
      ...registryOverrides,
    }),
    sandbox: { ...snapshot().sandbox, imageRef: hermesImageRef },
  });
}

const nousEndpoint = "https://inference-api.nousresearch.com/v1";

export function hermesManagedAuthSnapshot(
  registryOverrides: Partial<SandboxEntry> = {},
): ObservedExportSnapshot {
  const model = "moonshotai/kimi-k2.6";
  const api =
    registryOverrides.preferredInferenceApi === "anthropic-messages"
      ? "anthropic-messages"
      : "openai-completions";
  const endpointUrl = registryOverrides.endpointUrl ?? nousEndpoint;
  const workload = managedWorkload(
    {
      ...hermesProfileInput(),
      inference: {
        routeProvider: "inference",
        upstreamProvider: "hermes-provider",
        model,
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api,
        primaryModelRef: null,
        compatibility: null,
      },
    },
    hermesImageRef,
  );
  return {
    ...hermesSnapshot({
      provider: "hermes-provider",
      model,
      preferredInferenceApi: api,
      endpointUrl,
      credentialEnv: "NOUS_API_KEY",
      hermesAuthMethod: "api_key",
      workload,
      ...registryOverrides,
    }),
    inference: {
      topology: "hosted",
      provider: "hermes-provider",
      model,
      api,
      endpoint: endpointUrl,
      endpointEvidence: {
        endpoint: endpointUrl,
        provider: {
          gatewayName: "nemoclaw",
          workspace: "default",
          name: "hermes-provider",
          id: "hermes-provider-id",
          resourceVersion: "9",
        },
        source: {
          kind: "provider-config",
          key: api === "anthropic-messages" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL",
        },
      },
      credentialEnv: "NOUS_API_KEY",
    },
  };
}
