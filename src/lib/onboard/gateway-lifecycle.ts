// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayLifecycle } from "../adapters/openshell/gateway-lifecycle";

export function gatewayCliSupportsLifecycleCommands(
  lifecycle: OpenShellGatewayLifecycle,
  gatewayName: string,
): Promise<boolean> {
  return lifecycle.supportsLegacyLifecycle({ target: { kind: "named", gatewayName } });
}
