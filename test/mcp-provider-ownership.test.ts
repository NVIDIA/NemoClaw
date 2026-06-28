// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function runRemoveIdentityRace(swapAt: "detach" | "delete") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-provider-race-"));
  const script = `
process.env.HOME = ${JSON.stringify(home)};
const swapAt = ${JSON.stringify(swapAt)};
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const globalActions = require("./src/lib/actions/global.js");
const expectedId = "11111111-2222-4333-8444-555555555555";
const foreignId = "99999999-8888-4777-8666-555555555555";
let liveId = expectedId;
let attached = true;
const calls = [];
agentDefs.loadAgent = () => { throw new Error("persisted adapter must be used"); };
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  calls.push(args.join(" "));
  if (args[0] === "status") {
    return { status: 0, stdout: JSON.stringify({ capabilities: ["authenticated-mcp-policy-bound-credential-rewrite-v1", "policy-authorized-lifecycle-exec-v1", "nemoclaw.hermes-mcp-config-transaction-v1"] }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: " + liveId + "\\nType: generic\\nResource version: 4\\nCredential keys: EXPECTED_TOKEN\\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return { status: 0, stdout: JSON.stringify({ attachments: attached ? [{ name: "alpha-mcp-fake", provider_present: true, provider_id: liveId, provider_resource_version: 4, credential_keys: ["EXPECTED_TOKEN"], bound_provider_id: expectedId, bound_credential_keys: ["EXPECTED_TOKEN"] }] : [] }), stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    attached = false;
    return { status: 0, stdout: "detached", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = () => "match";
policies.removePreset = () => {
  if (swapAt === "delete") liveId = foreignId;
  return true;
};
processRecovery.executeSandboxCommand = () => {
  if (swapAt === "detach") liveId = foreignId;
  return { status: 0, stdout: "", stderr: "" };
};
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "", stderr: "" });
const entry = {
  server: "fake",
  agent: "openclaw",
  url: "https://mcp.example.test/mcp",
  env: ["EXPECTED_TOKEN"],
  providerName: "alpha-mcp-fake",
  providerId: expectedId,
  policyName: "mcp-bridge-fake",
  adapter: "mcporter",
  addedAt: "2026-06-01T00:00:00.000Z",
};
registry.registerSandbox({
  name: "alpha",
  agent: "legacy-disabled",
  mcp: { bridges: { fake: entry } },
});
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: "network_policies: {}\\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("alpha", "fake").then(
  () => process.exit(9),
  (error) => process.stdout.write(JSON.stringify({
    message: error.message,
    calls,
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.fake,
  })),
);
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

describe("MCP provider ownership", () => {
  for (const boundary of ["detach", "delete"] as const) {
    it(`rechecks stable identity immediately before provider ${boundary}`, () => {
      const result = runRemoveIdentityRace(boundary);

      expect(result.status, `${result.stdout}\\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        message: string;
        calls: string[];
        bridgePresent: boolean;
      };
      expect(payload.message).toContain("Expected stable provider ID");
      expect(payload.calls.some((call) => call.startsWith("provider delete alpha-mcp-fake"))).toBe(
        false,
      );
      expect(
        payload.calls.some((call) =>
          call.startsWith("sandbox provider detach alpha alpha-mcp-fake"),
        ),
      ).toBe(true);
      expect(payload.bridgePresent).toBe(true);
    });
  }

  it("reports a same-shape provider with a different stable ID as drift", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-provider-status-owner-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.EXPECTED_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const globalActions = require("./src/lib/actions/global.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
agentDefs.loadAgent = () => ({
  name: "openclaw",
  displayName: "OpenClaw",
  mcpCapability: { support: "bridge", adapter: "mcporter" },
});
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: 99999999-8888-4777-8666-555555555555\\nType: generic\\nResource version: 4\\nCredential keys: EXPECTED_TOKEN\\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return { status: 0, stdout: JSON.stringify({ attachments: [{ name: "alpha-mcp-fake", provider_present: true, provider_id: "99999999-8888-4777-8666-555555555555", provider_resource_version: 4, credential_keys: ["EXPECTED_TOKEN"], bound_provider_id: "11111111-2222-4333-8444-555555555555", bound_credential_keys: ["EXPECTED_TOKEN"] }] }), stderr: "" };
  }
  throw new Error("unexpected call: " + args.join(" "));
};
processRecovery.executeSandboxCommand = () => ({
  status: 0,
  stdout: "registered\\n",
  stderr: "",
});
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { fake: {
    server: "fake",
    agent: "openclaw",
    url: "https://mcp.example.test/mcp",
    env: ["EXPECTED_TOKEN"],
    providerName: "alpha-mcp-fake",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-fake",
    adapter: "mcporter",
    addedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.statusMcpBridge("alpha", "fake").then(
  (statuses) => process.stdout.write(JSON.stringify(statuses[0])),
  (error) => { console.error(error); process.exit(1); },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const status = JSON.parse(result.stdout) as {
      env: { ready: boolean };
      provider: { credentialReady: boolean; detail?: string };
    };
    expect(status.env.ready).toBe(false);
    expect(status.provider.credentialReady).toBe(false);
    expect(status.provider.detail).toContain("Expected stable provider ID");
  });

  it("never detaches or deletes a non-matching provider in force mode", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-provider-owner-"));
    const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const globalActions = require("./src/lib/actions/global.js");
const calls = [];
agentDefs.loadAgent = () => { throw new Error("persisted adapter must be used"); };
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
policies.getPresetContentGatewayState = () => "absent";
policies.removePreset = () => true;
processRecovery.executeSandboxCommand = () => ({ status: 0, stdout: "", stderr: "" });
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "", stderr: "" });
globalActions.runOpenshellProviderCommand = (args) => {
  calls.push(args.join(" "));
  if (args[0] === "status") {
    return { status: 0, stdout: JSON.stringify({ capabilities: ["authenticated-mcp-policy-bound-credential-rewrite-v1", "policy-authorized-lifecycle-exec-v1", "nemoclaw.hermes-mcp-config-transaction-v1"] }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: 99999999-8888-4777-8666-555555555555\\nType: generic\\nResource version: 4\\nCredential keys: EXPECTED_TOKEN\\n",
      stderr: "",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
};
registry.registerSandbox({
  name: "alpha",
  agent: "legacy-disabled",
  mcp: { bridges: { fake: {
    server: "fake",
    url: "https://mcp.example.test/mcp",
    env: ["EXPECTED_TOKEN"],
    providerName: "alpha-mcp-fake",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-fake",
    adapter: "mcporter",
    addedAt: "2026-06-01T00:00:00.000Z",
  } } },
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("alpha", "fake", { force: true }).then(
  () => process.exit(9),
  (error) => process.stdout.write(JSON.stringify({
    message: error.message,
    calls,
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.fake,
  })),
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
      message: string;
      calls: string[];
      bridgePresent: boolean;
    };
    expect(payload.message).toContain("registry entry was preserved");
    expect(result.stderr).toContain("Expected stable provider ID");
    expect(payload.calls.some((call) => call === "provider get alpha-mcp-fake")).toBe(true);
    expect(payload.bridgePresent).toBe(true);
  });
});
