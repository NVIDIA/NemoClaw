// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "./contract";
import {
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";

/**
 * Re-prove an exact durable host-local route through its owning provider.
 * Central lifecycle code handles only the canonical receipt transport; the
 * provider remains responsible for engine-specific inspection and authority.
 */
export function reproveHostLocalInferenceReceipt(
  provider: RuntimeProviderBundle,
  serialized: string,
): string {
  const surface = provider.hostLocalInference;
  if (!surface.supported) {
    throw new Error(
      `Runtime provider '${provider.identity.id}' does not support host-local inference.`,
    );
  }
  const receipt = parseHostLocalInferenceReceipt(serialized);
  if (
    surface.providerId !== provider.identity.id ||
    surface.runtime.providerId !== provider.identity.id ||
    receipt.providerId !== provider.identity.id
  ) {
    throw new Error("Host-local inference receipt belongs to a different runtime provider.");
  }
  const reproved = serializeHostLocalInferenceReceipt(surface.runtime.preserveForRebuild(receipt));
  if (reproved !== serialized) {
    throw new Error("Host-local inference authority changed while it was being preserved.");
  }
  return reproved;
}
