// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("MCP restart policy ordering", () => {
  it("rejects a foreign attached credential key before policy or provider mutation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-restart-order-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.MCP_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");

const providerCalls = [];
let policyApplyCalls = 0;
const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://8.8.8.8/mcp",
  env: ["MCP_TOKEN"],
  providerName: "alpha-mcp-example",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  if (args.join(" ") === "status --output json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    if (args[2] === "foreign-attached") {
      return {
        status: 0,
        stdout: "Id: 99999999-8888-4777-8666-555555555555\nType: generic\nResource version: 1\nCredential keys: MCP_TOKEN\n",
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: "Id: " + entry.providerId + "\nType: generic\nResource version: 1\nCredential keys: MCP_TOKEN\n",
      stderr: "",
    };
  }
  if (args.join(" ") === "sandbox provider list alpha") {
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign-attached generic 1 0\n",
      stderr: "",
    };
  }
  if (args[0] === "provider" && (args[1] === "create" || args[1] === "update")) {
    providerCalls.push(args.join(" "));
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = () => "match";
policies.applyPresetContent = () => {
  policyApplyCalls += 1;
  return true;
};
processRecovery.executeSandboxExecCommand = () => ({ status: 0, stdout: "", stderr: "" });
processRecovery.executeSandboxCommand = (_sandbox, command) => ({
  status: 0,
  stdout: command === "command -v mcporter" ? "/usr/local/bin/mcporter\n" : "registered\n",
  stderr: "",
});

registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { example: entry } },
});
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: generated.buildMcpBridgePolicyYaml(entry.server, entry.url, entry.adapter, ["8.8.8.8"]),
  sourcePath: "generated:nemoclaw-mcp-bridge",
});

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.restartMcpBridge("alpha", "example").then(
  () => process.exit(9),
  (error) => {
    process.stdout.write(JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      policyApplyCalls,
      providerCalls,
    }));
  },
);
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
      message: string;
      policyApplyCalls: number;
      providerCalls: string[];
    };
    expect(payload.message).toContain(
      "Credential key 'MCP_TOKEN' is already supplied by attached provider 'foreign-attached'",
    );
    expect(payload.policyApplyCalls).toBe(0);
    expect(payload.providerCalls).toEqual([]);
  });
});
