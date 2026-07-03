// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function runLegacyLifecycle(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-mcp-legacy-"));
  const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

const providerId = "11111111-2222-4333-8444-555555555555";
let providerExists = true;
let attached = true;
let adapterRegistered = true;
let deepAgentsCapability = false;
let policyApplyCalls = 0;
let policyState = "match";
const adapterCalls = [];

gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
globalActions.runOpenshellProviderCommand = (args) => {
  const command = args.join(" ");
  if (command === "status --output json") {
    return { status: 0, stdout: "ready", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return providerExists
      ? {
          status: 0,
          stdout: "Id: " + providerId + "\nType: generic\nResource version: 1\nCredential keys: GITHUB_TOKEN\n",
          stderr: "",
        }
      : { status: 1, stdout: "", stderr: "Provider not found" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: attached
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-github generic 1 0\n"
        : "No providers attached to sandbox alpha.\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    attached = false;
    return { status: 0, stdout: "Detached provider", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
    attached = true;
    return { status: 0, stdout: "Attached provider", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "delete") {
    providerExists = false;
    attached = false;
    return { status: 0, stdout: "Deleted provider", stderr: "" };
  }
  throw new Error("Unexpected OpenShell call: " + command);
};
policies.getPresetContentGatewayState = () => policyState;
policies.applyPresetContent = () => {
  policyApplyCalls += 1;
  policyState = "match";
  return true;
};
policies.removePreset = () => {
  policyState = "absent";
  return true;
};
processRecovery.executeSandboxCommand = (_sandbox, command) => {
  adapterCalls.push(command);
  if (command === "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability") {
    return deepAgentsCapability
      ? { status: 0, stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1\n", stderr: "" }
      : { status: 2, stdout: "", stderr: "unknown option" };
  }
  if (command.includes("servers.pop(payload['server'], None)")) {
    adapterRegistered = false;
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command.includes("data = {'mcpServers': payload['expectedServers']}")) {
    adapterRegistered = true;
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command.includes("print('registered' if ok else ('mismatch' if present else 'absent'))")) {
    return {
      status: 0,
      stdout: adapterRegistered ? "registered\n" : "absent\n",
      stderr: "",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
};
processRecovery.executeSandboxExecCommand = (_sandbox, command) => {
  const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] || "";
  const proof = encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
  const isRevisionObservation = proof.includes("valid_placeholder()");
  const isDetachedProof =
    !isRevisionObservation && proof.includes('[ -z "\${GITHUB_TOKEN+x}" ]');
  return {
    status: isDetachedProof && attached ? 1 : 0,
    stdout: attached ? "canonical" : "absent",
    stderr: "",
  };
};

const entry = {
  server: "github",
  agent: "langchain-deepagents-code",
  adapter: "deepagents-config",
  url: "https://8.8.8.8/github",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId,
  policyName: "mcp-bridge-github",
  addedAt: "2026-06-27T00:00:00.000Z",
};
registry.registerSandbox({
  name: "alpha",
  agent: "langchain-deepagents-code",
  gatewayName: "nemoclaw",
  mcp: { bridges: { github: entry } },
});
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: "network_policies: {}\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
${body}
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

function parseResult(result: ReturnType<typeof runLegacyLifecycle>) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
    error?: string;
    entryCount?: number;
    attached: boolean;
    adapterRegistered: boolean;
    providerExists: boolean;
    policyApplyCalls: number;
    markerCalls: number;
  };
}

const resultExpression = `JSON.stringify({
  attached,
  adapterRegistered,
  providerExists,
  policyApplyCalls,
  markerCalls: adapterCalls.filter((call) =>
    call.includes("deepagents-code --nemoclaw-mcp-capability")
  ).length,
})`;

describe("legacy Deep Agents managed MCP lifecycle", () => {
  it("removes an existing entry without requiring the new launcher marker", () => {
    const result = runLegacyLifecycle(`
(async () => {
  await bridge.removeMcpBridge("alpha", "github");
  process.stdout.write(${resultExpression});
})().catch((error) => { console.error(error); process.exit(1); });
`);
    expect(parseResult(result)).toMatchObject({
      attached: false,
      adapterRegistered: false,
      providerExists: false,
      markerCalls: 0,
    });
  });

  for (const [label, method] of [
    ["destroy", "prepareMcpBridgesForDestroy"],
    ["rebuild", "prepareMcpBridgesForRebuild"],
  ] as const) {
    it(`${label} teardown does not require the marker from the old image`, () => {
      const result = runLegacyLifecycle(`
(async () => {
  const preparation = await bridge.${method}("alpha");
  process.stdout.write(JSON.stringify({
    entryCount: preparation.entries.length,
    attached,
    adapterRegistered,
    providerExists,
    policyApplyCalls,
    markerCalls: adapterCalls.filter((call) =>
      call.includes("deepagents-code --nemoclaw-mcp-capability")
    ).length,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);
      expect(parseResult(result)).toMatchObject({
        entryCount: 1,
        attached: false,
        adapterRegistered: false,
        providerExists: true,
        markerCalls: 0,
      });
    });
  }

  it("proves the replacement image marker before post-rebuild reattachment", () => {
    const result = runLegacyLifecycle(`
(async () => {
  const preparation = await bridge.prepareMcpBridgesForRebuild("alpha");
  let error = "";
  try {
    await bridge.restoreMcpBridgesAfterRebuild("alpha", preparation.entries);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  process.stdout.write(JSON.stringify({
    error,
    attached,
    adapterRegistered,
    providerExists,
    policyApplyCalls,
    markerCalls: adapterCalls.filter((call) =>
      call.includes("deepagents-code --nemoclaw-mcp-capability")
    ).length,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);
    expect(parseResult(result)).toMatchObject({
      error: expect.stringMatching(/does not contain the managed MCP-aware launcher/i),
      attached: false,
      adapterRegistered: false,
      providerExists: true,
      policyApplyCalls: 0,
      markerCalls: 1,
    });
  });

  for (const [label, prepare, restore] of [
    [
      "destroy",
      "prepareMcpBridgesForDestroy",
      "restoreMcpBridgesAfterDestroyAbort('alpha', preparation)",
    ],
    [
      "rebuild",
      "prepareMcpBridgesForRebuild",
      "reattachMcpProvidersAfterRebuildAbort('alpha', preparation.detachedProviderEntries, preparation.scrubbedAdapterEntries)",
    ],
  ] as const) {
    it(`restores the old image when ${label} deletion aborts`, () => {
      const result = runLegacyLifecycle(`
(async () => {
  const preparation = await bridge.${prepare}("alpha");
  await bridge.${restore};
  process.stdout.write(${resultExpression});
})().catch((error) => { console.error(error); process.exit(1); });
`);
      expect(parseResult(result)).toMatchObject({
        attached: true,
        adapterRegistered: true,
        providerExists: true,
        markerCalls: 0,
      });
    });
  }
});
