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

export type ManagedImageProtectedRouteKind = ManagedImageLocalInferenceKind | "rollback";

// OpenShell 0.0.99 caps routable sandbox names at 19 characters. Keep the
// protected-runtime ownership prefix and every agent/route discriminator
// explicit so the qualification matrix remains deterministic and collision
// free without relying on truncation.
export const MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX = "nmc-mi-";

const PROTECTED_SANDBOX_AGENT_TOKENS: Readonly<Record<ManagedStartupAgent, string>> = Object.freeze(
  {
    openclaw: "oc",
    hermes: "he",
    "langchain-deepagents-code": "dc",
  },
);

const PROTECTED_SANDBOX_ROUTE_TOKENS: Readonly<Record<ManagedImageProtectedRouteKind, string>> =
  Object.freeze({
    "llama-cpp": "lc",
    ollama: "ol",
    nim: "ni",
    vllm: "vl",
    rollback: "rb",
  });

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
  routeKind: ManagedImageProtectedRouteKind,
): string {
  return `${MANAGED_IMAGE_PROTECTED_SANDBOX_PREFIX}${PROTECTED_SANDBOX_AGENT_TOKENS[agent]}-${PROTECTED_SANDBOX_ROUTE_TOKENS[routeKind]}`;
}
