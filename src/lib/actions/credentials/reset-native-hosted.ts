// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import { hostedNativeProvider } from "../../inference/native-provider/hosted";
import { isNativeHostedProviderName } from "../../inference/native-provider/hosted-attachment";
import { hostedNativeProviderForAttachment } from "../../inference/native-provider/hosted-attachment";
import * as authority from "../../state/registry/native-provider-authority";
import type { CredentialsResetResult } from "./reset";

export type NativeHostedResetDeps = Partial<
  Pick<
    typeof authority,
    | "getNativeHostedProviderAuthority"
    | "getNativeHostedProviderAuthorityByName"
    | "clearNativeHostedProviderAuthority"
    | "listNativeHostedProviderAttachmentSandboxNames"
  >
>;

/** Caller holds the gateway mutation lock through observation, deletion and authority cleanup. */
export async function resetNativeHostedProvider(
  key: string,
  target: Extract<OpenShellGatewayTarget, { kind: "named" }>,
  adapter: OpenShellProviderAdapter,
  deps: NativeHostedResetDeps = {},
): Promise<CredentialsResetResult | null> {
  const logical = hostedNativeProvider(key);
  if (!logical && !isNativeHostedProviderName(key)) return null;
  const fail = (detail: string): CredentialsResetResult => ({
    exitCode: 1,
    outputLines: [],
    failureLines: [detail],
  });
  try {
    const receipt = logical
      ? (deps.getNativeHostedProviderAuthority ?? authority.getNativeHostedProviderAuthority)(
          target.gatewayName,
          key,
        )
      : (
          deps.getNativeHostedProviderAuthorityByName ??
          authority.getNativeHostedProviderAuthorityByName
        )(target.gatewayName, key);
    const definition = hostedNativeProviderForAttachment(receipt);
    if (
      !receipt ||
      !definition ||
      (logical ? definition.logicalProvider !== key : receipt.providerName !== key)
    )
      return fail("Native provider ownership is missing. No provider was changed.");
    if (logical) {
      const legacy = await adapter.getProvider({ target, providerName: key });
      if (legacy.ok)
        return fail(
          `Legacy provider '${key}' has no native ownership proof. It was preserved. Use the native name '${receipt.providerName}' to select that resource explicitly.`,
        );
      if (legacy.error.kind !== "command" || legacy.error.reason !== "not_found")
        return fail(
          "Could not establish whether a separate legacy provider exists. No provider was changed.",
        );
    }
    const sandboxes = (
      deps.listNativeHostedProviderAttachmentSandboxNames ??
      authority.listNativeHostedProviderAttachmentSandboxNames
    )(target.gatewayName, receipt.providerName);
    if (sandboxes.length)
      return fail(
        `Provider '${receipt.providerName}' is recorded by sandbox(es): ${sandboxes.join(", ")}. Rotate its credential in place, or destroy the owned sandboxes before resetting it. No provider was changed.`,
      );
    const lifecycle = nativeProviderLifecycle(definition);
    const observed = await lifecycle.inspectNativeProvider(adapter, target);
    if (
      observed &&
      lifecycle.nativeProviderAttachmentFromMetadata(observed).providerId !== receipt.providerId
    )
      return fail(
        "The native provider identity changed. No provider was deleted and ownership records were preserved.",
      );
    if (observed) {
      const removed = await adapter.deleteProvider({ target, providerName: receipt.providerName });
      // An uncertain result is observed once. Never detach unknown sandboxes or retry deletion here.
      const after = await lifecycle.inspectNativeProvider(adapter, target);
      if (after)
        return fail(
          removed.ok
            ? "Provider removal was not confirmed. Ownership records were preserved."
            : "Provider removal failed. No attachment was changed; ownership records were preserved.",
        );
    }
    (deps.clearNativeHostedProviderAuthority ?? authority.clearNativeHostedProviderAuthority)(
      target.gatewayName,
      receipt,
    );
    return {
      exitCode: 0,
      outputLines: [
        `Removed native provider '${receipt.providerName}'. Rerun onboarding to register a replacement.`,
      ],
      failureLines: [],
    };
  } catch {
    return fail(
      "Could not verify native provider removal. Ownership records were preserved; inspect the gateway before retrying.",
    );
  }
}
