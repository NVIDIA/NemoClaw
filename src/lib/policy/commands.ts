// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildOpenshellCommand } from "../adapters/openshell/command-argv";

export function buildPolicySetCommand(
  policyFile: string,
  sandboxName: string,
  gatewayName?: string,
): string[] {
  return buildOpenshellCommand([
    "policy",
    "set",
    ...policyGatewayArgs(gatewayName),
    "--policy",
    policyFile,
    "--wait",
    sandboxName,
  ]);
}

function policyGatewayArgs(gatewayName?: string): string[] {
  return gatewayName ? ["-g", gatewayName] : [];
}
