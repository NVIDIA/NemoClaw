// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { createHash } from "node:crypto";
import { isLocalInferenceProvider, qualifiedNativeLocalEndpointUrl } from "./agent-config";
import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import type { NativeProviderAttachment } from "../native-provider/lifecycle";

export {
  NATIVE_LOCAL_CREDENTIAL_ENV,
  isLocalInferenceProvider,
  nativeLocalCredentialReference,
} from "./agent-config";

export type NativeLocalProvider =
  | "ollama-local"
  | "vllm-local"
  | "llama-cpp-local"
  | "compatible-endpoint";
export type NativeLocalBinding = Readonly<{
  provider: NativeLocalProvider;
  agent?: "openclaw" | "pi";
  endpointUrl: string;
  credentialEnv: string;
  authMode: "authenticated" | "sentinel";
  gatewayName: string;
  sandboxName: string;
  /** Existing runtime publication transaction, when that owner requires one. */
  transactionId?: string;
}>;
export type NativeLocalProviderAttachment = NativeProviderAttachment & NativeLocalBinding;

/** Consume only the host-reachable address already selected by the local runtime owner. */
export function normalizeNativeLocalBinding(value: unknown): NativeLocalBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    (!isLocalInferenceProvider(input.provider as string) &&
      input.provider !== "compatible-endpoint") ||
    (input.agent !== undefined && input.agent !== "openclaw" && input.agent !== "pi") ||
    (input.agent === "openclaw" && !isLocalInferenceProvider(input.provider as string)) ||
    typeof input.endpointUrl !== "string" ||
    typeof input.credentialEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(input.credentialEnv) ||
    (input.authMode !== "authenticated" && input.authMode !== "sentinel") ||
    typeof input.gatewayName !== "string" ||
    !isValidName(input.gatewayName) ||
    typeof input.sandboxName !== "string" ||
    !isValidName(input.sandboxName) ||
    (input.transactionId !== undefined &&
      (typeof input.transactionId !== "string" || !/^[a-f0-9]{64}$/.test(input.transactionId)))
  )
    return undefined;
  const endpointUrl = qualifiedNativeLocalEndpointUrl(input.endpointUrl);
  if (!endpointUrl) return undefined;
  return {
    provider: input.provider as NativeLocalProvider,
    ...(input.agent === "openclaw" || input.agent === "pi" ? { agent: input.agent } : {}),
    endpointUrl,
    credentialEnv: input.credentialEnv,
    authMode: input.authMode,
    gatewayName: input.gatewayName,
    sandboxName: input.sandboxName,
    ...(typeof input.transactionId === "string" ? { transactionId: input.transactionId } : {}),
  };
}

export function nativeLocalIdentity(binding: NativeLocalBinding) {
  const normalized = normalizeNativeLocalBinding(binding);
  if (!normalized) throw new Error("Invalid native host-local inference boundary.");
  const profileHash = createHash("sha256")
    .update(
      JSON.stringify([
        normalized.provider,
        ...(normalized.agent ? [normalized.agent] : []),
        normalized.endpointUrl,
        normalized.credentialEnv,
        normalized.authMode,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const profileId = `nemoclaw-local-${normalized.authMode}-v1-${profileHash}`;
  const instanceHash = createHash("sha256")
    .update(
      JSON.stringify([
        profileId,
        normalized.gatewayName,
        normalized.sandboxName,
        ...(normalized.transactionId ? [normalized.transactionId] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return { profileId, providerName: `nemoclaw-local-v1-${instanceHash}` };
}

export function normalizeNativeLocalProviderAttachment(
  value: unknown,
): NativeLocalProviderAttachment | undefined {
  const binding = normalizeNativeLocalBinding(value);
  if (!binding) return undefined;
  const receipt = value as Record<string, unknown>;
  const identity = nativeLocalIdentity(binding);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.profileId !== identity.profileId ||
    receipt.providerName !== identity.providerName ||
    typeof receipt.providerId !== "string" ||
    !receipt.providerId.trim()
  )
    return undefined;
  return {
    ...binding,
    ...identity,
    schemaVersion: 1,
    providerId: receipt.providerId,
  };
}

export function normalizeNativeLocalProviderAuthorities(
  value: unknown,
): Record<string, NativeLocalProviderAttachment> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Invalid persisted native local provider authority. Retain the registry for explicit repair.",
    );
  const entries = Object.entries(value).map(([name, value]) => {
    const receipt = normalizeNativeLocalProviderAttachment(value);
    if (!receipt || receipt.providerName !== name)
      throw new Error(
        "Invalid persisted native local provider authority. Retain the registry for explicit repair.",
      );
    return [name, receipt] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Hosted compatible endpoints remain with their hosted migration slice. */
export function usesNativeLocalInference(
  provider: string | null | undefined,
  endpointUrl?: string | null,
): boolean {
  if (isLocalInferenceProvider(provider)) return true;
  if (provider !== "compatible-endpoint" || !endpointUrl) return false;
  try {
    const endpoint = new URL(endpointUrl);
    return (
      endpoint.protocol === "http:" &&
      [11434, OLLAMA_PROXY_PORT, VLLM_PORT].includes(Number(endpoint.port)) &&
      [
        "localhost",
        "127.0.0.1",
        "[::1]",
        "host.openshell.internal",
        "host.docker.internal",
      ].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

/** Route only the agents whose native local credential consumers are covered by this slice. */
export function usesNativeLocalInferenceForAgent(
  agentName: string | null | undefined,
  provider: string | null | undefined,
  endpointUrl?: string | null,
  localNimSelected = false,
): boolean {
  if (provider === "vllm-local" && localNimSelected) return false;
  return (
    ((agentName === "langchain-deepagents-code" || agentName === "pi") &&
      usesNativeLocalInference(provider, endpointUrl)) ||
    (agentName === "openclaw" && isLocalInferenceProvider(provider))
  );
}

/** Preserve only a published Pi selection that still uses its recorded shared route. */
export function isPersistedPiSharedLocalInferenceRoute(
  recorded:
    | {
        agent?: string | null;
        provider?: string | null;
        model?: string | null;
        endpointUrl?: string | null;
        createdAt?: string | null;
        pendingRouteReservation?: boolean;
        nativeLocalProviderAttachment?: unknown;
      }
    | null
    | undefined,
  selected?: { provider?: string | null; model?: string | null; endpointUrl?: string | null },
): boolean {
  return Boolean(
    recorded?.agent === "pi" &&
    typeof recorded.createdAt === "string" &&
    recorded.pendingRouteReservation !== true &&
    recorded.nativeLocalProviderAttachment === undefined &&
    usesNativeLocalInferenceForAgent("pi", recorded.provider, recorded.endpointUrl) &&
    (!selected ||
      (recorded.provider === selected.provider &&
        recorded.model === selected.model &&
        (recorded.endpointUrl ?? null) === (selected.endpointUrl ?? null))),
  );
}
