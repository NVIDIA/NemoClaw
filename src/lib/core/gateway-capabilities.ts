// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Gateway capabilities implemented by this NemoClaw build.
 *
 * This domain allowlist is shared by declaration parsing, runtime ownership
 * checks, and durable checkpoint validation. Keeping it in core prevents state
 * restoration from depending on onboarding orchestration.
 */
export const SUPPORTED_GATEWAY_CAPABILITIES = [
  "gateway.health",
  "sandbox.create",
  "sandbox.exec",
  "gpu.passthrough",
] as const;

export type GatewayCapability = (typeof SUPPORTED_GATEWAY_CAPABILITIES)[number];
