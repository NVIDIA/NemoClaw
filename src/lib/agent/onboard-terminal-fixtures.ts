// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function recordDeepAgentsRuntimeCall(
  args: string[],
  calls: string[],
  probeOutput: string,
  smokeVersion = "0.1.34",
): string {
  calls.push(args.join(" "));
  const separatorIndex = args.indexOf("--");
  const sandboxArgv = args.slice(separatorIndex + 1);
  const command = sandboxArgv.at(-1) ?? "";
  const smokeWrapped = sandboxArgv.at(-2) === "nemoclaw-agent-smoke";
  if (command.includes("NEMOCLAW_AGENT_BINARY_CHECK")) {
    return "NEMOCLAW_AGENT_BINARY_CHECK:ok";
  }
  // The version-drift probe (#6193) runs a plain `dcode --version` (not the
  // smoke wrapper). Real `dcode --version` output carries no smoke-exit marker,
  // so only the smoke-wrapped invocation appends one.
  if (command.includes("dcode --version") && !smokeWrapped) {
    return probeOutput;
  }
  if (command.includes("dcode --version")) {
    return `dcode ${smokeVersion}\nNEMOCLAW_AGENT_SMOKE_EXIT:0`;
  }
  if (command.includes("NEMOCLAW_DCODE_EMPTY_PROMPT_OK")) {
    return "NEMOCLAW_DCODE_EMPTY_PROMPT_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  if (command.includes("/sandbox/.deepagents/config.toml")) {
    return "NEMOCLAW_DEEPAGENTS_CONFIG_OK\nNEMOCLAW_AGENT_SMOKE_EXIT:0";
  }
  return "";
}

export function recordSuccessfulDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  return recordDeepAgentsRuntimeCall(args, calls, "dcode 0.1.34");
}

// Like recordSuccessfulDeepAgentsRuntimeCall, but the plain version-drift
// probe reports 0.0.1 — below the manifest's expected_version — so the smoke
// passes yet the version gate fails (#6193).
export function recordDriftedDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  return recordDeepAgentsRuntimeCall(args, calls, "dcode 0.0.1", "0.0.1");
}

// Smoke remains healthy, but the follow-up version probe yields no output.
export function recordUnverifiedDeepAgentsRuntimeCall(args: string[], calls: string[]): string {
  return recordDeepAgentsRuntimeCall(args, calls, "");
}

// Smoke remains healthy, but the probe has only an unrelated version before a
// dcode error. The command-aware parser must not attribute Python's version to dcode.
export function recordUnrelatedVersionDeepAgentsRuntimeCall(
  args: string[],
  calls: string[],
): string {
  return recordDeepAgentsRuntimeCall(args, calls, "Python 3.12.0\ndcode command failed");
}

export function recordFailingDeepAgentsSmokeCall(args: string[]): string {
  const command = args.slice(args.indexOf("--") + 1).at(-1) ?? "";
  return command.includes("NEMOCLAW_AGENT_BINARY_CHECK")
    ? "NEMOCLAW_AGENT_BINARY_CHECK:ok"
    : "dcode provider route failed\nNEMOCLAW_AGENT_SMOKE_EXIT:42";
}
