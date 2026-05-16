// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";

// Docker-driver/package-managed gateways do not expose reusable GPU state
// through the legacy openshell-cluster-* container's DeviceRequests field.
export function shouldInspectLegacyGatewayGpuPassthrough(
  gatewayReuseState: GatewayReuseState,
  gpuPassthrough: boolean,
  dockerDriverGatewayEnabled: boolean,
  gatewayLifecycleCommandsSupported: boolean,
): boolean {
  return (
    gatewayReuseState === "healthy" &&
    gpuPassthrough &&
    !dockerDriverGatewayEnabled &&
    gatewayLifecycleCommandsSupported
  );
}
