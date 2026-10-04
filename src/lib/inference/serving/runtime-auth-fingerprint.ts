// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";

const RUNTIME_AUTH_FINGERPRINT_DOMAIN = "nemoclaw.host-local-runtime-auth/v1";

/** Derive a domain-separated runtime identity label from a high-entropy API key. */
export function runtimeAuthFingerprint(apiKey: string): string {
  return createHmac("sha256", apiKey).update(RUNTIME_AUTH_FINGERPRINT_DOMAIN).digest("hex");
}
