// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Build the `--agent` flag help. Listing the installed agent runtimes inline
// means users don't have to discover valid names by triggering an error (#5779).
// Kept dependency-free so it stays trivially testable without the agent
// registry / runner import chain.
export function describeAgentFlag(agents: readonly string[]): string {
  const names = agents.filter((name) => typeof name === "string" && name.length > 0);
  return names.length > 0
    ? `Agent runtime to onboard (${names.join(", ")})`
    : "Agent runtime to onboard";
}
