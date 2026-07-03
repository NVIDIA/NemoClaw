// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function runDestroyLifecycleScenario(body: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-destroy-"));
  const script = `
process.env.HOME = ${JSON.stringify(home)};
const registry = require("./src/lib/state/registry.js");
const globalActions = require("./src/lib/actions/global.js");
const gatewayRuntime = require("./src/lib/gateway-runtime-action.js");
const policies = require("./src/lib/policy/index.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");

const providers = new Map([
  [
    "alpha-mcp-github",
    { credential: "GITHUB_TOKEN", id: "11111111-2222-4333-8444-555555555555" },
  ],
  [
    "alpha-mcp-slack",
    { credential: "SLACK_TOKEN", id: "66666666-7777-4888-8999-000000000000" },
  ],
]);
const attachedProviders = new Set(providers.keys());
const calls = [];
const adapterCalls = [];
let adapterRegistered = true;
let policyApplyCalls = 0;
let failProviderDelete = null;
let failProviderDetach = null;
globalActions.runOpenshellProviderCommand = (args) => {
  calls.push(args.join(" "));
  if (args.join(" ") === "status --output json") {
    return {
      status: 0,
      stdout: "ready",
      stderr: "",
    };
  }
  if (args[0] === "provider" && args[1] === "get") {
    const provider = providers.get(args[2]);
    return provider
      ? { status: 0, stdout: "Id: " + provider.id + "\\nType: generic\\nResource version: 1\\nCredential keys: " + provider.credential + "\\n", stderr: "" }
      : { status: 1, stdout: "", stderr: "Provider not found" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    const names = [...attachedProviders];
    const danglingName = names.find((name) => !providers.has(name));
    if (danglingName) {
      return {
        status: 9,
        stdout: "",
        stderr: "FailedPrecondition: provider '" + danglingName + "' not found",
      };
    }
    return {
      status: 0,
      stdout:
        names.length > 0
          ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\\n" +
            names
              .map((name) => name + " generic 1 0")
              .join("\\n") +
            "\\n"
          : "No providers attached to sandbox " + args[3] + ".\\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    if (failProviderDetach === args[4]) {
      return { status: 9, stdout: "", stderr: "provider detach failed" };
    }
    attachedProviders.delete(args[4]);
    return { status: 0, stdout: "Detached provider", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
    attachedProviders.add(args[4]);
    return { status: 0, stdout: "Attached provider", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "delete") {
    if (failProviderDelete === args[2]) {
      return { status: 9, stdout: "", stderr: "provider delete failed" };
    }
    attachedProviders.delete(args[2]);
    providers.delete(args[2]);
    return { status: 0, stdout: "Deleted provider", stderr: "" };
  }
  throw new Error("Unexpected OpenShell call: " + args.join(" "));
};
gatewayRuntime.recoverNamedGatewayRuntime = async () => ({
  recovered: true,
  attempted: false,
  before: { state: "healthy_named" },
  after: { state: "healthy_named" },
});
policies.applyPresetContent = () => {
  policyApplyCalls += 1;
  return true;
};
policies.getPresetContentGatewayState = () => "match";
policies.removePreset = () => true;
processRecovery.executeSandboxCommand = (_sandbox, command) => {
  adapterCalls.push(command);
  if (command.includes("'config' 'add'")) {
    adapterRegistered = true;
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command.includes('["config", "remove"')) {
    adapterRegistered = false;
    return { status: 0, stdout: "", stderr: "" };
  }
  if (command.includes('["config", "get"')) {
    return {
      status: 0,
      stdout: adapterRegistered ? "registered\\n" : "absent\\n",
      stderr: "",
    };
  }
  return {
    status: 0,
    stdout: command === "command -v mcporter" ? "/usr/local/bin/mcporter\\n" : "",
    stderr: "",
  };
};
processRecovery.executeSandboxExecCommand = (_sandbox, command) => {
  const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] || "";
  const proof = encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
  const isRevisionObservation = proof.includes("printf '%s\\\\n' absent");
  const observedCredential = proof.includes("openshell:resolve:env:GITHUB_TOKEN")
    ? "GITHUB_TOKEN"
    : proof.includes("openshell:resolve:env:SLACK_TOKEN")
      ? "SLACK_TOKEN"
      : null;
  const credentialAttached =
    observedCredential !== null &&
    [...attachedProviders].some(
      (providerName) => providers.get(providerName)?.credential === observedCredential,
    );
  return {
    status:
    proof.includes("allow_all_known_mcp_methods") ||
    proof.includes('[ -z "\${') ||
    proof.includes("openshell:resolve:env:GITHUB_TOKEN") ||
    proof.includes("openshell:resolve:env:SLACK_TOKEN")
      ? 0
      : 1,
    stdout: isRevisionObservation ? (credentialAttached ? "canonical" : "absent") : "",
    stderr: "",
  };
};

const bridgeEntry = (server, credential) => ({
  server,
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://8.8.8.8/" + server,
  env: [credential],
  providerName: "alpha-mcp-" + server,
  providerId: providers.get("alpha-mcp-" + server).id,
  policyName: "mcp-bridge-" + server,
  addedAt: "2026-06-27T00:00:00.000Z",
});
const bridgeEntries = {
  github: bridgeEntry("github", "GITHUB_TOKEN"),
  slack: bridgeEntry("slack", "SLACK_TOKEN"),
};
const ownedPolicy = (server) => ({
  name: "mcp-bridge-" + server,
  content: "network_policies: {}\\n",
  sourcePath: "generated:nemoclaw-mcp-bridge",
});
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

describe("authenticated MCP sandbox destroy lifecycle", () => {
  for (const method of [
    "prepareMcpBridgesForAbsentSandboxDestroy",
    "prepareMcpBridgesForAbsentSandboxRebuild",
  ] as const) {
    it(`clears a providerless preflighted add during ${method}`, () => {
      const result = runDestroyLifecycleScenario(`
