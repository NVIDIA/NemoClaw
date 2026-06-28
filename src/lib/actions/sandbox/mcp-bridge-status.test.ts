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
  for (const home of tempHomes) fs.rmSync(home, { recursive: true, force: true });
  tempHomes.clear();
});

describe("cross-agent MCP status", () => {
  it("reports Hermes bridge support in status JSON without requiring servers", () => {
    const home = createTempHome("nemoclaw-mcp-status-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
registry.registerSandbox({ name: "hermes-sandbox", agent: "hermes" });
bridge.dispatchMcpBridgeCommand("hermes-sandbox", ["status", "--json"]).then(
  () => process.exit(0),
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

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as {
      sandbox: string;
      agent: string;
      support: { supported: boolean; mode: string; reason?: string };
      bridges: unknown[];
    };
    expect(payload.sandbox).toBe("hermes-sandbox");
    expect(payload.agent).toBe("hermes");
    expect(payload.support).toMatchObject({
      supported: true,
      mode: "bridge",
      adapter: "hermes-config",
    });
    expect(payload.bridges).toEqual([]);
  });

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
      stdout: JSON.stringify({ capabilities: ["authenticated-mcp-policy-bound-credential-rewrite-v1", "policy-authorized-lifecycle-exec-v1", "nemoclaw.hermes-mcp-config-transaction-v1"] }),
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
    url: "https://mcp.example.test/mcp",
    env: [],
    policyName: "mcp-bridge-github",
    adapter: "mcporter",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  } } },
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

    expect(result.status).toBe(0);
    const jsonStart = result.stdout.indexOf("{");
    const sandbox = JSON.parse(result.stdout.slice(jsonStart)) as {
      mcp?: unknown;
    };
    expect(sandbox.mcp).toBeUndefined();
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
      stdout: JSON.stringify({ capabilities: ["authenticated-mcp-policy-bound-credential-rewrite-v1", "policy-authorized-lifecycle-exec-v1", "nemoclaw.hermes-mcp-config-transaction-v1"] }),
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

  it("rejects duplicate static credential keys across bridges in one sandbox", () => {
    const home = createTempHome("nemoclaw-mcp-env-key-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
registry.registerSandbox({
  name: "openclaw-sandbox",
  agent: "openclaw",
  mcp: { bridges: { first: {
    server: "first",
    url: "https://8.8.8.8/mcp",
    env: ["SHARED_MCP_TOKEN"],
    providerName: "nemoclaw-mcp-openclaw-sandbox-first",
    policyName: "mcp-bridge-first",
    adapter: "mcporter",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.addMcpBridge("openclaw-sandbox", {
  server: "second",
  url: "https://8.8.8.8/mcp",
  env: [{ name: "SHARED_MCP_TOKEN" }],
}).then(
  () => process.exit(1),
  (error) => {
    process.stdout.write(error.message);
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
    expect(result.stdout).toContain("already attached through MCP server 'first'");
  });

  it("preserves destroy transaction markers when the last bridge is removed", () => {
    const home = createTempHome("nemoclaw-mcp-destroy-state-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const markers = ["destroyPreparedAt", "destroyPendingAt"];
for (const [index, marker] of markers.entries()) {
  const name = "destroy-state-" + index;
  registry.registerSandbox({
    name,
    agent: "openclaw",
    mcp: {
      bridges: { github: {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: [],
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      } },
      [marker]: "2026-06-27T01:00:00.000Z",
    },
  });
  state.removeBridgeEntry(name, "github");
}
process.stdout.write(JSON.stringify(markers.map((_, index) => registry.getSandbox("destroy-state-" + index))));
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status).toBe(0);
    const sandboxes = JSON.parse(result.stdout) as Array<{
      mcp: {
        bridges: Record<string, unknown>;
        destroyPreparedAt?: string;
        destroyPendingAt?: string;
      };
    }>;
    expect(sandboxes[0]?.mcp).toEqual({
      bridges: {},
      destroyPreparedAt: "2026-06-27T01:00:00.000Z",
    });
    expect(sandboxes[1]?.mcp).toEqual({
      bridges: {},
      destroyPendingAt: "2026-06-27T01:00:00.000Z",
    });
  });

  it("validates requested server names and does not read inherited bridge keys", () => {
    const home = createTempHome("nemoclaw-mcp-status-key-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const status = require("./src/lib/actions/sandbox/mcp-bridge-status.js");
registry.registerSandbox({ name: "openclaw-sandbox", agent: "openclaw" });
(async () => {
  let invalid;
  try {
    await status.statusMcpBridge("openclaw-sandbox", "__proto__");
  } catch (error) {
    invalid = { message: error.message, exitCode: error.exitCode };
  }
  const inherited = await status.statusMcpBridge("openclaw-sandbox", "constructor");
  process.stdout.write(JSON.stringify({ invalid, inherited }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: sourceNodeOptions },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      invalid: { message: string; exitCode: number };
      inherited: Array<{
        server: string;
        provider: { registryPresent: boolean };
        adapter: { registered: boolean | null };
      }>;
    };
    expect(payload.invalid.exitCode).toBe(2);
    expect(payload.invalid.message).toContain("Invalid MCP server name '__proto__'");
    expect(payload.inherited).toHaveLength(1);
    expect(payload.inherited[0]).toMatchObject({
      server: "constructor",
      provider: { registryPresent: false },
      adapter: { registered: null },
    });
  });

  it("reports each bridge from its persisted adapter or agent capability", () => {
    const home = createTempHome("nemoclaw-mcp-status-agent-");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
agentDefs.loadAgent = (name) => {
  if (name === "current-disabled") {
    return {
      name,
      displayName: "Current Disabled",
      mcpCapability: { support: "disabled", reason: "current agent is disabled" },
    };
  }
  if (name === "persisted-enabled") {
    return {
      name,
      displayName: "Persisted Enabled",
      mcpCapability: { support: "bridge", adapter: "deepagents-config" },
    };
  }
  throw new Error("Unexpected agent lookup: " + name);
};
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
processRecovery.executeSandboxCommand = () => ({ status: 0, stdout: "registered", stderr: "" });
registry.registerSandbox({
  name: "persisted-status",
  agent: "current-disabled",
  mcp: { bridges: {
    direct: {
      server: "direct",
      agent: "persisted-unknown",
      adapter: "mcporter",
      url: "https://mcp.example.test/direct",
      env: [],
      policyName: "mcp-bridge-direct",
      addedAt: "2026-06-01T00:00:00.000Z",
    },
    legacy: {
      server: "legacy",
      agent: "persisted-enabled",
      url: "https://mcp.example.test/legacy",
      env: [],
      policyName: "mcp-bridge-legacy",
      addedAt: "2026-06-01T00:00:00.000Z",
    },
  } },
});
const status = require("./src/lib/actions/sandbox/mcp-bridge-status.js");
status.statusMcpBridge("persisted-status").then(
  (bridges) => process.stdout.write(JSON.stringify(bridges)),
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

    expect(result.status).toBe(0);
    const bridges = JSON.parse(result.stdout) as Array<{
      server: string;
      agent: string;
      support: { supported: boolean; mode: string; adapter?: string; reason?: string };
      adapter: { registered: boolean | null };
    }>;
    expect(bridges).toHaveLength(2);
    expect(bridges[0]).toMatchObject({
      server: "direct",
      agent: "persisted-unknown",
      support: { supported: true, mode: "bridge", adapter: "mcporter" },
      adapter: { registered: true },
    });
    expect(bridges[0]?.support.reason).toBeUndefined();
    expect(bridges[1]).toMatchObject({
      server: "legacy",
      agent: "persisted-enabled",
      support: { supported: true, mode: "bridge", adapter: "deepagents-config" },
      adapter: { registered: true },
    });
  });
});
