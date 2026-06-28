// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "./defs";
import { loadAgent } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import {
  buildManualRecoveryCommand,
  buildRecoveryScript,
  getTerminalCommand,
  TERMINAL_AGENT_RECOVERY_SCRIPT,
} from "./runtime";

const terminalAgent = {
  name: "terminal-agent",
  displayName: "Terminal Agent",
  runtime: {
    kind: "terminal",
    interactive_command: "terminal-agent",
    headless_command: "terminal-agent -n",
  },
  gateway_command: undefined,
} as AgentDefinition;

describe("terminal agent runtime helpers", () => {
  it("returns an explicit terminal sentinel for agents without a gateway process", () => {
    expect(buildRecoveryScript(terminalAgent, 18789)).toBe(TERMINAL_AGENT_RECOVERY_SCRIPT);
  });

  it("resolves terminal launch commands without synthesizing gateway recovery", () => {
    expect(getTerminalCommand(terminalAgent)).toBe("terminal-agent");
    expect(getTerminalCommand(terminalAgent, "headless")).toBe("terminal-agent -n");
    expect(buildManualRecoveryCommand(terminalAgent, 18789)).toBe("terminal-agent");
  });

  it("resolves Deep Agents Code interactive and headless commands from the real manifest", () => {
    const deepAgentsCode = loadAgent("langchain-deepagents-code");

    expect(getTerminalCommand(deepAgentsCode, "interactive")).toBe("dcode");
    expect(getTerminalCommand(deepAgentsCode, "headless")).toBe("dcode -n");
    expect(buildManualRecoveryCommand(deepAgentsCode, 18789)).toBe("dcode");
  });
});
