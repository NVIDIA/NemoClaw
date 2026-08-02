// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  type AgentConfigDependencies,
  DEFAULT_AGENT_CONFIG,
  resolveAgentConfig,
} from "./agent-config";

function dependencies(overrides: Partial<AgentConfigDependencies> = {}): AgentConfigDependencies {
  return {
    getSandbox: vi.fn(() => null),
    loadAgent: vi.fn(() => {
      throw new Error("unexpected agent load");
    }),
    ...overrides,
  };
}

describe("agent config resolution", () => {
  it("uses the legacy OpenClaw target when no agent is registered", () => {
    expect(resolveAgentConfig("alpha", dependencies())).toEqual(DEFAULT_AGENT_CONFIG);
    expect(
      resolveAgentConfig(
        "alpha",
        dependencies({
          getSandbox: vi.fn(() => ({})),
        }),
      ),
    ).toEqual(DEFAULT_AGENT_CONFIG);
  });

  it("propagates a registered agent load failure", () => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => {
        throw new Error("Hermes manifest is invalid");
      }),
    });

    expect(() => resolveAgentConfig("alpha", deps)).toThrow("Hermes manifest is invalid");
  });

  it("resolves Hermes config paths and sensitive files", () => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({
        configPaths: { dir: "/sandbox/.hermes", configFile: "config.yaml", format: "yaml" },
      })),
    });

    expect(resolveAgentConfig("alpha", deps)).toEqual({
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      format: "yaml",
      configFile: "config.yaml",
      sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
    });
  });
});
