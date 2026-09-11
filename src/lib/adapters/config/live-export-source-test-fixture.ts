// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { EXPORTED_OLLAMA_MODEL } from "../../config/model";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
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

export function ollamaSource(model = EXPORTED_OLLAMA_MODEL) {
  const route = resolveManagedStartupInferenceRoute(
    "openclaw",
    "ollama-local",
    model,
    "openai-completions",
  );
  const built = buildManagedStartupProfile({
    ...startupInput,
    inference: {
      routeProvider: route.providerKey,
      upstreamProvider: "ollama-local",
      model,
      routedBaseUrl: route.inferenceBaseUrl,
      upstreamEndpointUrl: null,
      api: "openai-completions",
      primaryModelRef: route.primaryModelRef,
      compatibility: route.inferenceCompat ?? {},
    },
  });
  const source: SandboxEntry = {
    ...entry,
    provider: "ollama-local",
    model,
    endpointUrl: "http://host.openshell.internal:11440/v1",
    credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
    workload: {
      ...entry.workload,
      encodedProfile: built.encodedProfile,
      startupProfileSha256: built.startupProfileSha256,
    },
  };
  const observed: ObservedOllamaProxy = {
    pid: 1234,
    listenerAddress: "0.0.0.0",
    serving: {
      backend: "ollama",
      daemon: { management: "external", hostPort: 11439 },
      proxy: { management: "nemoclaw", hostPort: 11440 },
      model: { servedName: model, digest: `sha256:${"a".repeat(64)}` },
    },
  };
  return { source, observed };
}

export function telemetryEntry(
  telemetry: Readonly<Record<string, unknown>> = {},
  agentSettings: Readonly<Record<string, unknown>> = {},
) {
  const profile = JSON.parse(Buffer.from(startup.encodedProfile, "base64url").toString("utf8")) as {
    agentConfig: { otel: Record<string, unknown> };
  };
  Object.assign(profile.agentConfig.otel, {
    enabled: true,
    serviceName: "research-assistant",
    sampleRate: 0.5,
    ...telemetry,
  });
  Object.assign(profile.agentConfig, agentSettings);
  const encodedProfile = Buffer.from(JSON.stringify(profile)).toString("base64url");
  return {
    ...entry,
    workload: {
      ...entry.workload,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
    },
  };
}

export function dashboardSource() {
  const built = buildManagedStartupProfile({
    ...startupInput,
    toolDisclosure: "direct",
    dashboard: {
      agent: "openclaw" as const,
      mode: "remote" as const,
      url: "http://127.0.0.1:19000",
      port: 19000,
      bindAddress: "0.0.0.0" as const,
      wslExposure: false,
    },
  });
  return {
    ...entry,
    toolDisclosure: "direct" as const,
    dashboardPort: 19000,
    dashboardRemoteBindPrepared: true,
    workload: {
      ...entry.workload,
      encodedProfile: built.encodedProfile,
      startupProfileSha256: built.startupProfileSha256,
    },
  };
}

export function openAiProviderProfile() {
  return {
    profile: {
      id: "openai",
      source: "user",
      scope: "workspace",
      resourceVersion: 4n,
      credentials: [],
      endpoints: [],
      binaries: [],
      inferenceCapable: true,
    },
  };
}

export function nativeNvidiaProvider() {
  return { ...provider().provider, type: "nvidia", profileWorkspace: "", config: {} };
}
