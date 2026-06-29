// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../../core/ports";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import * as registry from "../../state/registry";

export function getSandboxTargetGatewayName(sandboxName = ""): string {
  const sb = sandboxName ? registry.getSandbox(sandboxName) : null;
  return sb ? resolveSandboxGatewayName(sb) : resolveGatewayName(GATEWAY_PORT);
}

export function gatewayNamePattern(gatewayName: string): RegExp {
  return new RegExp(
    `Gateway:\\s+${gatewayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
    "i",
  );
}
