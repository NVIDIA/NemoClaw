// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isNativeCustomProvider } from "../../inference/native-custom/profile";
import { restoreNativeCustomInference } from "../../inference/native-custom/transport";
import { load } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";
import {
  getMatchingNativeCustomProviderAuthority,
  getNativeCustomProviderAuthority,
} from "../../state/registry/native-custom-provider-authority";

export type RetainedNativeCustomSelection = {
  gatewayName: string;
  sandboxName: string | null;
  provider: string | null;
  endpointUrl: string | null;
  api: string | null;
  credentialEnv: string | null;
  nativeCustomProviderAttachment?: unknown;
};

/** Select native recovery; setupInference still verifies the live profile and immutable provider ID. */
export function hasRetainedNativeCustomSelection(
  input: RetainedNativeCustomSelection,
  deps = {
    getSandbox: (name: string): SandboxEntry | null => load().sandboxes[name] || null,
    getNativeCustomProviderAuthority,
  },
): boolean {
  if (!isNativeCustomProvider(input.provider) || !input.sandboxName) return false;
  const recorded = deps.getSandbox(input.sandboxName);
  const value =
    input.nativeCustomProviderAttachment !== undefined
      ? input.nativeCustomProviderAttachment
      : recorded?.nativeCustomProviderAttachment;
  if (value === undefined) return false;
  const receipt = getMatchingNativeCustomProviderAuthority(
    input.gatewayName,
    input.sandboxName,
    value,
    deps.getNativeCustomProviderAuthority,
  );
  if (
    (recorded &&
      (recorded.gatewayName !== input.gatewayName || recorded.provider !== input.provider)) ||
    receipt.credentialEnv !== input.credentialEnv ||
    !input.endpointUrl ||
    !input.api
  )
    throw new Error("Recorded native custom selection cannot authorize resume.");
  if (recorded?.nativeCustomProviderAttachment !== undefined) {
    const current = getMatchingNativeCustomProviderAuthority(
      input.gatewayName,
      input.sandboxName,
      recorded.nativeCustomProviderAttachment,
      deps.getNativeCustomProviderAuthority,
    );
    if (JSON.stringify(current) !== JSON.stringify(receipt))
      throw new Error("Native custom rebuild and sandbox authority disagree.");
  }
  restoreNativeCustomInference(
    {
      sandboxName: input.sandboxName,
      gatewayName: input.gatewayName,
      provider: input.provider,
      endpointUrl: input.endpointUrl,
      api: input.api,
    },
    receipt,
  );
  return true;
}
