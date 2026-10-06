// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

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
}): Promise<void> {
  const expected = normalizeNativeBedrockProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native Bedrock ownership receipt.");
  const request = {
    target: { kind: "named" as const, gatewayName: expected.gatewayName },
    providerName: expected.providerName,
  };
  const before = await input.adapter.getProvider(request);
  if (!before.ok) {
    if (before.error.kind === "command" && before.error.reason === "not_found") {
      input.clearAuthority();
      return;
    }
    throw new Error(
      "Bedrock provider retirement could not verify ownership; recovery authority retained.",
    );
  }
  const metadata = before.value;
  if (
    metadata.name !== expected.providerName ||
    metadata.type !== expected.profileId ||
    metadata.revision?.id !== expected.providerId ||
    metadata.configKeys.length !== 0 ||
    metadata.credentialKeys.length !== 1 ||
    metadata.credentialKeys[0] !== "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"
  ) {
    throw new Error("Bedrock provider identity changed; no provider was removed.");
  }
  const removed = await input.adapter.deleteProvider(request);
  if (!removed.ok && removed.error.kind === "command" && removed.error.reason === "attached")
    return;
  // Observe even a successful or ambiguous deletion before forgetting recovery authority.
  const after = await input.adapter.getProvider(request);
  if (!after.ok && after.error.kind === "command" && after.error.reason === "not_found") {
    input.clearAuthority();
    return;
  }
  throw new Error("Bedrock provider removal was not confirmed; recovery authority retained.");
}
