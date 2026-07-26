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
let policyState = "match";
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
    return { status: 0, stdout: "ready", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: " + liveId + "\\nType: generic\\nResource version: 4\\nCredential keys: EXPECTED_TOKEN\\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: attached
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\\nalpha-mcp-fake generic 1 0\\n"
        : "No providers attached to sandbox alpha.\\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    attached = false;
    return { status: 0, stdout: "detached", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
policies.getPresetContentGatewayState = () => policyState;
policies.removePreset = () => {
  if (swapAt === "delete") liveId = foreignId;
  policyState = "absent";
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

function runLegacyReservedCredentialCleanup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-provider-legacy-cleanup-"));
  const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const agentDefs = require("./src/lib/agent/defs.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const globalActions = require("./src/lib/actions/global.js");
const expectedId = "11111111-2222-4333-8444-555555555555";
let providerExists = true;
let attached = true;
let policyState = "match";
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
  if (args[0] === "status") return { status: 0, stdout: "ready", stderr: "" };
  if (args[0] === "provider" && args[1] === "get") {
    return providerExists
      ? {
          status: 0,
          stdout: "Id: " + expectedId + "\nType: generic\nResource version: 4\nCredential keys: LD_PRELOAD\n",
          stderr: "",
        }
      : { status: 1, stdout: "", stderr: "NotFound: provider" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: attached
        ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-fake generic 1 0\n"
        : "No providers attached to sandbox alpha.\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    attached = false;
    return { status: 0, stdout: "Detached provider alpha-mcp-fake from sandbox alpha.", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "delete") {
    providerExists = false;
    return { status: 0, stdout: "deleted", stderr: "" };
  }
  throw new Error("unexpected call: " + args.join(" "));
};
policies.getPresetContentGatewayState = () => policyState;
policies.removePreset = () => { policyState = "absent"; return true; };
const runSandboxChild = () => {
  calls.push("sandbox-child attached=" + attached);
  if (attached) throw new Error("sandbox child started while LD_PRELOAD remained attached");
  return { status: 0, stdout: "", stderr: "" };
};
processRecovery.executeSandboxCommand = runSandboxChild;
processRecovery.executeSandboxExecCommand = runSandboxChild;
const entry = {
  server: "fake",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: ["LD_PRELOAD"],
  providerName: "alpha-mcp-fake",
  providerId: expectedId,
  policyName: "mcp-bridge-fake",
  addedAt: "2026-06-01T00:00:00.000Z",
};
registry.registerSandbox({
  name: "alpha",
  agent: "legacy-disabled",
  mcp: { bridges: { fake: entry } },
});
registry.addCustomPolicy("alpha", {
  name: entry.policyName,
  content: "network_policies: {}\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
bridge.removeMcpBridge("alpha", "fake").then(
  () => process.stdout.write(JSON.stringify({
    calls,
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.fake,
    providerExists,
    attached,
  })),
  (error) => { console.error(error); process.exit(1); },
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
      ).toBe(boundary === "delete");
      expect(payload.bridgePresent).toBe(true);
    });
  }

  it("removes an exact legacy provider whose credential name is now reserved", () => {
    const result = runLegacyReservedCredentialCleanup();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
      calls: string[];
      bridgePresent: boolean;
      providerExists: boolean;
      attached: boolean;
    };
    expect(payload).toMatchObject({
      bridgePresent: false,
      providerExists: false,
      attached: false,
    });
    expect(payload.calls).toContain("sandbox provider detach alpha alpha-mcp-fake");
    expect(payload.calls).toContain("provider delete alpha-mcp-fake");
    expect(payload.calls.indexOf("sandbox provider detach alpha alpha-mcp-fake")).toBeLessThan(
      payload.calls.indexOf("sandbox-child attached=false"),
    );
  });

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
      stdout: "Id: 99999999-8888-4777-8666-555555555555\nType: generic\nResource version: 4\nCredential keys: EXPECTED_TOKEN\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return {
      status: 0,
      stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-fake generic 1 0\n",
      stderr: "",
    };
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

  it("clears multiple dangling stock OpenShell provider references without listing between them", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-provider-dangling-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
const globalActions = require("./src/lib/actions/global.js");
const calls = [];
const attached = new Set(["alpha-mcp-fake", "alpha-mcp-second"]);
globalActions.runOpenshellProviderCommand = (args) => {
  calls.push(args.join(" "));
  if (args[0] === "provider" && args[1] === "get") {
    return { status: 1, stdout: "", stderr: "NotFound: provider" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return attached.size > 0
      ? { status: 9, stdout: "", stderr: "FailedPrecondition: provider '" + [...attached][0] + "' not found" }
      : { status: 0, stdout: "No providers attached to sandbox alpha.\n", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    attached.delete(args[4]);
    return {
      status: 0,
      stdout: "Detached provider " + args[4] + " from sandbox alpha.\n",
      stderr: "",
    };
  }
  throw new Error("unexpected call: " + args.join(" "));
};
const providerActions = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const entry = {
  server: "fake",
  agent: "openclaw",
  url: "https://mcp.example.test/mcp",
  env: ["EXPECTED_TOKEN"],
  providerName: "alpha-mcp-fake",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-fake",
  adapter: "mcporter",
  addedAt: "2026-06-01T00:00:00.000Z",
};
const before = providerActions.inspectMcpProviderAttachments("alpha");
const firstOutcome = providerActions.detachMissingProviderReference("alpha", entry);
const afterFirst = providerActions.inspectMcpProviderAttachments("alpha");
const secondOutcome = providerActions.detachMissingProviderReference("alpha", {
  ...entry,
  server: "second",
  providerName: "alpha-mcp-second",
  providerId: "22222222-3333-4444-8555-666666666666",
  policyName: "mcp-bridge-second",
});
const after = providerActions.inspectMcpProviderAttachments("alpha");
process.stdout.write(JSON.stringify({ before, firstOutcome, afterFirst, secondOutcome, after, calls }));
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      before: { attachments: null; error: string };
      firstOutcome: string;
      afterFirst: { attachments: null; error: string };
      secondOutcome: string;
      after: { attachments: unknown[] };
      calls: string[];
    };
    expect(payload.before.attachments).toBeNull();
    expect(payload.before.error).toContain("provider 'alpha-mcp-fake' not found");
    expect(payload.firstOutcome).toBe("detached");
    expect(payload.afterFirst.attachments).toBeNull();
    expect(payload.afterFirst.error).toContain("provider 'alpha-mcp-second' not found");
    expect(payload.secondOutcome).toBe("detached");
    expect(payload.after.attachments).toEqual([]);
    expect(payload.calls).toEqual([
      "sandbox provider list alpha",
      "provider get alpha-mcp-fake",
      "sandbox provider detach alpha alpha-mcp-fake",
      "provider get alpha-mcp-fake",
      "sandbox provider list alpha",
      "provider get alpha-mcp-second",
      "sandbox provider detach alpha alpha-mcp-second",
      "provider get alpha-mcp-second",
      "sandbox provider list alpha",
    ]);
  });

  it("does not treat a concurrent writer's resource-version advance as our update", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-provider-update-race-"));
    const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.EXPECTED_TOKEN = "host-only-secret";
const globalActions = require("./src/lib/actions/global.js");
const calls = [];
let resourceVersion = 4;
globalActions.runOpenshellProviderCommand = (args) => {
  calls.push(args.join(" "));
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: " + resourceVersion + "\nCredential keys: EXPECTED_TOKEN\n",
      stderr: "",
    };
  }
  if (args[0] === "provider" && args[1] === "update") {
    resourceVersion = 5;
    return {
      status: 9,
      stdout: "",
      stderr: "Aborted: provider was modified concurrently (current resource_version: 5)",
    };
  }
  throw new Error("unexpected call: " + args.join(" "));
};
const providerActions = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
let message = "";
try {
  providerActions.upsertMcpProvider(
    "alpha-mcp-fake",
    [{ name: "EXPECTED_TOKEN" }],
    {
      allowExisting: true,
      expectedProviderId: "11111111-2222-4333-8444-555555555555",
    },
  );
} catch (error) {
  message = error.message;
}
process.stdout.write(JSON.stringify({ message, resourceVersion, calls }));
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    fs.rmSync(home, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      message: string;
      resourceVersion: number;
      calls: string[];
    };
    expect(payload.resourceVersion).toBe(5);
    expect(payload.message).toContain("modified concurrently");
    expect(payload.calls).toEqual([
      "provider get alpha-mcp-fake",
      "provider get alpha-mcp-fake",
      "provider update alpha-mcp-fake --credential EXPECTED_TOKEN",
    ]);
    expect(JSON.stringify(payload.calls)).not.toContain("host-only-secret");
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
    return { status: 0, stdout: "ready", stderr: "" };
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
