// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { type AgentConfigDependencies, resolveAgentConfig } from "./agent-config";

function openClawAgent() {
  return {
    configPaths: {
      dir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      envFile: null,
      format: "json",
    },
  };
}

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
  it("loads the OpenClaw contract when no agent is registered", () => {
    const loadAgent = vi.fn(() => openClawAgent());

    expect(resolveAgentConfig("alpha", dependencies({ loadAgent }))).toEqual({
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      format: "json",
      configFile: "openclaw.json",
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
    });
    expect(loadAgent).toHaveBeenCalledWith("openclaw");
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

  it.each([
    [
      "a config directory outside /sandbox",
      { dir: "/etc", configFile: "config.yaml", envFile: ".env", format: "yaml" },
      /canonical absolute path below \/sandbox\//,
    ],
    [
      "the shared sandbox root as a config directory",
      { dir: "/sandbox/", configFile: "config.yaml", envFile: ".env", format: "yaml" },
      /canonical absolute path below \/sandbox\//,
    ],
    [
      "a traversing config file",
      {
        dir: "/sandbox/.hermes",
        configFile: "../config.yaml",
        envFile: ".env",
        format: "yaml",
      },
      /config_file.*canonical relative path/,
    ],
    [
      "a traversing environment file",
      {
        dir: "/sandbox/.hermes",
        configFile: "config.yaml",
        envFile: "../../host.env",
        format: "yaml",
      },
      /env_file.*canonical relative path/,
    ],
    [
      "an empty environment file",
      {
        dir: "/sandbox/.hermes",
        configFile: "config.yaml",
        envFile: "",
        format: "yaml",
      },
      /env_file.*canonical relative path/,
    ],
  ])("rejects %s before constructing privileged paths", (_case, configPaths, expected) => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({ configPaths })),
    });

    expect(() => resolveAgentConfig("alpha", deps)).toThrow(expected);
  });

  it("resolves the config hash and environment file without an immutability contract", () => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({
        configPaths: {
          dir: "/sandbox/.hermes",
          configFile: "config.yaml",
          envFile: ".env",
          format: "yaml",
        },
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
