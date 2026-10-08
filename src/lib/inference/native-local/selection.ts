// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { isProtectedNemoClawHostPort } from "../../core/protected-host-ports";
import {
  listRecordedGatewayPorts,
  listRecordedModelRouterPorts,
  resolveHome,
} from "../../state/gateway-registry";
import {
  getNativeLocalProviderAuthority,
  listNativeLocalProviderAuthorities,
  clearNativeLocalProviderAuthority,
  setNativeLocalProviderAuthority,
} from "../../state/registry/native-local-provider-authority";
import {
  nativeLocalIdentity,
  NATIVE_LOCAL_CREDENTIAL_ENV,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "./contract";
import { ensureNativeLocalProvider, retireNativeLocalProvider } from "./profile";

/** Register the endpoint selected by the existing local runtime or proxy owner. */
export async function prepareNativeLocalSelection(input: {
  adapter: OpenShellProviderAdapter;
  binding: Omit<NativeLocalBinding, "credentialEnv">;
  credentialValue: string | null;
  ownedProxy?: boolean;
  readAuthority?: typeof getNativeLocalProviderAuthority;
  writeAuthority?: typeof setNativeLocalProviderAuthority;
}) {
  const binding = { ...input.binding, credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV };
  const identity = nativeLocalIdentity(binding);
  const port = Number(new URL(binding.endpointUrl).port);
  const home = resolveHome();
  const ownedProxy =
    input.ownedProxy === true &&
    port === OLLAMA_PROXY_PORT &&
    new URL(binding.endpointUrl).hostname === "host.openshell.internal";
  if (
    (!ownedProxy && isProtectedNemoClawHostPort(port, listRecordedModelRouterPorts(home))) ||
    listRecordedGatewayPorts(home).includes(port)
  ) {
    throw new Error("The selected local inference endpoint uses a protected host port.");
  }
  const readAuthority = input.readAuthority ?? getNativeLocalProviderAuthority;
  const writeAuthority = input.writeAuthority ?? setNativeLocalProviderAuthority;
  return ensureNativeLocalProvider({
    adapter: input.adapter,
    binding,
    credentialValue: input.credentialValue,
    expected: readAuthority(identity.providerName),
    readAuthority,
    writeAuthority,
  });
}

/** Caller holds the sandbox mutation lock and has committed its selection or confirmed deletion. */
export async function retireUnselectedNativeLocalProviders(input: {
  adapter: OpenShellProviderAdapter;
  sandboxName: string;
  gatewayName: string;
  selected?: NativeLocalProviderAttachment;
  destroyedAttachment?: NativeLocalProviderAttachment;
  listAuthorities?: typeof listNativeLocalProviderAuthorities;
  clearAuthority?: typeof clearNativeLocalProviderAuthority;
}): Promise<void> {
  const receipts = new Map(
    (input.listAuthorities ?? listNativeLocalProviderAuthorities)(
      input.sandboxName,
      input.gatewayName,
    ).map((receipt) => [receipt.providerName, receipt]),
  );
  const destroyed = input.destroyedAttachment;
  if (destroyed) {
    const recorded = receipts.get(destroyed.providerName);
    if (recorded && recorded.providerId !== destroyed.providerId)
      throw new Error("Native local provider cleanup authority changed.");
    receipts.set(destroyed.providerName, destroyed);
  }
  for (const receipt of receipts.values()) {
    if (receipt.providerName === input.selected?.providerName) continue;
    const result = await retireNativeLocalProvider({
      adapter: input.adapter,
      expected: receipt,
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
      clearAuthority: input.clearAuthority ?? clearNativeLocalProviderAuthority,
    });
    if (result.status === "attached")
      throw new Error(
        "Native inference provider remains attached; recovery authority retained. Inspect its attachments before retrying cleanup.",
      );
  }
}
