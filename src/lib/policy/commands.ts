// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Late binding keeps tests able to replace the resolver without rewiring
// command builders that are shared by policy and Shields flows.
const openshellResolveModule =
  require("../adapters/openshell/resolve") as typeof import("../adapters/openshell/resolve");

function resolveOpenshellBinary(): string {
  return openshellResolveModule.resolveOpenshell() ?? "openshell";
}

export function buildPolicySetCommand(policyFile: string, sandboxName: string): string[] {
  return [resolveOpenshellBinary(), "policy", "set", "--policy", policyFile, "--wait", sandboxName];
}

/** Read the round-trippable base policy before a mutation. */
export function buildPolicyGetCommand(sandboxName: string): string[] {
  return [resolveOpenshellBinary(), "policy", "get", "--base", sandboxName];
}

/** Read the effective policy for status and other diagnostics. */
export function buildPolicyGetFullCommand(sandboxName: string): string[] {
  return [resolveOpenshellBinary(), "policy", "get", "--full", sandboxName];
}
