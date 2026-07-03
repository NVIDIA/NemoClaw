// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function recordDeepAgentsRuntimeCall(
  args: string[],
  calls: string[],
  probeVersion: string | null,
): string {
  calls.push(args.join(" "));
  const call = calls[calls.length - 1] || "";
  const command = args[args.length - 1] || "";
  if (call.includes("NEMOCLAW_AGENT_BINARY_CHECK")) {
    return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
  }
  // The version-drift probe (#6193) runs a plain `dcode --version` (not the
  // smoke wrapper). Real `dcode --version` output carries no smoke-exit marker,
  // so only the smoke-wrapped invocation appends one.
  if (command.includes("dcode --version") && !args.includes("nemoclaw-agent-smoke")) {
    return probeVersion ? `dcode ${probeVersion}` : "";
  }
  if (command.includes("dcode --version")) {
    return `dcode ${probeVersion ?? "0.1.30"}\nNEMOCLAW_AGENT_SMOKE_EXIT:0`;
  }
  if (command.includes("/sandbox/.deepagents/config.toml")) {
    return "NEMOCLAW_DEEPAGENTS_CONFIG_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  return "";
}

export function recordSuccessfulDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  return recordDeepAgentsRuntimeCall(args, calls, "0.1.30");
}

// Like recordSuccessfulDeepAgentsRuntimeCall, but the plain version-drift
// probe reports 0.0.1 — below the manifest's expected_version — so the smoke
// passes yet the version gate fails (#6193).
export function recordDriftedDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  return recordDeepAgentsRuntimeCall(args, calls, "0.0.1");
}

// Smoke remains healthy, but the follow-up version probe yields no output.
export function recordUnverifiedDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  return recordDeepAgentsRuntimeCall(args, calls, null);
}

export function recordFailingDeepAgentsSmokeCall(args: string[]): string {
  return args.join(" ").includes("NEMOCLAW_AGENT_BINARY_CHECK")
    ? "NEMOCLAW_AGENT_BINARY_CHECK:ok"
    : "dcode provider route failed\nNEMOCLAW_AGENT_SMOKE_EXIT:42";
}
