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
  if (!recorded || recorded.nativeCustomProviderAttachment === undefined) return false;
  const receipt = getMatchingNativeCustomProviderAuthority(
    input.gatewayName,
    input.sandboxName,
    recorded.nativeCustomProviderAttachment,
    deps.getNativeCustomProviderAuthority,
  );
  if (
    recorded.gatewayName !== input.gatewayName ||
    recorded.provider !== input.provider ||
    receipt.credentialEnv !== input.credentialEnv ||
    !input.endpointUrl ||
    !input.api
  )
    throw new Error("Recorded native custom selection cannot authorize resume.");
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
