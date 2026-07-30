// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedStartupAgent,
  ManagedStartupProfile,
} from "../../src/lib/onboard/managed-startup/profile.ts";

export const PROTECTED_MANAGED_IMAGE_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const satisfies readonly ManagedStartupAgent[];

export const MANAGED_IMAGE_LOCAL_INFERENCE_KINDS = ["ollama", "nim", "vllm"] as const;

export type ManagedImageLocalInferenceKind = (typeof MANAGED_IMAGE_LOCAL_INFERENCE_KINDS)[number];

export type ManagedImageLocalInferenceRoute = {
  readonly kind: ManagedImageLocalInferenceKind;
  readonly providerName: "ollama-local" | "vllm-local";
  readonly credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" | "NEMOCLAW_VLLM_LOCAL_TOKEN";
  readonly defaultBaseUrl: string;
};

export type ProtectedManagedImageContract = {
  readonly agent: ManagedStartupAgent;
  readonly platform: "linux/amd64";
  readonly reference: string;
};

const IMMUTABLE_PROTECTED_REFERENCE_RE =
  /^localhost:5000\/nemoclaw-managed-protected\/[^@\s]+@sha256:[a-f0-9]{64}$/u;

const LOCAL_INFERENCE_ROUTES: Readonly<
  Record<ManagedImageLocalInferenceKind, ManagedImageLocalInferenceRoute>
> = Object.freeze({
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

export function parseProtectedManagedImageContracts(
  value: unknown,
): ProtectedManagedImageContract[] {
  if (!Array.isArray(value) || value.length !== PROTECTED_MANAGED_IMAGE_AGENTS.length) {
    throw new Error("protected managed-image contract must contain exactly all shipped agents");
  }
  const contracts = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("protected managed-image contract entry must be an object");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.agent !== "string" ||
      !PROTECTED_MANAGED_IMAGE_AGENTS.includes(record.agent as ManagedStartupAgent) ||
      record.platform !== "linux/amd64" ||
      typeof record.reference !== "string" ||
      !IMMUTABLE_PROTECTED_REFERENCE_RE.test(record.reference)
    ) {
      throw new Error("protected managed-image contract entry is invalid");
    }
    return {
      agent: record.agent as ManagedStartupAgent,
      platform: "linux/amd64" as const,
      reference: record.reference,
    };
  });
  const actualAgents = contracts.map(({ agent }) => agent).sort();
  const expectedAgents = [...PROTECTED_MANAGED_IMAGE_AGENTS].sort();
  if (
    actualAgents.some((agent, index) => agent !== expectedAgents[index]) ||
    new Set(contracts.map(({ reference }) => reference)).size !== contracts.length
  ) {
    throw new Error("protected managed-image contract must contain one unique image per agent");
  }
  return contracts;
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
