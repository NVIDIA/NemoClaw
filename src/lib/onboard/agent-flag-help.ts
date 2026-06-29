// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatAgentAliasSuffix } from "../agent/aliases";

// Build the `--agent` flag help. Listing the installed agent runtimes inline
// means users don't have to discover valid names by triggering an error (#5779).
// Kept dependency-free so it stays trivially testable without the agent
// registry / runner import chain.
export function describeAgentFlag(agents: readonly string[]): string {
  const names = agents.filter((name) => typeof name === "string" && name.length > 0);
  const aliasSuffix = formatAgentAliasSuffix(names);
  if (names.length === 0) {
    return aliasSuffix ? `Agent runtime to onboard${aliasSuffix}` : "Agent runtime to onboard";
  }
  return aliasSuffix
    ? `Agent runtime to onboard (${names.join(", ")}${aliasSuffix.replace(" (", "; ")}`
    : `Agent runtime to onboard (${names.join(", ")})`;
}
