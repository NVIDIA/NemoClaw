// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import {
  buildHermesMcpExecArgs,
  buildHermesMcpProbeCommand,
  buildHermesMcpRegisterCommand,
} from "./mcp-bridge-adapter-hermes";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("Hermes MCP config adapter", () => {
  it("constructs a Hermes config registration with placeholders", () => {
    const command = buildHermesMcpRegisterCommand(baseEntry);

    expect(command.slice(0, 3)).toEqual([
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "add",
      "--payload",
    ]);
    expect(JSON.parse(command[3] ?? "{}")).toEqual({
      server: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
      replace_existing: false,
    });
    expect(buildHermesMcpExecArgs("hermes-box", command)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-box",
      "--timeout",
      "620",
      "--no-tty",
      "--",
      ...command,
    ]);
    expect(buildHermesMcpProbeCommand()).toEqual([
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "probe",
    ]);
    expect(buildHermesMcpExecArgs("hermes-box", buildHermesMcpProbeCommand(), 30)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-box",
      "--timeout",
      "30",
      "--no-tty",
      "--",
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "probe",
    ]);
  });
});
