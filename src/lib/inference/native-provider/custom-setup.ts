// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { normalizeProviderBaseUrl } from "../../core/provider-endpoint";
import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
} from "../../security/trusted-private-endpoint";
import { parseTrustedPrivateInferenceHostsFromEnv } from "../endpoint-ssrf-preflight";
import type { NativeProviderAttachment } from "./contract";
import { customNativeProvider, isHostedCustomEndpoint, type CustomNativeBinding } from "./custom";
import { requireHostedProviderAttachment } from "./hosted-attachment";
import { nativeProviderLifecycle } from "./index";
import {
  BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  classifyCustomAnthropicEndpoint,
  hasBedrockRuntimeAwsAuthEnv,
} from "../bedrock-runtime";
import { ensureBedrockRuntimeAdapter } from "../bedrock-runtime-adapter";
import { PERSONAL_POLICY_TIER_NAME } from "../../policy/tiers";
import { assertOpenShellPolicyEndpointPins } from "../../adapters/openshell/policy-boundary";
import { cliOpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy-cli";
import type { OpenShellSandboxPolicyReader } from "../../adapters/openshell/sandbox-policy";
import { isRouteOnlySandboxReservation } from "../../state/registry/route-reservation";
import type { SandboxEntry } from "../../state/registry/types";

export { isHostedCustomEndpoint };

/** Read retained rules before re-onboarding can prepare a custom provider. */
export async function readCustomNativeSandboxPolicy(input: {
  gatewayName: string;
  sandboxName: string;
  recordedSandbox: Pick<SandboxEntry, "createdAt" | "pendingRouteReservation"> | null | undefined;
  rebuildSandboxPolicyDocument?: string;
  reader?: Pick<OpenShellSandboxPolicyReader, "readSandboxPolicy">;
  redactDiagnostic: (message: string) => string;
}): Promise<string | null> {
  // Rebuild has removed the live sandbox; its retained rules still constrain the replacement.
  if (input.rebuildSandboxPolicyDocument !== undefined) return input.rebuildSandboxPolicyDocument;
  if (!input.recordedSandbox || isRouteOnlySandboxReservation(input.recordedSandbox)) return null;
  const policy = await (input.reader ?? cliOpenShellSandboxPolicyReader).readSandboxPolicy({
    target: { kind: "named", gatewayName: input.gatewayName },
    sandboxName: input.sandboxName,
    scope: "base",
  });
  if (!policy.ok) {
    throw new Error(
      `Cannot inspect the sandbox policy before selecting a custom endpoint: ${input.redactDiagnostic(policy.error.message)} Resolve the policy-read error before retrying. No provider was changed.`,
    );
  }
  return policy.value.document;
}

/**
 * Existing shared-route sandboxes retain their route until recreated.
 *
 * A Personal sandbox keeps a new custom endpoint on the shared inference.local
 * route. OpenShell rejects Personal's hostless port-443 rule beside an attached
 * provider endpoint on the same port (NVIDIA/OpenShell#4662), so a native
 * provider would make the Personal policy unappliable.
 */
export function usesCustomNativeOnboarding(
  provider: string,
  endpointUrl: string | null,
  sandboxName: string | null,
  recorded:
    | {
        pendingRouteReservation?: boolean;
        nativeHostedProviderAttachment?: NativeProviderAttachment;
      }
    | null
    | undefined,
  policyTier: string | undefined = process.env.NEMOCLAW_POLICY_TIER,
): boolean {
  const personal = policyTier?.trim().toLowerCase() === PERSONAL_POLICY_TIER_NAME;
  return Boolean(
    sandboxName &&
    isHostedCustomEndpoint(provider, endpointUrl) &&
    (recorded?.nativeHostedProviderAttachment?.custom ||
      (!personal && (!recorded || recorded.pendingRouteReservation))),
  );
}

/** Recover the recorded host credential binding only for the selected custom endpoint. */
export function recordedCustomCredentialEnv(
  provider: string,
  endpointUrl: string | null,
  attachment: NativeProviderAttachment | undefined,
): string | null {
  if (!attachment?.custom || attachment.custom.provider !== provider || !endpointUrl) return null;
  const validated = requireHostedProviderAttachment(attachment, provider);
  const endpoint = normalizeProviderBaseUrl(
    endpointUrl,
    provider === "compatible-anthropic-endpoint" ? "anthropic" : "openai",
  );
  return validated?.custom?.endpointUrl === endpoint ? validated.custom.credentialEnv : null;
}

/** Admit a custom endpoint before creating or reusing its endpoint-bound provider. */
export async function prepareCustomNativeProvider(input: {
  gatewayName: string;
  provider: string;
  endpointUrl: string;
  api: string;
  credentialEnv: string;
  credentialValue: string | null;
  adapter: OpenShellProviderAdapter;
  /** Null only before onboarding creates the sandbox; existing sandboxes supply their base policy. */
  sandboxPolicyDocument: string | null;
  recordedAttachment?: NativeProviderAttachment;
  /** Registry sandbox that owns `recordedAttachment`. */
  recordedSandboxName?: string | null;
  lookup?: EndpointDnsLookupFn;
  trustedPrivateHosts?: readonly string[];
  ensureBedrockAdapter?: typeof ensureBedrockRuntimeAdapter;
  readAuthority: (gateway: string, provider: string) => NativeProviderAttachment | undefined;
  writeAuthority: (gateway: string, provider: string, receipt: NativeProviderAttachment) => void;
  onCredentialPersisted?: (credentialEnv: string, value: string) => void;
}): Promise<NativeProviderAttachment> {
  if (unsafeEndpointUrlViolation(input.endpointUrl) || /%2f|%5c|%2e/iu.test(input.endpointUrl))
    throw new Error("Custom native inference requires a valid credential-free HTTP(S) endpoint");
  const api = input.api === "responses" ? "openai-responses" : input.api;
  const endpointUrl = normalizeProviderBaseUrl(
    input.endpointUrl,
    input.provider === "compatible-anthropic-endpoint" ? "anthropic" : "openai",
  );
  const classified =
    input.provider === "compatible-anthropic-endpoint"
      ? classifyCustomAnthropicEndpoint(input.endpointUrl)
      : undefined;
  const bedrock = classified?.kind === "bedrock-runtime" ? classified : undefined;
  const previous = input.recordedAttachment
    ? requireHostedProviderAttachment(input.recordedAttachment, input.provider)
    : undefined;
  const sameBinding =
    previous?.custom &&
    previous.custom.endpointUrl === endpointUrl &&
    previous.custom.api === api &&
    previous.custom.credentialEnv === input.credentialEnv;
  const admitted =
    sameBinding || bedrock
      ? undefined
      : await assertEndpointResolvesPublic(endpointUrl, input.lookup, {
          trustedPrivateHosts:
            input.trustedPrivateHosts ?? parseTrustedPrivateInferenceHostsFromEnv(process.env),
        });
  if (admitted && !admitted.ok)
    throw new Error(`Custom native endpoint admission failed: ${admitted.reason}`);
  const definition = customNativeProvider({
    provider: input.provider,
    endpointUrl,
    api,
    credentialEnv: input.credentialEnv,
    allowedIps: sameBinding
      ? previous.custom!.allowedIps
      : admitted?.ok
        ? admitted.addresses?.length
          ? admitted.addresses
          : [new URL(endpointUrl).hostname.replace(/^\[|\]$/gu, "")]
        : [],
    ...(bedrock ? { adapterEndpointUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } : {}),
  } satisfies Omit<CustomNativeBinding, "provider" | "api"> & { provider: string; api: string });
  if (input.sandboxPolicyDocument !== null) {
    assertOpenShellPolicyEndpointPins(
      input.sandboxPolicyDocument,
      definition.endpoint,
      definition.allowedIps ?? [],
    );
  }
  const lifecycle = nativeProviderLifecycle(definition);
  const gatewayAuthority = input.readAuthority(input.gatewayName, definition.providerName);
  const expected = lifecycle.resolveGatewayNativeProviderAuthority({
    gatewayName: input.gatewayName,
    gatewayAuthority,
    recordedAttachment: sameBinding ? previous : undefined,
  });
  // A credential key name alone cannot authorize reuse at a different endpoint or API.
  if (!input.credentialValue && !expected && !(bedrock && hasBedrockRuntimeAwsAuthEnv()))
    throw new Error(
      `A new credential is required for this endpoint and API. Set ${input.credentialEnv} and retry. No provider was changed.`,
    );
  const target = { kind: "named", gatewayName: input.gatewayName } as const;
  let credentialValue = expected ? null : input.credentialValue;
  if (bedrock && !expected) {
    // Reject profile collisions before the existing adapter can start a process.
    await lifecycle.requireNativeProviderProfileBoundary(input.adapter, target);
    const transport = await (input.ensureBedrockAdapter ?? ensureBedrockRuntimeAdapter)({
      classification: bedrock,
      compatibleCredential: input.credentialValue,
    });
    if (transport.baseUrl !== definition.endpointUrl)
      throw new Error("Bedrock adapter endpoint does not match native provider authority");
    credentialValue = expected ? null : transport.token;
  }
  const receipt = await lifecycle.ensureNativeProvider({
    adapter: input.adapter,
    target,
    // Model changes and rebuilds reuse verified ownership without rotating credentials.
    credentialValue,
    ...(expected ? { expected } : {}),
    ...(expected && !gatewayAuthority && input.recordedSandboxName
      ? { recordedSandboxName: input.recordedSandboxName }
      : {}),
  });
  await lifecycle.persistNativeProviderAuthority({
    adapter: input.adapter,
    target,
    gatewayName: input.gatewayName,
    receipt,
    ...(expected ? { existing: expected } : {}),
    readAuthority: (gateway) => input.readAuthority(gateway, definition.providerName),
    writeAuthority: (gateway, authority) =>
      input.writeAuthority(gateway, input.provider, authority),
  });
  // Reuse does not prove that an ambient legacy value was stored. Bedrock
  // stores an adapter token, so its source credential is not retired here.
  if (!expected && !bedrock && credentialValue)
    input.onCredentialPersisted?.(input.credentialEnv, credentialValue);
  return receipt;
}
