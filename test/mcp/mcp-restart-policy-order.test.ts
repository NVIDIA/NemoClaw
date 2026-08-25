// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.106");

describe("MCP restart policy ordering", () => {
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
for (const entry of Object.values(entries)) {
  registry.addCustomPolicy("alpha", {
    name: entry.policyName,
    content: generated.buildMcpBridgePolicyYaml(entry.server, entry.url, entry.adapter, {
      addresses: [new URL(entry.url).hostname],
    }, entry.providerName),
    sourcePath: "generated:nemoclaw-mcp-bridge",
  });
}

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

  const verifyProviderRevisionLifecycle = (
    operation: "restart" | "restore",
    driftAfterAdapterRegistration: boolean,
  ) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-restart-revision-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.MCP_TOKEN = "host-only-secret";
const registry = require("./src/lib/state/registry.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const { mockManagedEndpointlessProviderProfileRun } = require("./test/helpers/onboard-script-mocks.cjs");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const generated = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");

let resourceVersion = 1;
let registeredProviderGets = 0;
let adapterRegistrations = 0;
const observations = [];
const proofScripts = [];
const providerCalls = [];
const operation = ${JSON.stringify(operation)};
const driftAfterAdapterRegistration = ${JSON.stringify(driftAfterAdapterRegistration)};
const observationPlans = {
  restart: ["v1", "absent", "v4"],
  restore: ["absent", "v3"],
};
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
  updatedAt: "2026-06-01T00:00:00.000Z",
};

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
policies.getPresetContentGatewayState = () => "match";
policies.applyPresetContent = () => true;
processRecovery.executeSandboxExecCommand = (_sandbox, command) => {
  const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] || "";
  const proof = encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
  proofScripts.push(proof);
  if (proof.includes("printf '%s\\n' absent")) {
    const observation = observationPlans[operation][observations.length] || "v" + resourceVersion;
    observations.push(observation);
    return { status: 0, stdout: observation, stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
processRecovery.executeSandboxCommand = (_sandbox, command) => {
  if (command === "command -v mcporter") {
    return { status: 0, stdout: "/usr/local/bin/mcporter\n", stderr: "" };
  }
  adapterRegistrations += 1;
  if (driftAfterAdapterRegistration && adapterRegistrations === 1) resourceVersion += 1;
  return { status: 0, stdout: "registered\n", stderr: "" };
};

registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { example: entry } },
});
registry.addExtraProvider("foreign-registered");
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: generated.buildMcpBridgePolicyYaml(entry.server, entry.url, entry.adapter, {
    addresses: ["8.8.8.8"],
  }, entry.providerName),
  sourcePath: "generated:nemoclaw-mcp-bridge",
});

const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const restart = require("./src/lib/actions/sandbox/mcp-bridge-restart.js");
const operations = {
  restart: () => bridge.restartMcpBridge("alpha", "example"),
  restore: () => restart.restoreExistingMcpBridgeRuntime("alpha", [entry]),
};
operations[operation]().then(
  () => process.stdout.write(JSON.stringify({ message: null, observations, proofScripts, providerCalls, registeredProviderGets, updatedAt: registry.getSandbox("alpha").mcp.bridges.example.updatedAt })),
  (error) => process.stdout.write(JSON.stringify({ message: error instanceof Error ? error.message : String(error), observations, proofScripts, providerCalls, registeredProviderGets, updatedAt: registry.getSandbox("alpha").mcp.bridges.example.updatedAt })),
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
      message: string | null;
      observations: string[];
      proofScripts: string[];
      providerCalls: string[];
      registeredProviderGets: number;
      updatedAt: string;
    };
    const expected = {
      restart: {
        ready: ["v1", "absent", "v4", "v4"],
        drift: ["v1", "absent", "v4", "v5"],
        providerCalls: [
          "provider update alpha-mcp-example --credential MCP_TOKEN",
          "provider update alpha-mcp-example",
          "provider update alpha-mcp-example",
        ],
      },
      restore: {
        ready: ["absent", "v3", "v3"],
        drift: ["absent", "v3", "v4"],
        providerCalls: ["provider update alpha-mcp-example", "provider update alpha-mcp-example"],
      },
    }[operation];
    expect(payload.observations).toEqual(
      driftAfterAdapterRegistration ? expected.drift : expected.ready,
    );
    expect(payload.providerCalls).toEqual(expected.providerCalls);
    expect(payload.registeredProviderGets).toBe(1);
    expect(payload.proofScripts).toHaveLength(payload.observations.length);
    expect(payload.proofScripts.join("\n")).not.toMatch(/\/tmp|snapshot/);
    expect(payload.message).toBe(
      driftAfterAdapterRegistration
        ? "OpenShell credential revision changed before MCP runtime commit for server 'example'."
        : null,
    );
    expect(payload.updatedAt === "2026-06-01T00:00:00.000Z").toBe(driftAfterAdapterRegistration);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("host-only-secret");
  };

  it.each(["restart", "restore"] as const)(
    "recovers a delayed provider revision during %s (#10298)",
    (operation) => verifyProviderRevisionLifecycle(operation, false),
  );

  it.each(["restart", "restore"] as const)(
    "rejects provider revision drift after adapter registration during %s (#10298)",
    (operation) => verifyProviderRevisionLifecycle(operation, true),
  );
});
