// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0

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
}): Promise<void> {
  const expected = normalizeNativeCompatibleProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native compatible ownership receipt.");
  const request = { target: input.target, providerName: expected.providerName };
  const before = await input.adapter.getProvider(request);
  if (!before.ok) {
    if (before.error.kind === "command" && before.error.reason === "not_found") {
      input.clearAuthority();
      return;
    }
    throw new Error(
      "Compatible provider retirement could not verify ownership; recovery authority retained.",
    );
  }
  const metadata = before.value;
  if (
    metadata.name !== expected.providerName ||
    metadata.type !== expected.profileId ||
    metadata.revision?.id !== expected.providerId ||
    metadata.configKeys.length !== 0 ||
    metadata.credentialKeys.length !== 1 ||
    metadata.credentialKeys[0] !== "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY"
  ) {
    throw new Error("Compatible provider identity changed; no provider was removed.");
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
  throw new Error("Compatible provider removal was not confirmed; recovery authority retained.");
}
