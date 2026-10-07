// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

import { retireNativeProvider, type NativeProviderRetirement } from "../native-provider/lifecycle";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { OpenShellGatewayTarget } from "../../adapters/openshell/sandbox-observer";
import {
  normalizeNativeCompatibleProviderAttachment,
  type NativeCompatibleProviderAttachment,
} from "./contract";

/** Retire only after rollback no longer needs this identity; never detach peers. */
export async function retireNativeCompatibleProvider(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  expected: NativeCompatibleProviderAttachment;
  clearAuthority: () => void;
}): Promise<NativeProviderRetirement> {
  const expected = normalizeNativeCompatibleProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native compatible ownership receipt.");
  return retireNativeProvider({
    adapter: input.adapter,
    target: input.target,
    expected,
    credentialEnv: "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
    clearAuthority: input.clearAuthority,
  });
}