providers.delete("alpha-mcp-github");
attachedProviders.delete("alpha-mcp-github");
const pending = { ...bridgeEntries.github, addState: "preflighted" };
delete pending.providerId;
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: pending } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
policies.getPresetContentGatewayState = () => { throw new Error("absent rebuild queried live policy"); };
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.${method}("alpha");
  process.stdout.write(JSON.stringify({ preparation, sandbox: registry.getSandbox("alpha") }));
})().catch((error) => { console.error(error); process.exit(1); });
`);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        preparation: { entries: unknown[] };
        sandbox: { mcp?: unknown; customPolicies?: unknown };
      };
      expect(payload.preparation.entries).toEqual([]);
      expect(payload.sandbox.mcp).toBeUndefined();
      expect(payload.sandbox.customPolicies).toBeUndefined();
    });
  }

  for (const method of [
    "prepareMcpBridgesForRebuild",
    "prepareMcpBridgesForAbsentSandboxRebuild",
  ] as const) {
    for (const marker of ["destroyPreparedAt", "destroyPendingAt"] as const) {
      it(`rejects ${method} while ${marker} is durable`, () => {
        const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: {
    bridges: { github: bridgeEntries.github },
    ${marker}: "2026-07-02T22:49:42.000Z",
  },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  let message = "";
  try {
    await bridge.${method}("alpha");
  } catch (error) {
    message = error.message;
  }
  process.stdout.write(JSON.stringify({
    message,
    sandbox: registry.getSandbox("alpha"),
    calls,
    adapterCalls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const payload = JSON.parse(result.stdout) as {
          message: string;
          sandbox: { mcp: Record<string, unknown> };
          calls: string[];
          adapterCalls: string[];
        };
        expect(payload.message).toContain("incomplete MCP destroy transaction");
        expect(payload.sandbox.mcp).toHaveProperty(marker);
        expect(payload.calls).toEqual([]);
        expect(payload.adapterCalls).toEqual([]);
      });
    }
  }

  it("prepares an absent-sandbox rebuild without adapter exec or provider detach", () => {
    const result = runDestroyLifecycleScenario(`
