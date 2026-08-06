// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("managed MCP policy journal guard", () => {
  it("blocks add, restart, and remove before external mutation for either policy journal", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-journal-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.GITHUB_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const shields = require("./src/lib/shields/index.js");

const mutations = [];
const providerId = "11111111-2222-4333-8444-555555555555";
shields.isShieldsDown = () => false;
gatewayRuntime.recoverNamedGatewayRuntime = async () => {
  mutations.push("gateway:recover");
  return {
    recovered: true,
    attempted: false,
    before: { state: "healthy_named" },
    after: { state: "healthy_named" },
  };
};
providerCommands.runOpenshellProviderCommand = (args) => {
  mutations.push("openshell:" + args.join(" "));
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = () => "match";
policies.applyPresetContent = () => { mutations.push("policy:apply"); return true; };
policies.removePreset = () => { mutations.push("policy:remove"); return true; };
processRecovery.executeSandboxCommand = (_sandboxName, command) => {
  mutations.push("adapter:" + command);
  return { status: 0, stdout: '{"ok":true}\n', stderr: "" };
};

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const makeEntry = (server) => ({
  server,
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://8.8.8.8/mcp",
  env: ["GITHUB_TOKEN"],
  providerName: "provider-" + server,
  providerId,
  policyName: "mcp-bridge-" + server,
  addedAt: "2026-08-06T00:00:00.000Z",
});
const register = (name, entry) => {
  registry.registerSandbox({
    name,
    agent: "hermes",
    gatewayName: "nemoclaw",
    ...(entry ? { mcp: { bridges: { [entry.server]: entry } } } : {}),
  });
  if (entry) {
    registry.addCustomPolicy(name, {
      name: entry.policyName,
      content: bridge.buildMcpBridgePolicyYaml(
        entry.server,
        entry.url,
        "hermes-config",
        { addresses: ["8.8.8.8"] },
      ),
      sourcePath: "generated:nemoclaw-mcp-bridge",
    });
  }
};
const beginJournal = (name, kind, index) => {
  if (kind === "custom") {
    const requested = {
      name: "private-api",
      content: "network_policies:\n  private_api:\n    endpoints: []\n",
    };
    if (!registry.addCustomPolicy(name, requested)) throw new Error("custom policy seed failed");
    const previous = registry.getCustomPolicies(name).find((entry) => entry.name === requested.name);
    if (!previous) throw new Error("custom policy seed disappeared");
    if (!registry.beginCustomPolicyTransition(name, {
      version: 1,
      id: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
      operation: "remove",
      name: previous.name,
      previous,
      desired: null,
      startedAt: "2026-08-06T12:00:00.000Z",
    })) throw new Error("custom policy journal failed");
    return;
  }
  if (!registry.beginBaselineExclusionTransition(name, {
    id: "10000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    operation: "exclude",
    exclusion: {
      version: 1,
      agent: "hermes",
      key: "nous_research",
      digest: "a".repeat(64),
    },
    targetLiveDigest: null,
    startedAt: "2026-08-06T12:00:00.000Z",
  })) throw new Error("baseline policy journal failed");
};
const messages = [];
const capture = async (operation) => {
  try { await operation(); }
  catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
};

(async () => {
  let index = 1;
  for (const kind of ["custom", "baseline"]) {
    const addName = kind + "-add";
    register(addName, null);
    beginJournal(addName, kind, index++);
    await capture(() => bridge.addMcpBridge(addName, {
      server: "github",
      url: "https://8.8.8.8/mcp",
      env: [{ name: "GITHUB_TOKEN" }],
    }));

    const restartName = kind + "-restart";
    const restarted = makeEntry("restarted");
    register(restartName, restarted);
    beginJournal(restartName, kind, index++);
    await capture(() => bridge.restartMcpBridge(restartName, restarted.server));

    const removeName = kind + "-remove";
    const removed = makeEntry("removed");
    register(removeName, removed);
    beginJournal(removeName, kind, index++);
    await capture(() => bridge.removeMcpBridge(removeName, removed.server, { force: true }));
  }

  process.stdout.write(JSON.stringify({
    messages,
    mutations,
    sandboxes: registry.listSandboxes().sandboxes,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      messages: string[];
      mutations: string[];
      sandboxes: Array<{
        customPolicyTransition?: unknown;
        baselineExclusionTransition?: unknown;
        mcp?: { bridges?: Record<string, unknown> };
      }>;
    };
    expect(payload.messages).toHaveLength(6);
    expect(
      payload.messages.filter((message) => message.toLowerCase().includes("custom policy")),
      JSON.stringify(payload.messages),
    ).toHaveLength(3);
    expect(
      payload.messages.filter((message) => message.toLowerCase().includes("baseline policy")),
    ).toHaveLength(3);
    expect(payload.mutations).toEqual([]);
    expect(payload.sandboxes).toHaveLength(6);
    for (const sandbox of payload.sandboxes) {
      expect(sandbox.customPolicyTransition ?? sandbox.baselineExclusionTransition).toBeDefined();
      if (sandbox.mcp?.bridges) expect(Object.keys(sandbox.mcp.bridges)).toHaveLength(1);
    }
  });
});
