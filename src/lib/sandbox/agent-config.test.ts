// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { AgentStateLockPlan } from "../agent/definition-types";
import {
  type AgentConfigDependencies,
  resolveAgentConfig,
  resolveAgentStateLockContract,
} from "./agent-config";

const PLAN: AgentStateLockPlan = {
  version: 1,
  readOnlyRoots: ["skills"],
  confidentialRoots: [],
  readOnlyPrefixes: [],
  confidentialPrefixes: [],
  writableSubpaths: [],
};

function openClawAgent() {
  return {
    configPaths: {
      dir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      envFile: null,
      format: "json",
      shieldsFiles: [],
    },
    stateLockPlan: PLAN,
    stateLockPlanInImage: true,
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
  it("loads the state lock contract for an explicit agent", () => {
    const loadAgent = vi.fn(() => openClawAgent());

    expect(resolveAgentStateLockContract("openclaw", loadAgent)).toEqual({
      stateLockPlan: PLAN,
      stateLockPlanInImage: true,
    });
    expect(loadAgent).toHaveBeenCalledWith("openclaw");
  });

  it("loads the OpenClaw contract when no agent is registered", () => {
    const loadAgent = vi.fn(() => openClawAgent());

    expect(resolveAgentConfig("alpha", dependencies({ loadAgent }))).toEqual({
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      format: "json",
      configFile: "openclaw.json",
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
      stateLockPlan: PLAN,
      stateLockPlanInImage: true,
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
      { dir: "/etc", configFile: "config.yaml", envFile: ".env", shieldsFiles: [] },
      /canonical absolute path below \/sandbox\//,
    ],
    [
      "the shared sandbox root as a config directory",
      { dir: "/sandbox/", configFile: "config.yaml", envFile: ".env", shieldsFiles: [] },
      /canonical absolute path below \/sandbox\//,
    ],
    [
      "a traversing config file",
      {
        dir: "/sandbox/.hermes",
        configFile: "../config.yaml",
        envFile: ".env",
        shieldsFiles: [],
      },
      /config_file.*canonical relative path/,
    ],
    [
      "a traversing sensitive env file",
      {
        dir: "/sandbox/.hermes",
        configFile: "config.yaml",
        envFile: "../../host.env",
        shieldsFiles: [],
      },
      /env_file.*canonical relative path/,
    ],
    [
      "an empty sensitive env file",
      {
        dir: "/sandbox/.hermes",
        configFile: "config.yaml",
        envFile: "",
        shieldsFiles: [],
      },
      /env_file.*canonical relative path/,
    ],
  ])("rejects %s before constructing privileged paths", (_case, configPaths, expected) => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({ configPaths, stateLockPlan: PLAN, stateLockPlanInImage: true })),
    });

    expect(() => resolveAgentConfig("alpha", deps)).toThrow(expected);
  });

  it("resolves Hermes config paths and sensitive files", () => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({
        configPaths: {
          dir: "/sandbox/.hermes",
          configFile: "config.yaml",
          envFile: ".secrets",
          format: "yaml",
          shieldsFiles: [".secrets"],
        },
        stateLockPlan: PLAN,
        stateLockPlanInImage: true,
      })),
    });

    expect(resolveAgentConfig("alpha", deps)).toEqual({
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      format: "yaml",
      configFile: "config.yaml",
      sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.secrets"],
      stateLockPlan: PLAN,
      stateLockPlanInImage: true,
    });
  });

  it("does not require an optional environment file unless the manifest protects it", () => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "langchain-deepagents-code" })),
      loadAgent: vi.fn(() => ({
        configPaths: {
          dir: "/sandbox/.deepagents",
          configFile: "config.toml",
          envFile: ".env",
          format: "toml",
          shieldsFiles: [],
        },
        stateLockPlan: PLAN,
        stateLockPlanInImage: false,
      })),
    });

    expect(resolveAgentConfig("alpha", deps).sensitiveFiles).toEqual([
      "/sandbox/.deepagents/.config-hash",
    ]);
  });

  it.each([
    ["a traversing Shields file", ["../secrets"], /shields_files\[0\].*canonical relative path/],
    ["an absolute Shields file", ["/etc/shadow"], /shields_files\[0\].*canonical relative path/],
    ["a control character in a Shields file", ["secret\0file"], /canonical relative path/],
    ["the primary config file", ["config.yaml"], /duplicates a protected config file/],
    ["the config hash twice", [".config-hash"], /duplicates a protected config file/],
    ["a repeated Shields file", [".env", ".env"], /duplicates a protected config file/],
  ])("rejects %s", (_case, shieldsFiles, expected) => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({
        configPaths: {
          dir: "/sandbox/.hermes",
          configFile: "config.yaml",
          envFile: ".env",
          format: "yaml",
          shieldsFiles,
        },
        stateLockPlan: PLAN,
        stateLockPlanInImage: true,
      })),
    });

    expect(() => resolveAgentConfig("alpha", deps)).toThrow(expected);
  });

  it.each([
    ["a missing config.shields_files declaration", undefined],
    ["a non-string config.shields_files declaration", [42]],
  ])("fails closed for %s", (_case, shieldsFiles) => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "hermes" })),
      loadAgent: vi.fn(() => ({
        configPaths: {
          dir: "/sandbox/.hermes",
          configFile: "config.yaml",
          envFile: ".env",
          format: "yaml",
          shieldsFiles: shieldsFiles as unknown as string[],
        },
        stateLockPlan: PLAN,
        stateLockPlanInImage: true,
      })),
    });

    expect(() => resolveAgentConfig("alpha", deps)).toThrow(/config\.shields_files.*string array/);
  });

  it("rejects protected top-level files for agents without a descriptor-safe transaction", () => {
    const deps = dependencies({
      getSandbox: vi.fn(() => ({ agent: "langchain-deepagents-code" })),
      loadAgent: vi.fn(() => ({
        configPaths: {
          dir: "/sandbox/.deepagents",
          configFile: "config.toml",
          envFile: ".env",
          format: "toml",
          shieldsFiles: [".env"],
        },
        stateLockPlan: PLAN,
        stateLockPlanInImage: false,
      })),
    });

    expect(() => resolveAgentConfig("alpha", deps)).toThrow(/supported only for Hermes/);
  });
});
