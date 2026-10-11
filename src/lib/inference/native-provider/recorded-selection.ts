// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
} from "../native-nvidia/contract";
import { requireHostedProviderAttachment } from "./hosted-attachment";
import type { NativeProviderAttachment } from "./contract";

/** Persisted authority selects the route; a logical provider name alone does not. */
export function recordedNativeProviderAttachment(selection: {
  provider?: string | null;
  nativeNvidiaProviderAttachment?: unknown;
  nativeHostedProviderAttachment?: unknown;
}): NativeProviderAttachment | undefined {
  const hosted = requireHostedProviderAttachment(
    selection.nativeHostedProviderAttachment,
    selection.provider,
  );
  if (selection.nativeNvidiaProviderAttachment !== undefined) {
    const nvidia = normalizeNativeNvidiaProviderAttachment(
      selection.nativeNvidiaProviderAttachment,
    );
    if (!nvidia || selection.provider?.trim() !== NVIDIA_HOSTED_LOGICAL_PROVIDER || hosted) {
      throw new Error("Invalid native provider attachment for the recorded inference selection");
    }
    return nvidia;
  }
  return hosted;
}
