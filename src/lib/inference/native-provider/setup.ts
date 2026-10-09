// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertEndpointResolvesPublic,
  type EndpointDnsLookupFn,
} from "../../security/trusted-private-endpoint";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { SandboxEntry } from "../../state/registry/types";
import type { NativeProviderAttachment } from "./contract";
import { nativeProviderLifecycle } from "./index";
import { hostedNativeProvider } from "./hosted";
import { requireHostedProviderAttachment } from "./hosted-attachment";

/** Prepare gateway ownership; attachment remains the selected sandbox transaction's job. */
export async function prepareHostedNativeProvider(input: {
  provider: string;
  adapter: OpenShellProviderAdapter;
  gatewayName: string;
  credentialValue: string | null;
  endpointUrl?: string | null;
  lookup?: EndpointDnsLookupFn;
  reuseExistingCredential?: boolean;
  recordedSandbox?: SandboxEntry | null;
  readAuthority: (
    gateway: string,
    provider: string,
    endpointUrl?: string | null,
  ) => NativeProviderAttachment | undefined;
  writeAuthority: (gateway: string, provider: string, receipt: NativeProviderAttachment) => void;
}): Promise<NativeProviderAttachment> {
  const recordedEndpoint =
    input.recordedSandbox?.provider === input.provider
      ? input.recordedSandbox.nativeHostedProviderAttachment?.endpointUrl
      : undefined;
  const definition = hostedNativeProvider(input.provider, input.endpointUrl ?? recordedEndpoint);
  if (!definition) throw new Error("Unsupported fixed hosted provider");
  if (definition.endpointUrl) {
    const allowed = await assertEndpointResolvesPublic(definition.endpointUrl, input.lookup);
    if (!allowed.ok)
      throw new Error(`Hermes returned an unsafe inference endpoint: ${allowed.reason}`);
  }
  const lifecycle = nativeProviderLifecycle(definition);
  const recorded = input.recordedSandbox;
  const recordedAttachment =
    recorded?.provider === input.provider
      ? requireHostedProviderAttachment(recorded.nativeHostedProviderAttachment, input.provider)
      : undefined;
  const expected = lifecycle.resolveGatewayNativeProviderAuthority({
    gatewayName: input.gatewayName,
    gatewayAuthority: input.readAuthority(
      input.gatewayName,
      input.provider,
      definition.endpointUrl ??
        (input.provider === "hermes-provider" ? definition.endpoint : undefined),
    ),
    recordedAttachment:
      recordedAttachment?.providerName === definition.providerName ? recordedAttachment : undefined,
  });
  const target = { kind: "named", gatewayName: input.gatewayName } as const;
  const receipt = await lifecycle.ensureNativeProvider({
    adapter: input.adapter,
    target,
    credentialValue: input.credentialValue,
    reuseExistingCredential: input.reuseExistingCredential,
    ...(expected ? { expected } : {}),
  });
  await lifecycle.persistNativeProviderAuthority({
    adapter: input.adapter,
    target,
    gatewayName: input.gatewayName,
    receipt,
    ...(expected ? { existing: expected } : {}),
    readAuthority: (gateway) =>
      input.readAuthority(
        gateway,
        input.provider,
        definition.endpointUrl ??
          (input.provider === "hermes-provider" ? definition.endpoint : undefined),
      ),
    writeAuthority: (gateway, value) => input.writeAuthority(gateway, input.provider, value),
  });
  return receipt;
}
