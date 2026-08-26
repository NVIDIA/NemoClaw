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

/** Read the round-trippable base policy before a mutation. */
export function buildPolicyGetCommand(sandboxName: string, gatewayName?: string): string[] {
  return buildOpenshellCommand([
    "policy",
    "get",
    ...policyGatewayArgs(gatewayName),
    "--base",
    sandboxName,
  ]);
}

/** Read the effective policy for status and other diagnostics. */
export function buildPolicyGetFullCommand(sandboxName: string, gatewayName?: string): string[] {
  return buildOpenshellCommand([
    "policy",
    "get",
    ...policyGatewayArgs(gatewayName),
    "--full",
    sandboxName,
  ]);
}

function policyGatewayArgs(gatewayName?: string): string[] {
  return gatewayName ? ["-g", gatewayName] : [];
}

/** Read effective sandbox policy and its authority metadata as JSON. */
export function buildPolicyGetFullJsonCommand(sandboxName: string, gatewayName?: string): string[] {
  return buildOpenshellCommand([
    "policy",
    "get",
    ...policyGatewayArgs(gatewayName),
    "--full",
    "--output",
    "json",
    sandboxName,
  ]);
}

/** Read the global policy and its authority metadata as JSON. */
export function buildGlobalPolicyGetFullJsonCommand(gatewayName?: string): string[] {
  return buildOpenshellCommand([
    "policy",
    "get",
    ...policyGatewayArgs(gatewayName),
    "--global",
    "--full",
    "--output",
    "json",
  ]);
}

/** Check whether the global policy has revision history. */
export function buildGlobalPolicyListCommand(gatewayName?: string): string[] {
  return buildOpenshellCommand([
    "policy",
    "list",
    ...policyGatewayArgs(gatewayName),
    "--global",
    "--limit",
    "1",
  ]);
}
