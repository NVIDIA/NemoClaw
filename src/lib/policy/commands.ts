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

/** Read the active global policy and its authority metadata as JSON. */
export function buildGlobalPolicyGetFullJsonArgs(gatewayName?: string): string[] {
  return [
    "policy",
    "get",
    ...policyGatewayArgs(gatewayName),
    "--global",
    "--full",
    "--output",
    "json",
  ];
}

/** Check whether the global policy has revision history. */
export function buildGlobalPolicyListArgs(gatewayName?: string): string[] {
  return ["policy", "list", ...policyGatewayArgs(gatewayName), "--global", "--limit", "1"];
}
