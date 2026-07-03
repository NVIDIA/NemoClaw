// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
const sourceNodeOptions = [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
  .filter(Boolean)
  .join(" ");
const tempHomes = new Set<string>();

function createTempHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempHomes.add(home);
  return home;
}

afterEach(() => {
  tempHomes.forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  tempHomes.clear();
});

describe("cross-agent MCP removal", () => {
  it("removes a persisted bridge without requiring the current agent to support MCP", () => {
    const home = createTempHome("nemoclaw-mcp-remove-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
agentDefs.loadAgent = () => { throw new Error("current agent must not be consulted"); };
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  if (args.join(" ") === "status --output json") {
    return {
      status: 0,
      stdout: "ready",
      stderr: "",
    };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
policies.removePreset = () => true;
policies.getPresetContentGatewayState = () => "absent";
processRecovery.executeSandboxCommand = () => ({ status: 0, stdout: "", stderr: "" });
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "", stderr: "" });
registry.registerSandbox({
  name: "legacy-sandbox",
  agent: "legacy-disabled",
  mcp: { bridges: { github: {
    server: "github",
    url: "https://host.openshell.internal:31337/mcp",
    env: [],
    policyName: "mcp-bridge-github",
    adapter: "mcporter",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
registry.addCustomPolicy("legacy-sandbox", {
  name: "mcp-bridge-github",
  content: "network_policies:\\n  mcp_bridge_github:\\n    endpoints: []\\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
  appliedAt: "2026-06-01T00:00:00.000Z",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("legacy-sandbox", "github").then(
  () => {
    process.stdout.write(JSON.stringify(registry.getSandbox("legacy-sandbox")));
    process.exit(0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const jsonStart = result.stdout.indexOf("{");
    const sandbox = JSON.parse(result.stdout.slice(jsonStart)) as {
      mcp?: { bridges?: Record<string, unknown>; managedServerNames?: string[] };
    };
    expect(sandbox.mcp).toEqual({
      bridges: {},
      managedServerNames: ["github"],
    });
  });

  it("preserves the registry entry when force cleanup leaves residual policy state", () => {
    const home = createTempHome("nemoclaw-mcp-residual-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
agentDefs.loadAgent = () => { throw new Error("current agent must not be consulted"); };
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  if (args.join(" ") === "status --output json") {
    return {
      status: 0,
      stdout: "ready",
      stderr: "",
    };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
policies.removePreset = () => false;
policies.getPresetContentGatewayState = () => "match";
processRecovery.executeSandboxCommand = () => ({ status: 0, stdout: "", stderr: "" });
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "", stderr: "" });
registry.registerSandbox({
  name: "legacy-sandbox",
  agent: "legacy-disabled",
  mcp: { bridges: { github: {
    server: "github",
    url: "https://mcp.example.test/mcp",
    env: [],
    policyName: "mcp-bridge-github",
    adapter: "mcporter",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
registry.addCustomPolicy("legacy-sandbox", {
  name: "mcp-bridge-github",
  content: "network_policies:\\n  mcp_bridge_github:\\n    name: managed\\n    endpoints: []\\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
  appliedAt: "2026-06-01T00:00:00.000Z",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("legacy-sandbox", "github", { force: true }).then(
  () => process.exit(1),
  (error) => {
    process.stdout.write(JSON.stringify({
      message: error.message,
      sandbox: registry.getSandbox("legacy-sandbox"),
    }));
    process.exit(0);
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status).toBe(0);
    const jsonStart = result.stdout.indexOf("{");
    const payload = JSON.parse(result.stdout.slice(jsonStart)) as {
      message: string;
      sandbox: { mcp?: { bridges?: Record<string, unknown> } };
    };
    expect(payload.message).toContain("registry entry was preserved");
    expect(payload.sandbox.mcp?.bridges).toHaveProperty("github");
  });
});
