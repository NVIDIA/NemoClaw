// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Hermes MCP shields ordering", () => {
  it("refuses add, resumed add, restart, and remove before external mutation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-shields-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.GITHUB_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const globalActions = require("./src/lib/actions/global.js");
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
globalActions.runOpenshellProviderCommand = (args) => {
  const command = args.join(" ");
  if (command === "status --output json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return { status: 1, stdout: "", stderr: "Provider not found" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return { status: 0, stdout: "No providers attached.\n", stderr: "" };
  }
  mutations.push("openshell:" + command);
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
const makeEntry = (server, addState) => ({
  server,
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://8.8.8.8/mcp",
  env: ["GITHUB_TOKEN"],
  providerName: "provider-" + server,
  providerId,
  policyName: "mcp-bridge-" + server,
  addedAt: "2026-06-30T00:00:00.000Z",
  ...(addState ? { addState } : {}),
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
        ["8.8.8.8"],
      ),
      sourcePath: "generated:nemoclaw-mcp-bridge",
    });
  }
};
const messages = [];
const capture = async (operation) => {
  try { await operation(); }
  catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
};

(async () => {
  register("fresh", null);
  await capture(() => bridge.addMcpBridge("fresh", {
    server: "github",
    url: "https://8.8.8.8/mcp",
    env: [{ name: "GITHUB_TOKEN" }],
  }));
  const freshManifest = registry.getSandbox("fresh")?.mcp;

  const resumed = makeEntry("resumed", "preflighted");
  register("resume", resumed);
  await capture(() => bridge.addMcpBridge("resume", {
    server: resumed.server,
    url: resumed.url,
    env: [{ name: "GITHUB_TOKEN" }],
  }));

  const restarted = makeEntry("restarted");
  register("restart", restarted);
  await capture(() => bridge.restartMcpBridge("restart", restarted.server));

  const removed = makeEntry("removed");
  register("remove", removed);
  await capture(() => bridge.removeMcpBridge("remove", removed.server));

  process.stdout.write(JSON.stringify({ messages, mutations, freshManifest }));
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
      freshManifest?: unknown;
    };
    expect(payload.messages).toHaveLength(4);
    for (const message of payload.messages) {
      expect(message).toContain("has shields up or an unreadable shields posture");
    }
    expect(payload.mutations).toEqual([]);
    expect(payload.freshManifest).toBeUndefined();
  });
});
