// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../name-validation";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import {
  clearNativeCustomProviderAuthority,
  listNativeCustomProviderAuthorities,
} from "../../state/registry/native-custom-provider-authority";
import { computeHttpsPinRouteId } from "../https-pin-runtime";
import { revokeHttpsPinRuntimeAdapterRoute } from "../https-pin-runtime-adapter";
import {
  normalizeNativeCustomProviderAttachment,
  profileFromCustomAttachment,
  withNativeCustomLifecycle,
  type NativeCustomProviderAttachment,
} from "./index";

/** Delete only proven-owned, detached registrations; retain receipts until all cleanup is observed. */
export async function retireNativeCustomProviders(input: {
  gatewayName: string;
  sandboxName: string;
  keepProviderName?: string;
  adapter?: OpenShellProviderAdapter;
  receipts?: readonly NativeCustomProviderAttachment[];
  clearAuthority?: typeof clearNativeCustomProviderAuthority;
  revokeRoute?: typeof revokeHttpsPinRuntimeAdapterRoute;
}): Promise<void> {
  if (!isValidName(input.gatewayName) || !isValidName(input.sandboxName))
    throw new Error("Invalid native custom cleanup scope.");
  const receipts =
    input.receipts ?? listNativeCustomProviderAuthorities(input.gatewayName, input.sandboxName);
  const validated = receipts.map((receipt) => {
    const normalized = normalizeNativeCustomProviderAttachment(receipt, input.sandboxName);
    if (
      !normalized ||
      (normalized.transport && normalized.transport.gatewayName !== input.gatewayName)
    )
      throw new Error(
        "Native custom cleanup authority does not match the selected sandbox and gateway.",
      );
    return normalized;
  });
  const adapter = input.adapter ?? createCliOpenShellProviderAdapter();
  const keep = validated.find((receipt) => receipt.providerName === input.keepProviderName);
  const routeId = (receipt: NativeCustomProviderAttachment | undefined): string | null =>
    receipt?.transport?.kind === "https-pin"
      ? computeHttpsPinRouteId(
          input.gatewayName,
          receipt.credentialEnv === "COMPATIBLE_API_KEY"
            ? "compatible-endpoint"
            : "compatible-anthropic-endpoint",
          receipt.transport.sourceEndpointUrl,
          receipt.sandboxName,
        )
      : null;
  for (const receipt of validated) {
    if (receipt.providerName === input.keepProviderName) continue;
    await withNativeCustomLifecycle(profileFromCustomAttachment(receipt), (lifecycle) =>
      lifecycle.deleteOwnedProvider({
        adapter,
        target: { kind: "named", gatewayName: input.gatewayName },
        expected: receipt,
      }),
    );
    const route = routeId(receipt);
    if (route && route !== routeId(keep)) {
      if (!(await (input.revokeRoute ?? revokeHttpsPinRuntimeAdapterRoute)(route)))
        throw new Error(
          "Native custom HTTPS adapter route revocation was not confirmed; cleanup authority is retained.",
        );
    }
    (input.clearAuthority ?? clearNativeCustomProviderAuthority)(input.gatewayName, receipt);
  }
}
