// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedStartupAgent,
  ManagedStartupProfile,
} from "../../src/lib/onboard/managed-startup/profile.ts";

export {
  PROTECTED_MANAGED_IMAGE_AGENTS,
  type ProtectedManagedImageContract,
  parseProtectedManagedImageContracts,
} from "./protected-managed-image-contract.ts";

export const MANAGED_IMAGE_LOCAL_INFERENCE_KINDS = ["llama-cpp", "ollama", "nim", "vllm"] as const;

export type ManagedImageLocalInferenceKind = (typeof MANAGED_IMAGE_LOCAL_INFERENCE_KINDS)[number];

export type ManagedImageLocalInferenceRoute = {
  readonly kind: ManagedImageLocalInferenceKind;
  readonly providerName: "llama-cpp-local" | "ollama-local" | "vllm-local";
  readonly credentialEnv:
    | "NEMOCLAW_LLAMACPP_LOCAL_TOKEN"
    | "NEMOCLAW_OLLAMA_PROXY_TOKEN"
    | "NEMOCLAW_VLLM_LOCAL_TOKEN";
  readonly defaultBaseUrl: string;
};

const LOCAL_INFERENCE_ROUTES: Readonly<
  Record<ManagedImageLocalInferenceKind, ManagedImageLocalInferenceRoute>
> = Object.freeze({
  "llama-cpp": Object.freeze({
    kind: "llama-cpp",
    providerName: "llama-cpp-local",
    credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:8081/v1",
  }),
  ollama: Object.freeze({
    kind: "ollama",
    providerName: "ollama-local",
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:11435/v1",
  }),
  // Local NIM exposes the same OpenAI-compatible host route as local vLLM.
  // Keep the source kinds distinct even though OpenShell intentionally binds
  // both to vllm-local; this prevents a future engine-specific route change
  // from being silently treated as equivalent.
  nim: Object.freeze({
    kind: "nim",
    providerName: "vllm-local",
    credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:8000/v1",
  }),
  vllm: Object.freeze({
    kind: "vllm",
    providerName: "vllm-local",
    credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    defaultBaseUrl: "http://host.openshell.internal:8000/v1",
  }),
});

export function isManagedImageLocalInferenceKind(
  value: string,
): value is ManagedImageLocalInferenceKind {
  return (MANAGED_IMAGE_LOCAL_INFERENCE_KINDS as readonly string[]).includes(value);
}

export function resolveManagedImageLocalInferenceRoute(
  kind: ManagedImageLocalInferenceKind,
): ManagedImageLocalInferenceRoute {
  return LOCAL_INFERENCE_ROUTES[kind];
}

export function withManagedImageLocalInferenceProfile(
  profile: ManagedStartupProfile,
  route: ManagedImageLocalInferenceRoute,
  model: string,
): ManagedStartupProfile {
  const primaryModelRef =
    profile.agent === "openclaw" ? `inference/${model}` : profile.inference.primaryModelRef;
  return {
    ...profile,
    inference: {
      ...profile.inference,
      routeProvider: "inference",
      upstreamProvider: route.providerName,
      model,
      primaryModelRef,
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-completions",
    },
  } as ManagedStartupProfile;
}

export function managedImageProtectedSandboxName(
  agent: ManagedStartupAgent,
  routeKind: ManagedImageLocalInferenceKind | "rollback",
): string {
  const agentToken =
    agent === "langchain-deepagents-code" ? "dcode" : agent.replace(/[^a-z0-9-]+/gu, "-");
  return `nemoclaw-managed-${agentToken}-${routeKind}`;
}