delete process.env.GITHUB_TOKEN;
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
policies.getPresetContentGatewayState = () => { throw new Error("absent rebuild queried live policy"); };
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForAbsentSandboxRebuild("alpha");
  process.stdout.write(JSON.stringify({
    preparation,
    providers: [...providers.keys()],
    calls,
    adapterCalls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      preparation: {
        entries: unknown[];
        detachedProviderEntries: unknown[];
        scrubbedAdapterEntries: unknown[];
      };
      providers: string[];
      calls: string[];
      adapterCalls: string[];
    };
    expect(payload.preparation.entries).toHaveLength(1);
    expect(payload.preparation.detachedProviderEntries).toEqual([]);
    expect(payload.preparation.scrubbedAdapterEntries).toEqual([]);
    expect(payload.calls).toEqual(["provider get alpha-mcp-github"]);
    expect(payload.adapterCalls).toEqual([]);
    expect(payload.providers).toContain("alpha-mcp-github");
  });

  for (const method of ["prepareMcpBridgesForRebuild"] as const) {
    it(`rejects policy drift before ${method} mutates adapter or provider state`, () => {
      const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
policies.getPresetContentGatewayState = () => "drift";
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  let message = "";
  try {
    await bridge.${method}("alpha");
  } catch (error) {
    message = error.message;
  }
  process.stdout.write(JSON.stringify({ message, calls, adapterCalls }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        message: string;
        calls: string[];
        adapterCalls: string[];
      };
      expect(payload.message).toMatch(/policy.*drift/i);
      expect(payload.calls).toEqual([]);
      expect(payload.adapterCalls).toEqual([]);
    });
  }

  it("rejects an unowned same-name policy record during absent-sandbox rebuild", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", {
  ...ownedPolicy("github"),
  content: "operator-owned-content",
  sourcePath: "/operator/policy.yaml",
});
policies.getPresetContentGatewayState = () => { throw new Error("absent rebuild queried live policy"); };
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  let message = "";
  try {
    await bridge.prepareMcpBridgesForAbsentSandboxRebuild("alpha");
  } catch (error) {
    message = error.message;
  }
  process.stdout.write(JSON.stringify({ message, calls, adapterCalls }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      message: string;
      calls: string[];
      adapterCalls: string[];
    };
    expect(payload.message).toMatch(/unowned same-name registry record/);
    expect(payload.calls).toEqual([]);
    expect(payload.adapterCalls).toEqual([]);
  });

  it("finalizes an externally absent sandbox without attempting sandbox adapter exec", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForAbsentSandboxDestroy("alpha");
  await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation);
  process.stdout.write(JSON.stringify({
    preparation,
    sandbox: registry.getSandbox("alpha"),
    providers: [...providers.keys()],
    calls,
    adapterCalls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      preparation: { entries: unknown[] };
      sandbox: { mcp?: unknown; customPolicies?: unknown };
      providers: string[];
      calls: string[];
      adapterCalls: string[];
    };
    expect(payload.preparation.entries).toHaveLength(1);
    expect(payload.adapterCalls).toEqual([]);
    expect(payload.calls.some((call) => call.includes("sandbox provider"))).toBe(false);
    expect(payload.providers).not.toContain("alpha-mcp-github");
    expect(payload.sandbox.mcp).toBeUndefined();
    expect(payload.sandbox.customPolicies).toBeUndefined();
  });

  it("restores policy, attachment, and adapter without rotating an exported host secret", () => {
    const result = runDestroyLifecycleScenario(`
process.env.GITHUB_TOKEN = "ambient-value-that-must-not-rotate";
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
  await bridge.restoreMcpBridgesAfterDestroyAbort("alpha", preparation);
  process.stdout.write(JSON.stringify({
    sandbox: registry.getSandbox("alpha"),
    providers: [...providers.keys()],
    calls,
    adapterCalls,
    policyApplyCalls,
    secretPresent: Object.prototype.hasOwnProperty.call(process.env, "GITHUB_TOKEN"),
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
      sandbox: {
        mcp: {
          bridges: Record<string, unknown>;
          destroyPreparedAt?: string;
          destroyPendingAt?: string;
        };
      };
      providers: string[];
      calls: string[];
      adapterCalls: string[];
      policyApplyCalls: number;
      secretPresent: boolean;
    };
    expect(payload.secretPresent).toBe(true);
    expect(payload.providers).toContain("alpha-mcp-github");
    expect(
      payload.calls.some((call) => call === "sandbox provider attach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(payload.calls.some((call) => /^provider (create|update) /.test(call))).toBe(false);
    expect(payload.policyApplyCalls).toBe(1);
    expect(payload.adapterCalls).toContain("command -v mcporter");
    expect(
      payload.adapterCalls.some((call) => call.includes("openshell:resolve:env:GITHUB_TOKEN")),
    ).toBe(true);
    expect(payload.sandbox.mcp.bridges).toHaveProperty("github");
    expect(payload.sandbox.mcp.destroyPreparedAt).toBeUndefined();
    expect(payload.sandbox.mcp.destroyPendingAt).toBeUndefined();
  });

  it("restores the durable destroy marker when abort rollback fails", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
  policies.applyPresetContent = () => false;
  let error = "";
  try {
    await bridge.restoreMcpBridgesAfterDestroyAbort("alpha", preparation);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  process.stdout.write(JSON.stringify({
    error,
    sandbox: registry.getSandbox("alpha"),
    attached: [...attachedProviders],
    adapterRegistered,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      error: string;
      sandbox: {
        mcp: { bridges: Record<string, unknown>; destroyPreparedAt?: string };
      };
      attached: string[];
      adapterRegistered: boolean;
    };
    expect(payload.error).toMatch(/failed to activate generated MCP policy/i);
    expect(payload.sandbox.mcp.bridges).toHaveProperty("github");
    expect(payload.sandbox.mcp.destroyPreparedAt).toBeTruthy();
    expect(payload.attached).not.toContain("alpha-mcp-github");
    expect(payload.adapterRegistered).toBe(false);
  });

  it("preserves credentials and bridge state until sandbox deletion is confirmed", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
registry.addCustomPolicy("alpha", { name: "operator", content: "version: 1\\n" });
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
  const afterPrepare = registry.getSandbox("alpha");
  await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation);
  const afterFinalize = registry.getSandbox("alpha");
  process.stdout.write(JSON.stringify({
    afterPrepare,
    afterFinalize,
    providers: [...providers.keys()],
    calls,
    adapterCalls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      afterPrepare: {
        mcp: {
          bridges: Record<string, unknown>;
          destroyPreparedAt?: string;
          destroyPendingAt?: string;
        };
        customPolicies: Array<{ name: string }>;
      };
      afterFinalize: {
        mcp?: unknown;
        customPolicies: Array<{ name: string }>;
      };
      providers: string[];
      calls: string[];
      adapterCalls: string[];
    };
    expect(payload.afterPrepare.mcp.bridges).toHaveProperty("github");
    expect(payload.afterPrepare.mcp.destroyPreparedAt).toBeTruthy();
    expect(payload.afterPrepare.mcp.destroyPendingAt).toBeUndefined();
    expect(payload.afterPrepare.customPolicies.map((policy) => policy.name)).toContain(
      "mcp-bridge-github",
    );
    expect(payload.afterFinalize.mcp).toBeUndefined();
    expect(payload.afterFinalize.customPolicies.map((policy) => policy.name)).toEqual(["operator"]);
    expect(payload.providers).not.toContain("alpha-mcp-github");
    expect(
      payload.calls.some((call) => call === "sandbox provider detach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(
      payload.adapterCalls.some((call) => call.includes("config") && call.includes("remove")),
    ).toBe(true);
  });

  it("restores a rebuilt sandbox without rotating an exported MCP credential", () => {
    const result = runDestroyLifecycleScenario(`
process.env.GITHUB_TOKEN = "ambient-value-that-must-not-rotate";
attachedProviders.delete("alpha-mcp-github");
adapterRegistered = false;
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  await bridge.restoreMcpBridgesAfterRebuild("alpha", [bridgeEntries.github]);
  process.stdout.write(JSON.stringify({
    calls,
    attached: [...attachedProviders],
    adapterRegistered,
    policyApplyCalls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
      calls: string[];
      attached: string[];
      adapterRegistered: boolean;
      policyApplyCalls: number;
    };
    expect(payload.calls.some((call) => /^provider (create|update) /.test(call))).toBe(false);
    expect(payload.attached).toContain("alpha-mcp-github");
    expect(payload.adapterRegistered).toBe(true);
    expect(payload.policyApplyCalls).toBe(1);
  });

  for (const [label, prepareFunction] of [
    ["destroy", "prepareMcpBridgesForDestroy"],
    ["rebuild", "prepareMcpBridgesForRebuild"],
  ] as const) {
    it(`reattaches an already-absent first provider when a later ${label} detach fails`, () => {
      const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: bridgeEntries },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
registry.addCustomPolicy("alpha", ownedPolicy("slack"));
// Simulate a prior process dying after the first detach but before a durable
// prepared marker. The retry must own rollback of this already-absent binding.
attachedProviders.delete("alpha-mcp-github");
failProviderDetach = "alpha-mcp-slack";
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  let message = "";
  try {
    await bridge.${prepareFunction}("alpha");
  } catch (error) {
    message = error.message;
  }
  process.stdout.write(JSON.stringify({
    message,
    attached: [...attachedProviders].sort(),
    calls,
    adapterRegistered,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        message: string;
        attached: string[];
        calls: string[];
        adapterRegistered: boolean;
      };
      expect(payload.message).toContain("provider detach failed");
      expect(payload.attached).toEqual(["alpha-mcp-github", "alpha-mcp-slack"]);
      expect(
        payload.calls.some((call) => call === "sandbox provider attach alpha alpha-mcp-github"),
      ).toBe(true);
      expect(payload.adapterRegistered).toBe(true);
    });
  }

  it("reattaches every desired provider when rebuild deletion aborts after a retry", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  mcp: { bridges: bridgeEntries },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
registry.addCustomPolicy("alpha", ownedPolicy("slack"));
// The first rebuild process died after detaching github. A retry completes
// preparation, then sandbox deletion is modeled as failed by invoking abort.
attachedProviders.delete("alpha-mcp-github");
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForRebuild("alpha");
  const detachedBeforeAbort = [...attachedProviders].sort();
  await bridge.reattachMcpProvidersAfterRebuildAbort(
    "alpha",
    preparation.detachedProviderEntries,
    preparation.scrubbedAdapterEntries,
  );
  process.stdout.write(JSON.stringify({
    preparation,
    detachedBeforeAbort,
    attachedAfterAbort: [...attachedProviders].sort(),
    calls,
    adapterRegistered,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      preparation: { detachedProviderEntries: unknown[] };
      detachedBeforeAbort: string[];
      attachedAfterAbort: string[];
      calls: string[];
      adapterRegistered: boolean;
    };
    expect(payload.preparation.detachedProviderEntries).toHaveLength(2);
    expect(payload.detachedBeforeAbort).toEqual([]);
    expect(payload.attachedAfterAbort).toEqual(["alpha-mcp-github", "alpha-mcp-slack"]);
    expect(
      payload.calls.some((call) => call === "sandbox provider attach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(payload.adapterRegistered).toBe(true);
  });

  it("keeps a pending manifest after partial provider deletion and completes on retry", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: bridgeEntries },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
registry.addCustomPolicy("alpha", ownedPolicy("slack"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
  failProviderDelete = "alpha-mcp-slack";
  let firstError = "";
  try {
    await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation, { force: true });
  } catch (error) {
    firstError = error.message;
  }
  const afterFailure = registry.getSandbox("alpha");
  failProviderDelete = null;
  const retry = await bridge.prepareMcpBridgesForDestroy("alpha");
  await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", retry, { force: true });
  process.stdout.write(JSON.stringify({
    firstError,
    afterFailure,
    retry,
    afterRetry: registry.getSandbox("alpha"),
    providers: [...providers.keys()],
    calls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      firstError: string;
      afterFailure: {
        mcp: {
          bridges: Record<string, unknown>;
          destroyPreparedAt?: string;
          destroyPendingAt?: string;
        };
        customPolicies: Array<{ name: string }>;
      };
      retry: { destroyAlreadyPending: boolean };
      afterRetry: { mcp?: unknown; customPolicies?: unknown };
      providers: string[];
      calls: string[];
    };
    expect(payload.firstError).toContain("provider delete failed");
    expect(payload.afterFailure.mcp.destroyPendingAt).toBeTruthy();
    expect(payload.afterFailure.mcp.destroyPreparedAt).toBeUndefined();
    expect(Object.keys(payload.afterFailure.mcp.bridges)).toEqual(["github", "slack"]);
    expect(payload.afterFailure.customPolicies).toHaveLength(2);
    expect(payload.retry.destroyAlreadyPending).toBe(true);
    expect(payload.afterRetry.mcp).toBeUndefined();
    expect(payload.afterRetry.customPolicies).toBeUndefined();
    expect(payload.providers).toEqual([]);
    expect(
      payload.calls.filter((call) => call === "sandbox provider detach alpha alpha-mcp-github"),
    ).toHaveLength(1);
  });

  it("resumes from the durable prepared phase after delete-before-finalize interruption", () => {
    const result = runDestroyLifecycleScenario(`
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: bridgeEntries.github } },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  await bridge.prepareMcpBridgesForDestroy("alpha");
  const callsAfterFirstPrepare = calls.length;
  const adapterCallsAfterFirstPrepare = adapterCalls.length;
  const retry = await bridge.prepareMcpBridgesForDestroy("alpha");
  await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", retry);
  process.stdout.write(JSON.stringify({
    callsAfterFirstPrepare,
    adapterCallsAfterFirstPrepare,
    calls,
    adapterCalls,
    retry,
    sandbox: registry.getSandbox("alpha"),
    providers: [...providers.keys()],
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      callsAfterFirstPrepare: number;
      adapterCallsAfterFirstPrepare: number;
      calls: string[];
      adapterCalls: string[];
      retry: {
        destroyAlreadyPrepared: boolean;
        destroyAlreadyPending: boolean;
      };
      sandbox: { mcp?: unknown };
      providers: string[];
    };
    expect(payload.retry.destroyAlreadyPrepared).toBe(true);
    expect(payload.retry.destroyAlreadyPending).toBe(false);
    expect(
      payload.calls
        .slice(0, payload.callsAfterFirstPrepare)
        .some((call) => call === "sandbox provider detach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(
      payload.calls
        .slice(payload.callsAfterFirstPrepare)
        .filter((call) => call.includes("sandbox provider detach")),
    ).toEqual([]);
    expect(payload.adapterCalls).toHaveLength(payload.adapterCallsAfterFirstPrepare);
    expect(payload.sandbox.mcp).toBeUndefined();
    expect(payload.providers).not.toContain("alpha-mcp-github");
  });

  it("does not let force delete a drifted global provider", () => {
    const result = runDestroyLifecycleScenario(`
providers.set("alpha-mcp-github", {
  credential: "OTHER_TOKEN",
  id: "11111111-2222-4333-8444-555555555555",
});
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  mcp: {
    bridges: { github: bridgeEntries.github },
    destroyPendingAt: "2026-06-27T01:00:00.000Z",
  },
});
registry.addCustomPolicy("alpha", ownedPolicy("github"));
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  const sandbox = registry.getSandbox("alpha");
  const preparation = {
    entries: Object.values(sandbox.mcp.bridges),
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: true,
  };
  let message = "";
  try {
    await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation, { force: true });
  } catch (error) {
    message = error.message;
  }
  process.stdout.write(JSON.stringify({
    message,
    sandbox: registry.getSandbox("alpha"),
    providers: [...providers.keys()],
    calls,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      message: string;
      sandbox: { mcp: { bridges: Record<string, unknown> } };
      providers: string[];
      calls: string[];
    };
    expect(payload.message).toContain("no longer exactly matches");
    expect(payload.message).toContain("--force does not delete");
    expect(payload.sandbox.mcp.bridges).toHaveProperty("github");
    expect(payload.providers).toContain("alpha-mcp-github");
    expect(payload.calls.some((call) => call.startsWith("provider delete alpha-mcp-github "))).toBe(
      false,
    );
  });
});
