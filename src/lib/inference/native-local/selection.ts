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
  setNativeLocalProviderAuthority,
} from "../../state/registry/native-local-provider-authority";
import {
  nativeLocalIdentity,
  NATIVE_LOCAL_CREDENTIAL_ENV,
  type NativeLocalBinding,
} from "./contract";
import { ensureNativeLocalProvider } from "./profile";

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
