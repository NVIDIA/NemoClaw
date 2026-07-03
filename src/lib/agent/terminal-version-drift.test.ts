// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./defs";
import {
  detectTerminalAgentVersionDrift,
  formatTerminalAgentVersionDriftWarning,
} from "./terminal-version-drift";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    versionCommand: "dcode --version",
    expectedVersion: "0.1.13",
    versionScheme: "semver",
    ...overrides,
  } as unknown as AgentDefinition;
}

describe("detectTerminalAgentVersionDrift (#6193)", () => {
  it("flags drift when the installed version is below expected_version", () => {
    const runner = vi.fn(() => "LangChain Deep Agents Code v0.1.12");
    const drift = detectTerminalAgentVersionDrift("dcode-sb", makeAgent(), runner);
    expect(drift).toEqual({
      installedVersion: "0.1.12",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
    // Probes through the injected OpenShell runner, not a direct SSH spawn.
    expect(runner).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "dcode-sb", "--", "sh", "-lc", "dcode --version"],
      { ignoreError: true },
    );
  });

  it("returns null when the installed version meets expected_version", () => {
    const runner = vi.fn(() => "dcode v0.1.13");
    expect(detectTerminalAgentVersionDrift("dcode-sb", makeAgent(), runner)).toBeNull();
  });

  it("returns null when the installed version exceeds expected_version", () => {
    const runner = vi.fn(() => "dcode v0.2.0");
    expect(detectTerminalAgentVersionDrift("dcode-sb", makeAgent(), runner)).toBeNull();
  });

  it("returns null (no gate) when the manifest declares no expected_version", () => {
    const runner = vi.fn(() => "dcode v0.1.12");
    const agent = makeAgent({ expectedVersion: null } as Partial<AgentDefinition>);
    expect(detectTerminalAgentVersionDrift("dcode-sb", agent, runner)).toBeNull();
  });

  it("returns null when the probe output has no parseable version", () => {
    const runner = vi.fn(() => "command not found");
    expect(detectTerminalAgentVersionDrift("dcode-sb", makeAgent(), runner)).toBeNull();
  });

  it("accepts the { output } runner result shape", () => {
    const runner = vi.fn(() => ({ output: "dcode v0.1.12" }));
    const drift = detectTerminalAgentVersionDrift("dcode-sb", makeAgent(), runner);
    expect(drift?.installedVersion).toBe("0.1.12");
  });

  it("formats a drift warning naming the display name, installed, and expected versions", () => {
    const line = formatTerminalAgentVersionDriftWarning(makeAgent(), {
      installedVersion: "0.1.12",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
    expect(line).toContain("LangChain Deep Agents Code");
    expect(line).toContain("0.1.12");
    expect(line).toContain("0.1.13");
  });
});
