// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";

/**
 * Clone a canonical, secret-free provider-neutral receipt. The state boundary
 * validates the complete schema before accepting durable authority.
 */
export function cloneSandboxHostLocalInferenceReceipt(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  try {
    return serializeHostLocalInferenceReceipt(parseHostLocalInferenceReceipt(value));
  } catch {
    return undefined;
  }
}
