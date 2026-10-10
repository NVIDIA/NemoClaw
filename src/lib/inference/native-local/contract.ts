// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import type { NativeProviderAttachment } from "../native-provider/lifecycle";

export { NATIVE_LOCAL_CREDENTIAL_ENV, nativeLocalCredentialReference } from "./agent-config";

export type NativeLocalProvider =
  | "ollama-local"
  | "vllm-local"
  | "llama-cpp-local"
  | "compatible-endpoint";
export type NativeLocalBinding = Readonly<{
  provider: NativeLocalProvider;
  endpointUrl: string;
  credentialEnv: string;
  authMode: "authenticated" | "sentinel";
  gatewayName: string;
  sandboxName: string;
  /** Existing runtime publication transaction, when that owner requires one. */
  transactionId?: string;
}>;
export type NativeLocalProviderAttachment = NativeProviderAttachment & NativeLocalBinding;

export function isLocalInferenceProvider(provider: string | null | undefined): boolean {
  return provider === "ollama-local" || provider === "vllm-local" || provider === "llama-cpp-local";
}

/** Consume only the host-reachable address already selected by the local runtime owner. */
export function normalizeNativeLocalBinding(value: unknown): NativeLocalBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    (!isLocalInferenceProvider(input.provider as string) &&
      input.provider !== "compatible-endpoint") ||
    typeof input.endpointUrl !== "string" ||
    unsafeEndpointUrlViolation(input.endpointUrl) ||
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
  try {
    const endpoint = new URL(input.endpointUrl);
    const host = endpoint.hostname;
    // Loopback always identifies the sandbox itself. Public or arbitrary DNS
    // names belong to hosted endpoint validation, not the host-local bridge.
    const privateIpv4 =
      isIP(host) === 4 &&
      (host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host));
    if (
      endpoint.protocol !== "http:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.port ||
      Number(endpoint.port) < 1024 ||
      (host !== "host.openshell.internal" && host !== "host.docker.internal" && !privateIpv4) ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(endpoint.pathname)
    )
      return undefined;
    return {
      provider: input.provider as NativeLocalProvider,
      endpointUrl: `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}`,
      credentialEnv: input.credentialEnv,
      authMode: input.authMode,
      gatewayName: input.gatewayName,
      sandboxName: input.sandboxName,
      ...(typeof input.transactionId === "string" ? { transactionId: input.transactionId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function nativeLocalIdentity(binding: NativeLocalBinding) {
  const normalized = normalizeNativeLocalBinding(binding);
  if (!normalized) throw new Error("Invalid native host-local inference boundary.");
  const profileHash = createHash("sha256")
    .update(
      JSON.stringify([
        normalized.provider,
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
  return { ...binding, ...identity, schemaVersion: 1, providerId: receipt.providerId };
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
): boolean {
  return (
    (agentName === "openclaw" || agentName === "langchain-deepagents-code") &&
    usesNativeLocalInference(provider, endpointUrl)
  );
}
