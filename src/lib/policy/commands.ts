// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildOpenshellCommand } from "../adapters/openshell/command-argv";

export function buildPolicySetCommand(policyFile: string, sandboxName: string): string[] {
  return buildOpenshellCommand(["policy", "set", "--policy", policyFile, "--wait", sandboxName]);
}

/** Read the round-trippable base policy before a mutation. */
export function buildPolicyGetCommand(sandboxName: string): string[] {
  return buildOpenshellCommand(["policy", "get", "--base", sandboxName]);
}

/** Read the effective policy for status and other diagnostics. */
export function buildPolicyGetFullCommand(sandboxName: string): string[] {
  return buildOpenshellCommand(["policy", "get", "--full", sandboxName]);
}
