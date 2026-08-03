// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "./defs";
import { loadAgent } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import {
  buildRecoveryScript,
  getInteractiveAgentCommand,
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
  });

  it("resolves Deep Agents Code interactive and headless commands from the real manifest", () => {
    const deepAgentsCode = loadAgent("langchain-deepagents-code");

    expect(getTerminalCommand(deepAgentsCode, "interactive")).toBe("dcode");
    expect(getTerminalCommand(deepAgentsCode, "headless")).toBe("dcode -n");
  });
});

describe("interactive agent command resolution", () => {
  it("reads the manifest interactive command for a terminal agent", () => {
    expect(
      getInteractiveAgentCommand(
        loadAgent("langchain-deepagents-code"),
        "langchain-deepagents-code",
      ),
    ).toBe("dcode");
  });

  it("falls back to the OpenClaw TUI when no agent definition is loaded", () => {
    expect(getInteractiveAgentCommand(null, "openclaw")).toBe("openclaw tui");
    expect(getInteractiveAgentCommand(null, null)).toBe("openclaw tui");
    expect(getInteractiveAgentCommand(null, undefined)).toBe("openclaw tui");
  });

  it("rejects an untrusted agent name when no agent definition is loaded", () => {
    expect(() => getInteractiveAgentCommand(null, "mystery-agent; echo pwned")).toThrow(
      'Cannot resolve an interactive command for unsupported agent "mystery-agent; echo pwned".',
    );
  });

  // runtime-manifest.ts accepts a terminal agent declaring only
  // headless_command. Without this fallback the resolver would return the
  // agent slug and `launch` would run a command that does not exist.
  it("falls back to the manifest headless command when no interactive command is declared", () => {
    const headlessOnly = {
      name: "headless-only",
      runtime: { kind: "terminal", headless_command: "runner -n" },
    } as unknown as AgentDefinition;

    expect(getInteractiveAgentCommand(headlessOnly, "headless-only")).toBe("runner -n");
  });

  // The gateway manifests must carry the interactive command themselves. The
  // resolver fallback returns the same strings, so asserting only the resolver
  // would stay green with the declarations missing.
  it("declares the interactive command on the gateway agent manifests", () => {
    expect(loadAgent("openclaw").runtime?.interactive_command).toBe("openclaw tui");
    expect(loadAgent("hermes").runtime?.interactive_command).toBe("hermes");
  });

  it("reads the manifest interactive command for gateway agents", () => {
    expect(getInteractiveAgentCommand(loadAgent("openclaw"), "openclaw")).toBe("openclaw tui");
    expect(getInteractiveAgentCommand(loadAgent("hermes"), "hermes")).toBe("hermes");
  });

  // Regression guard: declaring runtime.interactive_command must not promote a
  // gateway agent to terminal behaviour for getTerminalCommand's four callers.
  it("leaves getTerminalCommand returning null for gateway agents", () => {
    for (const name of ["openclaw", "hermes"]) {
      const agent = loadAgent(name);
      expect(agent.runtime?.kind).toBe("gateway");
      expect(getTerminalCommand(agent, "interactive")).toBeNull();
      expect(getTerminalCommand(agent, "headless")).toBeNull();
    }
  });
});
