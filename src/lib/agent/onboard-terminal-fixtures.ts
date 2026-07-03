// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function recordSuccessfulDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  calls.push(args.join(" "));
  const call = calls[calls.length - 1] || "";
  const command = args[args.length - 1] || "";
  if (call.includes("NEMOCLAW_AGENT_BINARY_CHECK")) {
    return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
  }
  // The version-drift probe (#6193) runs a plain `dcode --version` (not the
  // smoke wrapper). Real `dcode --version` output carries no smoke-exit marker,
  // so only the smoke-wrapped invocation appends one.
  if (command.includes("dcode --version") && !call.includes("nemoclaw-agent-smoke")) {
    return "dcode 0.1.12";
  }
  if (command.includes("dcode --version")) {
    return "dcode 0.1.12\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  if (command.includes("/sandbox/.deepagents/config.toml")) {
    return "NEMOCLAW_DEEPAGENTS_CONFIG_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  return "";
}

// Like recordSuccessfulDeepAgentsRuntimeCall, but the plain version-drift
// probe reports 0.0.1 — below the manifest's expected_version — so the smoke
// passes yet the drift check fires (#6193).
export function recordDriftedDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  calls.push(args.join(" "));
  const call = calls[calls.length - 1] || "";
  const command = args[args.length - 1] || "";
  if (call.includes("NEMOCLAW_AGENT_BINARY_CHECK")) {
    return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
  }
  if (command.includes("dcode --version") && !call.includes("nemoclaw-agent-smoke")) {
    return "dcode 0.0.1";
  }
  if (command.includes("dcode --version")) {
    return "dcode 0.0.1\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  if (command.includes("/sandbox/.deepagents/config.toml")) {
    return "NEMOCLAW_DEEPAGENTS_CONFIG_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  return "";
}

export function recordFailingDeepAgentsSmokeCall(args: string[]): string {
  return args.join(" ").includes("NEMOCLAW_AGENT_BINARY_CHECK")
    ? "NEMOCLAW_AGENT_BINARY_CHECK:ok"
    : "dcode provider route failed\nNEMOCLAW_AGENT_SMOKE_EXIT:42";
}
