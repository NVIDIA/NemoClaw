// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mcpPolicyAllowedIps } from "../helpers/mcp-policy-pins";

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.106");

describe("MCP restart policy ordering", () => {
  it.each(["restart", "rebuild restoration"] as const)(
    "rejects a legacy public single-pin registration before %s mutates runtime state (#10755)",
    (operation) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-single-pin-"));
      const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const dns = require("./src/lib/adapters/dns/resolve.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const policies = require("./src/lib/policy/index.js");
const adapterRegistration = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");

const replace = (target, key, value) =>
  Object.defineProperty(target, key, { configurable: true, value });
let dnsCalls = 0;
let policyCalls = 0;
let providerCalls = 0;
let adapterCalls = 0;
replace(dns, "resolveHostAddresses", async () => {
  dnsCalls += 1;
  return [{ address: "8.8.8.8" }];
});
replace(policies, "applyPresetContent", () => {
  policyCalls += 1;
  return true;
});
replace(providerCommands, "runOpenshellProviderCommand", () => {
  providerCalls += 1;
  return { status: 0, stdout: "", stderr: "" };
});
replace(adapterRegistration, "registerAgentAdapterAtCurrentCredentialRevision", () => {
  adapterCalls += 1;
  return "v1";
});

const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.com/mcp",
  env: ["MCP_TOKEN"],
  allowedIps: ["8.8.8.8"],
  providerName: "alpha-mcp-example",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { example: entry } },
});

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const action =
  ${JSON.stringify(operation)} === "restart"
    ? bridge.restartMcpBridge("alpha", "example")
    : bridge.restoreMcpBridgesAfterRebuild("alpha", [entry]);
action.then(
  () => process.exit(9),
  (error) => {
    process.stdout.write(JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      dnsCalls,
      policyCalls,
      providerCalls,
      adapterCalls,
      allowedIps: registry.getSandbox("alpha").mcp.bridges.example.allowedIps,
    }));
  },
);
`;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
        timeout: 30_000,
      });
      fs.rmSync(home, { recursive: true, force: true });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        message: string;
        dnsCalls: number;
        policyCalls: number;
        providerCalls: number;
        adapterCalls: number;
        allowedIps: string[];
      };
      expect(payload.message).toContain("returned only one public address");
      expect(payload.message).toContain("record its URL and credential-variable name");
      expect(payload.message).toContain("remove the server, and add it again");
      expect(payload.message).toContain("Sandbox destroy remains available");
      expect(payload.dnsCalls).toBe(1);
      expect(payload.policyCalls).toBe(0);
      expect(payload.providerCalls).toBe(0);
      expect(payload.adapterCalls).toBe(0);
      expect(payload.allowedIps).toEqual(["8.8.8.8"]);
    },
  );

  it.each(["restart", "restore"] as const)(
    "rejects a later foreign attached credential key before any policy or provider mutation during %s (#9388)",
    (operation) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-restart-order-"));
      const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.FIRST_MCP_TOKEN = "first-host-only-secret";
process.env.SECOND_MCP_TOKEN = "second-host-only-secret";
const registry = require("./src/lib/state/registry.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");

const providerCalls = [];
let policyApplyCalls = 0;
const operation = ${JSON.stringify(operation)};
const entries = {
  first: {
    server: "first",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://8.8.8.8/mcp",
    env: ["FIRST_MCP_TOKEN"],
    providerName: "alpha-mcp-first",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-first",
    addedAt: "2026-06-01T00:00:00.000Z",
  },
  second: {
    server: "second",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://1.1.1.1/mcp",
    env: ["SECOND_MCP_TOKEN"],
    providerName: "alpha-mcp-second",
    providerId: "22222222-3333-4444-8555-666666666666",
    policyName: "mcp-bridge-second",
    addedAt: "2026-06-01T00:00:00.000Z",
  },
};
const updatedProviders = new Set();

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
providerCommands.runOpenshellProviderCommand = (args) => {
  const profileResult = mockManagedEndpointlessProviderProfileRun(args);
  if (profileResult) return profileResult;
  if (args.join(" ") === "status --output json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    if (args[2] === "foreign-attached") {
      return {
        status: 0,
        stdout:
          "Id: 99999999-8888-4777-8666-555555555555\nType: nemoclaw-mcp-v1\nResource version: 1\nCredential keys: SECOND_MCP_TOKEN\n",
        stderr: "",
      };
    }
    const entry = Object.values(entries).find((candidate) => candidate.providerName === args[2]);
    if (!entry) return { status: 1, stdout: "", stderr: "NotFound: provider" };
    return {
      status: 0,
      stdout: "Id: " + entry.providerId + "\nType: nemoclaw-mcp-v1\nResource version: " + (updatedProviders.has(entry.providerName) ? "2" : "1") + "\nCredential keys: " + entry.env[0] + "\n",
      stderr: "",
    };
  }
  if (args.join(" ") === "sandbox provider list alpha") {
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-first nemoclaw-mcp-v1 1 0\nalpha-mcp-second nemoclaw-mcp-v1 1 0\nforeign-attached nemoclaw-mcp-v1 1 0\n",
      stderr: "",
    };
  }
  if (args[0] === "provider" && (args[1] === "create" || args[1] === "update")) {
    providerCalls.push(args.join(" "));
    updatedProviders.add(args[2]);
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = () => "match";
policies.applyPresetContent = () => {
  policyApplyCalls += 1;
  return true;
};
processRecovery.executeSandboxExecCommand = (_sandbox, command) => {
  const entry = Object.values(entries).find((candidate) => command.includes(candidate.env[0]));
  return {
    status: entry ? 0 : 1,
    stdout: entry ? (updatedProviders.has(entry.providerName) ? "v2\n" : "v1\n") : "",
    stderr: "",
  };
};
processRecovery.executeSandboxCommand = (_sandbox, command) => ({
  status: 0,
  stdout: command === "command -v mcporter" ? "/usr/local/bin/mcporter\n" : "registered\n",
  stderr: "",
});

registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: entries },
});

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const restart = require("./src/lib/actions/sandbox/mcp-bridge-restart.js");
const operationPromise =
  operation === "restart"
    ? bridge.restartMcpBridge("alpha")
    : restart.restoreExistingMcpBridgeRuntime("alpha", Object.values(entries));
operationPromise.then(
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
        env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
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
        "Credential key 'SECOND_MCP_TOKEN' is already supplied by attached provider 'foreign-attached'",
      );
      expect(payload.policyApplyCalls).toBe(0);
      expect(payload.providerCalls).toEqual([]);
    },
  );

  it("compares provider revisions and persists refreshed public pins during restart (#10755)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-restart-revision-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.MCP_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const dns = require("./src/lib/adapters/dns/resolve.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const adapterRegistration = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");

const replace = (target, key, value) =>
  Object.defineProperty(target, key, { configurable: true, value });

let resourceVersion = 1;
let registeredProviderGets = 0;
let activePolicyContent = "";
const previousRevisionInputs = [];
const adapterRevisionInputs = [];
const providerCalls = [];
const entry = {
  server: "example",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.com/mcp",
  env: ["MCP_TOKEN"],
  allowedIps: ["8.8.8.8"],
  providerName: "alpha-mcp-example",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-example",
  addedAt: "2026-06-01T00:00:00.000Z",
};

dns.resolveHostAddresses = async () => [
  { address: "8.8.8.8" },
  { address: "1.1.1.1" },
];

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
providerCommands.runOpenshellProviderCommand = (args) => {
  const profileResult = mockManagedEndpointlessProviderProfileRun(args);
  if (profileResult) return profileResult;
  const command = args.join(" ");
  if (command === "status --output json") {
    return { status: 0, stdout: JSON.stringify({ gateway: "nemoclaw" }), stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    if (args[2] === "foreign-registered") {
      registeredProviderGets += 1;
      return {
        status: 0,
        stdout: "Id: 99999999-8888-4777-8666-555555555555\nType: nemoclaw-mcp-v1\nResource version: 1\nCredential keys: OTHER_TOKEN\n",
        stderr: "",
      };
    }
    return {
      status: 0,
      stdout: "Id: " + entry.providerId + "\nType: nemoclaw-mcp-v1\nResource version: " + resourceVersion + "\nCredential keys: MCP_TOKEN\n",
      stderr: "",
    };
  }
  if (args[0] === "provider" && args[1] === "update") {
    providerCalls.push(command);
    resourceVersion += 1;
    return { status: 0, stdout: "Updated provider", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n" + entry.providerName + " nemoclaw-mcp-v1 1 0\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
    return { status: 0, stdout: "attached", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = (_sandbox, content) =>
  content === activePolicyContent ? "match" : "drift";
policies.applyPresetContent = (_sandbox, _name, content) => {
  activePolicyContent = content;
  return true;
};
replace(provider, "observeMcpCredentialRevision", () => "v1");
replace(provider, "waitForAttachedMcpCredential", (_sandbox, _entry, options = {}) => {
  previousRevisionInputs.push(options.previousRevision);
  return "v3";
});
replace(
  adapterRegistration,
  "registerAgentAdapterAtCurrentCredentialRevision",
  (_sandbox, _adapter, _entry, _env, credentialRevision) => {
    adapterRevisionInputs.push(credentialRevision);
    return credentialRevision;
  },
);
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
registry.addExtraProvider("foreign-registered");

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.restartMcpBridge("alpha", "example").then(
  () => {
    const persistedEntry = registry.getSandbox("alpha").mcp.bridges.example;
    const registeredPolicy = generated.getRegisteredGeneratedPolicy("alpha", persistedEntry);
    process.stdout.write(JSON.stringify({
      previousRevisionInputs,
      adapterRevisionInputs,
      providerCalls,
      registeredProviderGets,
      allowedIps: persistedEntry.allowedIps,
      activePolicyContent,
      registeredPolicyContent: registeredPolicy?.content,
      policyPresence: generated.getPolicyPresence("alpha", persistedEntry),
    }));
  },
  (error) => { console.error(error); process.exit(1); },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, NEMOCLAW_OPENSHELL_BIN: MATCHING_OPENSHELL },
      timeout: 30_000,
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
      previousRevisionInputs: string[];
      adapterRevisionInputs: string[];
      providerCalls: string[];
      registeredProviderGets: number;
      allowedIps: string[];
      activePolicyContent: string;
      registeredPolicyContent: string;
      policyPresence: boolean | null;
    };
    expect(payload.previousRevisionInputs).toEqual(["v1"]);
    expect(payload.adapterRevisionInputs).toEqual(["v3"]);
    expect(payload.providerCalls).toEqual([
      "provider update alpha-mcp-example --credential MCP_TOKEN",
      "provider update alpha-mcp-example",
    ]);
    expect(payload.registeredProviderGets).toBe(1);
    expect(payload.allowedIps).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(payload.registeredPolicyContent).toBe(payload.activePolicyContent);
    expect(mcpPolicyAllowedIps(payload.registeredPolicyContent, "example")).toEqual([
      "1.1.1.1",
      "8.8.8.8",
    ]);
    expect(payload.policyPresence).toBe(true);
  });
});
