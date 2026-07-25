// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "./agent/defs";
import { ConnectionInfoCommandError, runConnectionInfoCommand } from "./connection-info-command";
import type { SandboxEntry } from "./state/registry";

function entry(overrides: Partial<SandboxEntry> & { name: string }): SandboxEntry {
  return overrides as SandboxEntry;
}

describe("connection info command (#7473)", () => {
  it("reprints the connection block for a running OpenClaw sandbox", () => {
    const printDashboard = vi.fn();
    const fetchToken = vi.fn(() => "secret-token");
    const loadAgent = vi.fn();

    runConnectionInfoCommand("alpha", {
      getSandbox: () =>
        entry({ name: "alpha", agent: "openclaw", model: "llama", provider: "nvidia" }),
      fetchToken,
      loadAgent,
      isTerminalAgent: () => false,
      printDashboard,
      log: vi.fn(),
    });

    expect(fetchToken).toHaveBeenCalledWith("alpha");
    expect(loadAgent).not.toHaveBeenCalled();
    expect(printDashboard).toHaveBeenCalledWith("alpha", "llama", "nvidia", null, null, true);
  });

  it("fails clearly when the OpenClaw gateway token cannot be read", () => {
    const printDashboard = vi.fn();
    let caught: ConnectionInfoCommandError | null = null;
    try {
      runConnectionInfoCommand("alpha", {
        getSandbox: () => entry({ name: "alpha", agent: "openclaw", model: "m", provider: "p" }),
        fetchToken: () => null,
        loadAgent: vi.fn(),
        isTerminalAgent: () => false,
        printDashboard,
        log: vi.fn(),
      });
    } catch (error) {
      caught = error as ConnectionInfoCommandError;
    }

    expect(caught).toBeInstanceOf(ConnectionInfoCommandError);
    expect(caught?.lines.join("\n")).toContain("Make sure the sandbox is running");
    expect(printDashboard).not.toHaveBeenCalled();
  });

  it("fails when the sandbox does not exist", () => {
    expect(() =>
      runConnectionInfoCommand("ghost", {
        getSandbox: () => null,
        fetchToken: vi.fn(),
        loadAgent: vi.fn(),
        isTerminalAgent: () => false,
        printDashboard: vi.fn(),
        log: vi.fn(),
      }),
    ).toThrow(/does not exist/);
  });

  it("passes the resolved agent definition for a non-OpenClaw gateway sandbox without a token pre-check", () => {
    const printDashboard = vi.fn();
    const fetchToken = vi.fn(() => null);
    const agentDef = { displayName: "Hermes" } as unknown as AgentDefinition;
    const loadAgent = vi.fn(() => agentDef);

    runConnectionInfoCommand("beta", {
      getSandbox: () => entry({ name: "beta", agent: "hermes", model: "m2", provider: "p2" }),
      fetchToken,
      loadAgent,
      isTerminalAgent: () => false,
      printDashboard,
      log: vi.fn(),
    });

    expect(loadAgent).toHaveBeenCalledWith("hermes");
    expect(fetchToken).not.toHaveBeenCalled();
    expect(printDashboard).toHaveBeenCalledWith("beta", "m2", "p2", null, agentDef, true);
  });

  it("prints the terminal connect block for a terminal-runtime sandbox", () => {
    const printDashboard = vi.fn();
    const fetchToken = vi.fn();
    const out: string[] = [];
    const agentDef = {
      displayName: "Deep Agents Code",
      runtime: { kind: "terminal", interactive_command: "dcode" },
    } as unknown as AgentDefinition;

    runConnectionInfoCommand("gamma", {
      getSandbox: () => entry({ name: "gamma", agent: "deepagents", model: "m3", provider: "p3" }),
      fetchToken,
      loadAgent: () => agentDef,
      isTerminalAgent: () => true,
      printDashboard,
      log: (message: string) => out.push(message),
    });

    const output = out.join("\n");
    expect(output).toContain("nemoclaw gamma connect");
    expect(output).toContain("then run: dcode");
    expect(printDashboard).not.toHaveBeenCalled();
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it("renders best-effort when a legacy entry has no recorded model or provider", () => {
    const printDashboard = vi.fn();

    runConnectionInfoCommand("legacy", {
      getSandbox: () => entry({ name: "legacy", agent: "openclaw" }),
      fetchToken: () => "token",
      loadAgent: vi.fn(),
      isTerminalAgent: () => false,
      printDashboard,
      log: vi.fn(),
    });

    expect(printDashboard).toHaveBeenCalledWith("legacy", "", "", null, null, true);
  });
});
