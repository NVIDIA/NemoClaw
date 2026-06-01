// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw's OpenShell gateway name resolver.
 *
 * NemoClaw currently runs a singleton gateway: every onboard uses the literal
 * `"nemoclaw"` name regardless of which port the gateway binds to. That
 * invariant makes concurrent NemoClaw instances on a single host impossible
 * — changing the gateway port relocates the singleton instead of spawning a
 * second instance.
 *
 * This module owns the canonical name and exposes a `port`-aware resolver so
 * follow-up work can derive per-port names (e.g. `"nemoclaw-8081"`) without
 * touching every call site again. Until that work lands, `getGatewayName`
 * returns the singleton name for every port.
 */

export const DEFAULT_GATEWAY_NAME = "nemoclaw";

export function getGatewayName(_port: number): string {
  return DEFAULT_GATEWAY_NAME;
}
