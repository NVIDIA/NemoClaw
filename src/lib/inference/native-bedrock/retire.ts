// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

import { retireNativeProvider, type NativeProviderRetirement } from "../native-provider/lifecycle";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  normalizeNativeBedrockProviderAttachment,
  type NativeBedrockProviderAttachment,
} from "./contract";

/** Retire only after rollback no longer needs this identity; never detach peers. */
export async function retireNativeBedrockProvider(input: {
  adapter: OpenShellProviderAdapter;
  expected: NativeBedrockProviderAttachment;
  clearAuthority: () => void;
}): Promise<NativeProviderRetirement> {
  const expected = normalizeNativeBedrockProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native Bedrock ownership receipt.");
  return retireNativeProvider({
    adapter: input.adapter,
    target: { kind: "named", gatewayName: expected.gatewayName },
    expected,
    credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
    clearAuthority: input.clearAuthority,
  });
}
