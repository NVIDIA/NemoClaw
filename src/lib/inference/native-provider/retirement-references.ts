// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ProviderReference = { providerName: string; profileId: string };
type SandboxReference = {
  name: string;
  gatewayName?: string | null;
  nativeCompatibleProviderAttachment?: ProviderReference;
  nativeBedrockProviderAttachment?: ProviderReference;
};

/** Read under the gateway mutation lock; pending reservations also retain access authority. */
export function hasOtherNativeProviderReference(input: {
  sandboxes: readonly SandboxReference[];
  gatewayName: string;
  sandboxName?: string;
  expected: ProviderReference;
}): boolean {
  return input.sandboxes.some(
    (entry) =>
      entry.name !== input.sandboxName &&
      (entry.gatewayName == null || entry.gatewayName === input.gatewayName) &&
      [entry.nativeCompatibleProviderAttachment, entry.nativeBedrockProviderAttachment].some(
        (receipt) =>
          receipt !== undefined &&
          (receipt.providerName === input.expected.providerName ||
            receipt.profileId === input.expected.profileId),
      ),
  );
}
