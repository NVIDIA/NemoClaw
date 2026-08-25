// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../src/lib/agent/defs";
import type { McpBridgeEntry } from "../../src/lib/state/registry";
import { mockManagedEndpointlessProviderProfileRun } from "../helpers/onboard-script-mocks.cjs";

const testState = vi.hoisted(() => {
  const home = `/tmp/nemoclaw-mcp-destroy-${process.pid}-${Date.now()}`;
  const originalEnv = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HOME: process.env.HOME,
    NEMOCLAW_OPENSHELL_BIN: process.env.NEMOCLAW_OPENSHELL_BIN,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY,
    SLACK_TOKEN: process.env.SLACK_TOKEN,
  };
  process.env.HOME = home;

  return {
    adapterCalls: [] as string[],
    adapterRegistered: true,
    applyPresetContent: vi.fn(),
    calls: [] as string[],
    captureOpenshell: vi.fn(),
    executeGatewaySupervisorAction: vi.fn(),
    executeSandboxCommand: vi.fn(),
    executeSandboxExecCommand: vi.fn(),
    failProviderDelete: null as string | null,
    failProviderDetach: null as string | null,
    getLiveSandboxPolicyEntryDigest: vi.fn(),
    getPresetContentGatewayState: vi.fn(),
    home,
    originalEnv,
    policyApplyCalls: 0,
    removedPolicyKeys: new Set<string>(),
    providers: new Map<string, { credential: string; id: string; resourceVersion?: number }>(),
    resolveHostAddresses: vi.fn(),
    attachedProviders: new Set<string>(),
    recoverNamedGatewayRuntime: vi.fn(),
    removePreset: vi.fn(),
    runOpenshell: vi.fn(),
    runOpenshellProviderCommand: vi.fn(),
    stopNimContainer: vi.fn(),
    stopNimContainerByName: vi.fn(),
    warnUnpreservedUserManagedFiles: vi.fn(),
  };
});

vi.mock("../../src/lib/adapters/openshell/provider-command", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
  runOpenshellProviderCommand: testState.runOpenshellProviderCommand,
}));
vi.mock("../../src/lib/adapters/dns/resolve", () => ({
  resolveHostAddresses: testState.resolveHostAddresses,
}));

vi.mock("../../src/lib/adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/adapters/openshell/runtime")>()),
  captureOpenshell: testState.captureOpenshell,
  runOpenshell: testState.runOpenshell,
}));

vi.mock("../../src/lib/gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: testState.recoverNamedGatewayRuntime,
}));

vi.mock("../../src/lib/policy", () => ({
  applyPresetContent: testState.applyPresetContent,
  getLiveSandboxPolicyEntryDigest: testState.getLiveSandboxPolicyEntryDigest,
  getPresetContentGatewayState: testState.getPresetContentGatewayState,
  removePreset: testState.removePreset,
}));

vi.mock("../../src/lib/actions/sandbox/process-recovery", () => ({
  executeGatewaySupervisorAction: testState.executeGatewaySupervisorAction,
  executeSandboxCommand: testState.executeSandboxCommand,
  executeSandboxExecCommand: testState.executeSandboxExecCommand,
}));

vi.mock("../../src/lib/actions/sandbox/rebuild-flow-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/actions/sandbox/rebuild-flow-helpers")>()),
  warnUnpreservedUserManagedFiles: testState.warnUnpreservedUserManagedFiles,
}));

vi.mock("../../src/lib/inference/nim", () => ({
  stopNimContainer: testState.stopNimContainer,
  stopNimContainerByName: testState.stopNimContainerByName,
}));

import * as bridge from "../../src/lib/actions/sandbox/mcp-bridge";
import { isAgentMcpAdapter } from "../../src/lib/actions/sandbox/mcp-bridge-contracts";
import { runRebuildDestroyPhase } from "../../src/lib/actions/sandbox/rebuild-destroy-phase";
import type { RebuildRecreateJournal } from "../../src/lib/actions/sandbox/rebuild-recreate-journal";
import * as registry from "../../src/lib/state/registry";

function stubRecreateJournal(): RebuildRecreateJournal {
  return {
    id: "journal-1",
    acceptedTarget: false,
    sourceConfirmedAbsent: false,
    gatewayAuthority: {
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    },
    targetGeneration: "generation-1",
    targetIntentFingerprint: "intent-1",
    markDeleting: vi.fn(),
    observeSourceForDelete: vi.fn(() => "source" as const),
    confirmDeleted: vi.fn(),
    completeAcceptedTarget: vi.fn(),
  };
}

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.106");

const bridgeEntries: Record<"github" | "slack", McpBridgeEntry> = {
  github: {
    server: "github",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://8.8.8.8/github",
    env: ["GITHUB_TOKEN"],
    providerName: "alpha-mcp-github",
    providerId: "11111111-2222-4333-8444-555555555555",
    policyName: "mcp-bridge-github",
    addedAt: "2026-06-27T00:00:00.000Z",
  },
  slack: {
    server: "slack",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://8.8.8.8/slack",
    env: ["SLACK_TOKEN"],
    providerName: "alpha-mcp-slack",
    providerId: "66666666-7777-4888-8999-000000000000",
    policyName: "mcp-bridge-slack",
    addedAt: "2026-06-27T00:00:00.000Z",
  },
};
function ownedPolicy(
  server: "github" | "slack",
  options: {
    adapter?: AgentMcpAdapter;
    entry?: McpBridgeEntry;
    resolvedAddresses?: readonly string[];
  } = {},
) {
  const entry = options.entry ?? bridgeEntries[server];
  const adapter = options.adapter ?? entry.adapter;
  expect(isAgentMcpAdapter(adapter), "MCP policy fixture requires an explicit adapter").toBe(true);
  const resolvedAddresses = options.resolvedAddresses ?? [new URL(entry.url).hostname];
  return {
    name: entry.policyName,
    content: bridge.buildMcpBridgePolicyYaml(entry.server, entry.url, adapter as AgentMcpAdapter, {
      addresses: [...resolvedAddresses],
    }, entry.providerName ?? ""),
    sourcePath: "generated:nemoclaw-mcp-bridge",
  };
}
function restoreEnv(name: string, value: string | undefined): void {
  switch (value) {
    case undefined:
      delete process.env[name];
      break;
    default:
      process.env[name] = value;
  }
}
async function captureMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
function registerAlphaGithubBridge(): void {
  registry.registerSandbox({
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    mcp: { bridges: { github: bridgeEntries.github } },
  });
  registry.addCustomPolicy("alpha", ownedPolicy("github"));
}
beforeEach(() => {
  fs.rmSync(testState.home, { recursive: true, force: true });
  process.env.HOME = testState.home;
  process.env.NEMOCLAW_OPENSHELL_BIN = MATCHING_OPENSHELL;
  delete process.env.GITHUB_TOKEN;
  delete process.env.SLACK_TOKEN;
  delete process.env.OPENSHELL_GATEWAY;

  testState.providers.clear();
  testState.providers.set("alpha-mcp-github", {
    credential: "GITHUB_TOKEN",
    id: "11111111-2222-4333-8444-555555555555",
  });
  testState.providers.set("alpha-mcp-slack", {
    credential: "SLACK_TOKEN",
    id: "66666666-7777-4888-8999-000000000000",
  });
  testState.attachedProviders.clear();
  testState.attachedProviders.add("alpha-mcp-github");
  testState.attachedProviders.add("alpha-mcp-slack");
  testState.calls.length = 0;
  testState.adapterCalls.length = 0;
  testState.adapterRegistered = true;
  testState.policyApplyCalls = 0;
  testState.removedPolicyKeys.clear();
  testState.failProviderDelete = null;
  testState.failProviderDetach = null;
  vi.resetAllMocks();
  testState.recoverNamedGatewayRuntime.mockResolvedValue({
    recovered: true,
    attempted: false,
    before: { state: "healthy_named" },
    after: { state: "healthy_named" },
  });
  testState.applyPresetContent.mockImplementation((_sandboxName, policyName) => {
    testState.policyApplyCalls += 1;
    testState.removedPolicyKeys.delete(policyName.replaceAll("-", "_"));
    return true;
  });
  testState.getPresetContentGatewayState.mockImplementation((_sandboxName, content) =>
    testState.removedPolicyKeys.has(
      /^preset:\n\s+name:\s+(\S+)$/m.exec(content)?.[1]?.replaceAll("-", "_") ?? "",
    )
      ? "absent"
      : "match",
  );
  testState.getLiveSandboxPolicyEntryDigest.mockImplementation((_sandboxName, policyKey) =>
    testState.removedPolicyKeys.has(policyKey) ? null : "present",
  );
  testState.removePreset.mockImplementation((_sandboxName, policyName) => {
    testState.removedPolicyKeys.add(policyName.replaceAll("-", "_"));
    return true;
  });
  testState.runOpenshell.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  testState.resolveHostAddresses.mockImplementation(async (host: string) => [{ address: host }]);
  testState.runOpenshellProviderCommand.mockImplementation((args: string[]) => {
    testState.calls.push(args.join(" "));
    switch (args.join(" ")) {
      case "status --output json":
        return { status: 0, stdout: "ready", stderr: "" };
    }
    switch (true) {
      case args[0] === "provider" && args[1] === "profile": return mockManagedEndpointlessProviderProfileRun(args) ?? { status: 0, stdout: "Imported provider profile", stderr: "" };
      case args[0] === "provider" && args[1] === "get": {
        const provider = testState.providers.get(args[2]);
        return provider
          ? {
              status: 0,
              stdout: `Id: ${provider.id}\nType: nemoclaw-mcp-v1\nResource version: ${provider.resourceVersion ?? 1}\nCredential keys: ${provider.credential}\n`,
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "Provider not found" };
      }
    }
    switch (true) {
      case args[0] === "sandbox" && args[1] === "provider" && args[2] === "list": {
        const names = [...testState.attachedProviders];
        const danglingName = names.find((name) => !testState.providers.has(name));
        return danglingName
          ? {
              status: 9,
              stdout: "",
              stderr: `FailedPrecondition: provider '${danglingName}' not found`,
            }
          : {
              status: 0,
              stdout:
                names.length > 0
                  ? `NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n${names
                      .map((name) => `${name} nemoclaw-mcp-v1 1 0`)
                      .join("\n")}\n`
                  : `No providers attached to sandbox ${args[3]}.\n`,
              stderr: "",
            };
      }
    }
    switch (true) {
      case args[0] === "sandbox" &&
        args[1] === "provider" &&
        args[2] === "detach" &&
        testState.failProviderDetach === args[4]:
        return { status: 9, stdout: "", stderr: "provider detach failed" };
      case args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach":
        testState.attachedProviders.delete(args[4]);
        return { status: 0, stdout: "Detached provider", stderr: "" };
      case args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach":
        testState.attachedProviders.add(args[4]);
        return { status: 0, stdout: "Attached provider", stderr: "" };
      case args[0] === "provider" && args[1] === "update" && args.length === 3 && testState.providers.has(args[2]):
        testState.providers.get(args[2])!.resourceVersion = (testState.providers.get(args[2])!.resourceVersion ?? 1) + 1;
        return { status: 0, stdout: "Updated provider", stderr: "" };
      case args[0] === "provider" &&
        args[1] === "delete" &&
        testState.failProviderDelete === args[2]:
        return { status: 9, stdout: "", stderr: "provider delete failed" };
      case args[0] === "provider" && args[1] === "delete":
        testState.attachedProviders.delete(args[2]);
        testState.providers.delete(args[2]);
        return { status: 0, stdout: "Deleted provider", stderr: "" };
      default:
        throw new Error(`Unexpected OpenShell call: ${args.join(" ")}`);
    }
  });

  testState.executeSandboxCommand.mockImplementation((_sandbox: string, command: string) => {
    testState.adapterCalls.push(command);
    switch (true) {
      case command.includes("'config' 'add'"):
        testState.adapterRegistered = true;
        return { status: 0, stdout: "", stderr: "" };
      case command.includes('"config", "--config"') && command.includes('"remove"'):
        testState.adapterRegistered = false;
        return { status: 0, stdout: "", stderr: "" };
      case command.includes('"config", "get"'):
        return {
          status: 0,
          stdout: testState.adapterRegistered ? "registered\n" : "absent\n",
          stderr: "",
        };
      default:
        return {
          status: 0,
          stdout: command === "command -v mcporter" ? "/usr/local/bin/mcporter\n" : "",
          stderr: "",
        };
    }
  });

  testState.executeSandboxExecCommand.mockImplementation((_sandbox: string, command: string) => {
    const isNoopProbe = command === ":";
    const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? "";
    const proof = encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
    const isRevisionObservation = proof.includes("printf '%s\\n' absent");
    const observedCredential = proof.includes("openshell:resolve:env:GITHUB_TOKEN")
      ? "GITHUB_TOKEN"
      : proof.includes("openshell:resolve:env:SLACK_TOKEN")
        ? "SLACK_TOKEN"
        : null;
    const credentialAttached =
      observedCredential !== null &&
      [...testState.attachedProviders].some(
        (providerName) => testState.providers.get(providerName)?.credential === observedCredential,
      );
    return {
      status:
        isNoopProbe ||
        proof.includes("allow_all_known_mcp_methods") ||
        proof.includes('[ -z "${') ||
        proof.includes("openshell:resolve:env:GITHUB_TOKEN") ||
        proof.includes("openshell:resolve:env:SLACK_TOKEN")
          ? 0
          : 1,
      stdout: isRevisionObservation ? (credentialAttached ? "canonical" : "absent") : "",
      stderr: "",
    };
  });
});

afterAll(() => {
  fs.rmSync(testState.home, { recursive: true, force: true });
  for (const [name, value] of Object.entries(testState.originalEnv)) restoreEnv(name, value);
});

describe("authenticated MCP sandbox destroy lifecycle", () => {
  it.each([
    "prepareMcpBridgesForAbsentSandboxDestroy",
    "prepareMcpBridgesForAbsentSandboxRebuild",
  ] as const)("clears a providerless preflighted add during %s", async (method) => {
    testState.providers.delete("alpha-mcp-github");
    testState.attachedProviders.delete("alpha-mcp-github");
    const pending: McpBridgeEntry = { ...bridgeEntries.github, addState: "preflighted" };
    delete pending.providerId;
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: { bridges: { github: pending } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    testState.getPresetContentGatewayState.mockImplementation(() => {
      throw new Error("absent rebuild queried live policy");
    });

    const preparation = await bridge[method]("alpha");
    const sandbox = registry.getSandbox("alpha");

    expect(preparation.entries).toEqual([]);
    expect(sandbox?.mcp).toBeUndefined();
    expect(sandbox?.customPolicies).toBeUndefined();
  });

  it.each([
    ["prepareMcpBridgesForRebuild", "destroyPreparedAt"],
    ["prepareMcpBridgesForRebuild", "destroyPendingAt"],
    ["prepareMcpBridgesForAbsentSandboxRebuild", "destroyPreparedAt"],
    ["prepareMcpBridgesForAbsentSandboxRebuild", "destroyPendingAt"],
  ] as const)("rejects %s while %s is durable", async (method, marker) => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: {
        bridges: { github: bridgeEntries.github },
        [marker]: "2026-07-02T22:49:42.000Z",
      },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));

    const message = await captureMessage(() => bridge[method]("alpha"));
    const sandbox = registry.getSandbox("alpha");

    // #6376: the guard message is phase-aware — the pending (phase-two)
    // marker records confirmed sandbox deletion, so it points at finishing
    // the destroy rather than the in-place `mcp remove --force` recovery.
    expect(message).toContain(
      marker === "destroyPendingAt"
        ? "past the point of no return"
        : "incomplete MCP destroy transaction",
    );
    expect(sandbox?.mcp).toHaveProperty(marker);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
  });

  it("prepares an absent-sandbox rebuild without adapter exec or provider detach", async () => {
    registerAlphaGithubBridge();
    testState.getPresetContentGatewayState.mockImplementation(() => {
      throw new Error("absent rebuild queried live policy");
    });

    const preparation = await bridge.prepareMcpBridgesForAbsentSandboxRebuild("alpha");

    expect(preparation.entries).toHaveLength(1);
    expect(preparation.detachedProviderEntries).toEqual([]);
    expect(preparation.scrubbedAdapterEntries).toEqual([]);
    expect(testState.calls).toEqual(["provider get alpha-mcp-github"]);
    expect(testState.adapterCalls).toEqual([]);
    expect([...testState.providers.keys()]).toContain("alpha-mcp-github");
  });

  it.each([
    "prepareMcpBridgesForRebuild",
    "prepareMcpBridgesForAbsentSandboxRebuild",
    "prepareMcpBridgesForExecUnavailableRebuild",
  ] as const)("rejects a registered credential collision during %s (#9388)", async (method) => {
    registerAlphaGithubBridge();
    registry.addExtraProvider("example-api");
    testState.providers.set("example-api", {
      credential: "GITHUB_TOKEN",
      id: "99999999-8888-4777-8666-555555555555",
    });
    const before = registry.getSandbox("alpha");
    const message = await captureMessage(() => bridge[method]("alpha"));

    expect(message).toContain("already supplied by registered provider 'example-api'");
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.attachedProviders.has("example-api")).toBe(false);
    expect(testState.calls.some((call) => call.startsWith("sandbox provider detach"))).toBe(false);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("retains a providerless preflighted add when exec-unavailable recovery refuses it (#7062)", async () => {
    testState.providers.delete("alpha-mcp-github");
    testState.attachedProviders.delete("alpha-mcp-github");
    const pending: McpBridgeEntry = { ...bridgeEntries.github, addState: "preflighted" };
    delete pending.providerId;
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: pending } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
    );

    expect(message).toMatch(/incomplete add transaction.*cannot discard or adopt/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.getPresetContentGatewayState).not.toHaveBeenCalled();
    expect(testState.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("rejects a missing adapter before exec-unavailable recovery can mutate state (#7062)", async () => {
    const missingAdapter: McpBridgeEntry = { ...bridgeEntries.github };
    delete missingAdapter.adapter;
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: missingAdapter } },
    });
    registry.addCustomPolicy(
      "alpha",
      ownedPolicy("github", { adapter: "mcporter", entry: missingAdapter }),
    );
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
    );

    expect(message).toMatch(/adapter identity is missing or incompatible/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.resolveHostAddresses).not.toHaveBeenCalled();
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.getPresetContentGatewayState).not.toHaveBeenCalled();
    expect(testState.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("rejects a cross-agent adapter before exec-unavailable recovery can mutate state (#7062)", async () => {
    const crossAgentEntry: McpBridgeEntry = {
      ...bridgeEntries.github,
      agent: "hermes",
      adapter: "hermes-config",
    };
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: crossAgentEntry } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github", { entry: crossAgentEntry }));
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
    );

    expect(message).toMatch(/adapter identity is missing or incompatible/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.resolveHostAddresses).not.toHaveBeenCalled();
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.getPresetContentGatewayState).not.toHaveBeenCalled();
    expect(testState.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it.each([
    [
      "credential key",
      /reuse the same credential key/i,
      (entry: McpBridgeEntry): McpBridgeEntry => ({
        ...entry,
        env: [...bridgeEntries.github.env],
      }),
    ],
    [
      "provider name",
      /reuse the same provider name/i,
      (entry: McpBridgeEntry): McpBridgeEntry => ({
        ...entry,
        providerName: bridgeEntries.github.providerName,
      }),
    ],
    [
      "provider ID",
      /reuse the same provider ID/i,
      (entry: McpBridgeEntry): McpBridgeEntry => ({
        ...entry,
        providerId: bridgeEntries.github.providerId,
      }),
    ],
    [
      "generated policy name",
      /reuse the same generated policy name/i,
      (entry: McpBridgeEntry): McpBridgeEntry => ({
        ...entry,
        policyName: bridgeEntries.github.policyName,
      }),
    ],
  ] satisfies ReadonlyArray<readonly [string, RegExp, (entry: McpBridgeEntry) => McpBridgeEntry]>)(
    "rejects a cross-entry %s collision before exec-unavailable recovery can inspect or mutate state (#7062)",
    async (_label, expected, collide) => {
      const collidingSlack = collide(bridgeEntries.slack);
      registry.registerSandbox({
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        mcp: {
          bridges: {
            github: bridgeEntries.github,
            slack: collidingSlack,
          },
        },
      });
      registry.addCustomPolicy("alpha", ownedPolicy("github"));
      registry.addCustomPolicy("alpha", ownedPolicy("slack", { entry: collidingSlack }));
      const before = registry.getSandbox("alpha");

      const message = await captureMessage(() =>
        bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
      );

      expect(message).toMatch(expected);
      expect(registry.getSandbox("alpha")).toEqual(before);
      expect(testState.resolveHostAddresses).not.toHaveBeenCalled();
      expect(testState.calls).toEqual([]);
      expect(testState.adapterCalls).toEqual([]);
      expect(testState.runOpenshell).not.toHaveBeenCalled();
      expect(testState.getPresetContentGatewayState).not.toHaveBeenCalled();
      expect(testState.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
      expect(testState.applyPresetContent).not.toHaveBeenCalled();
      expect(testState.removePreset).not.toHaveBeenCalled();
    },
  );

  it("rejects live policy drift during exec-unavailable recovery without MCP mutations (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const before = registry.getSandbox("alpha");
    testState.getPresetContentGatewayState.mockReturnValue("drift");

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
    );

    expect(message).toMatch(/policy.*drifted.*host-side rebuild recovery/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("rejects a credential-key collision during host-side rebuild recovery (#9388)", async () => {
    registerAlphaGithubBridge();
    testState.providers.set("example-api", {
      credential: "GITHUB_TOKEN",
      id: "99999999-8888-4777-8666-555555555555",
    });
    testState.attachedProviders.add("example-api");
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
    );

    expect(message).toContain(
      "Credential key 'GITHUB_TOKEN' is already supplied by attached provider 'example-api'",
    );
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect([...testState.attachedProviders].sort()).toEqual([
      "alpha-mcp-github",
      "alpha-mcp-slack",
      "example-api",
    ]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.calls.some((call) => call.startsWith("sandbox provider detach"))).toBe(false);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("does not reconcile an incomplete policy registration during read-only recovery (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", {
      ...ownedPolicy("github"),
      pendingContent: "network_policies: {}\n",
    });
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha"),
    );

    expect(message).toMatch(/incomplete registry transition.*read-only/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("skips provider inspection for empty managed MCP recovery state (#9388)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
    });

    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    await preparation.revalidateBeforeDelete?.();

    expect(preparation.entries).toEqual([]);
    expect(testState.runOpenshellProviderCommand).not.toHaveBeenCalled();
    expect(testState.recoverNamedGatewayRuntime).not.toHaveBeenCalled();
    expect(testState.getPresetContentGatewayState).not.toHaveBeenCalled();
  });

  it("inspects attached providers once per read-only checkpoint for complete MCP state (#9388)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github, slack: bridgeEntries.slack } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    registry.addCustomPolicy("alpha", ownedPolicy("slack"));
    const before = registry.getSandbox("alpha");

    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    await preparation.revalidateBeforeDelete?.();
    preparation.assertDeleteEdgeUnchanged?.();

    expect(preparation.entries).toEqual([bridgeEntries.github, bridgeEntries.slack]);
    expect(preparation.detachedProviderEntries).toEqual([]);
    expect(preparation.scrubbedAdapterEntries).toEqual([]);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.calls).toEqual([
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
      "sandbox provider list alpha",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
      "sandbox provider list alpha",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
    ]);
    expect(testState.recoverNamedGatewayRuntime).toHaveBeenCalledTimes(2);
    expect(testState.getPresetContentGatewayState).toHaveBeenCalledTimes(4);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("fails the delete-edge proof when live MCP policy drifts after host preflight (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    const before = registry.getSandbox("alpha");
    testState.getPresetContentGatewayState.mockReturnValue("drift");

    const message = await captureMessage(async () => preparation.revalidateBeforeDelete?.());

    expect(message).toMatch(/policy.*drifted.*host-side rebuild recovery/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.calls).toEqual([
      "provider get alpha-mcp-github",
      "sandbox provider list alpha",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
    ]);
  });

  it("rejects a credential-key collision added after host-side rebuild preflight (#9388)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    testState.providers.set("example-api", {
      credential: "GITHUB_TOKEN",
      id: "99999999-8888-4777-8666-555555555555",
    });
    testState.attachedProviders.add("example-api");

    const message = await captureMessage(async () => preparation.revalidateBeforeDelete?.());

    expect(message).toContain(
      "Credential key 'GITHUB_TOKEN' is already supplied by attached provider 'example-api'",
    );
    expect([...testState.attachedProviders].sort()).toEqual([
      "alpha-mcp-github",
      "alpha-mcp-slack",
      "example-api",
    ]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.calls.some((call) => call.startsWith("sandbox provider detach"))).toBe(false);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("fails the delete-edge proof when the exact provider identity changes (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    const before = registry.getSandbox("alpha");
    testState.providers.set("alpha-mcp-github", {
      credential: "GITHUB_TOKEN",
      id: "99999999-2222-4333-8444-555555555555",
    });

    const message = await captureMessage(async () => preparation.revalidateBeforeDelete?.());

    expect(message).toMatch(/no longer exactly matches.*stable provider ID/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.calls).toEqual([
      "provider get alpha-mcp-github",
      "sandbox provider list alpha",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
      "provider get alpha-mcp-github",
    ]);
  });

  it("rejects valid provider resource-version drift through the exact snapshot comparator (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    const before = registry.getSandbox("alpha");
    testState.providers.set("alpha-mcp-github", {
      credential: "GITHUB_TOKEN",
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 2,
    });

    const message = await captureMessage(async () => preparation.revalidateBeforeDelete?.());

    expect(message).toMatch(/changed after host-side rebuild preflight/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.calls).toEqual([
      "provider get alpha-mcp-github",
      "sandbox provider list alpha",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
      "provider get alpha-mcp-github",
      "sandbox provider list alpha",
      "provider get alpha-mcp-github",
      "provider get alpha-mcp-slack",
    ]);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("rejects valid-to-valid DNS drift from the canonical policy pins (#7062)", async () => {
    const dnsEntry = {
      ...bridgeEntries.github,
      url: "https://mcp.example.com/github",
    };
    testState.resolveHostAddresses
      .mockResolvedValueOnce([{ address: "8.8.8.8" }])
      .mockResolvedValueOnce([{ address: "1.1.1.1" }]);
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: dnsEntry } },
    });
    registry.addCustomPolicy(
      "alpha",
      ownedPolicy("github", { entry: dnsEntry, resolvedAddresses: ["8.8.8.8"] }),
    );
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(async () => preparation.revalidateBeforeDelete?.());

    expect(message).toMatch(/not canonical for its recorded bridge definition/i);
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect(testState.resolveHostAddresses).toHaveBeenNthCalledWith(1, "mcp.example.com");
    expect(testState.resolveHostAddresses).toHaveBeenNthCalledWith(2, "mcp.example.com");
    expect(testState.adapterCalls).toEqual([]);
  });

  it("rejects bridge-definition drift at the final no-await delete edge (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    const before = registry.getSandbox("alpha");
    registry.updateSandbox("alpha", {
      mcp: {
        ...before?.mcp,
        bridges: {
          github: { ...bridgeEntries.github, url: "https://1.1.1.1/github" },
        },
      },
    });

    expect(() => preparation.assertDeleteEdgeUnchanged?.()).toThrow(
      /MCP bridge definitions changed/i,
    );
    expect(testState.adapterCalls).toEqual([]);
  });

  it("rejects a new destroy marker at the final no-await delete edge (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    const before = registry.getSandbox("alpha");
    registry.updateSandbox("alpha", {
      mcp: {
        ...before?.mcp,
        bridges: { github: bridgeEntries.github },
        destroyPreparedAt: "2026-07-19T00:00:00.000Z",
      },
    });

    expect(() => preparation.assertDeleteEdgeUnchanged?.()).toThrow(
      /incomplete MCP destroy transaction/i,
    );
    expect(registry.getSandbox("alpha")?.mcp?.destroyPreparedAt).toBe("2026-07-19T00:00:00.000Z");
    expect(testState.adapterCalls).toEqual([]);
  });

  it("rejects recorded-gateway drift at the final no-await delete edge (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    registry.updateSandbox("alpha", { gatewayPort: 19080 });

    expect(() => preparation.assertDeleteEdgeUnchanged?.()).toThrow(
      /changed its recorded gateway/i,
    );
    expect(registry.getSandbox("alpha")?.gatewayPort).toBe(19080);
    expect(testState.adapterCalls).toEqual([]);
  });

  it("rejects recorded-agent adapter drift at the final no-await delete edge (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const preparation = await bridge.prepareMcpBridgesForExecUnavailableRebuild("alpha");
    registry.updateSandbox("alpha", { agent: "hermes" });

    expect(() => preparation.assertDeleteEdgeUnchanged?.()).toThrow(
      /changed its recorded agent or MCP adapter/i,
    );
    expect(registry.getSandbox("alpha")?.agent).toBe("hermes");
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("runs failed exec through real read-only preparation and deletes before stopping NIM (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      nimContainer: "nim-alpha",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const before = registry.getSandbox("alpha");
    testState.executeSandboxExecCommand.mockReturnValue(null);
    testState.runOpenshell.mockImplementation((args: string[]) =>
      args[1] === "delete"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" },
    );
    testState.captureOpenshell.mockReturnValue({
      status: 1,
      output: "",
      stdout: "",
      stderr: "Error: sandbox alpha not found",
    });
    const onDeleted = vi.fn();

    const result = await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: before ?? { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      recreateJournal: stubRecreateJournal(),
      backupManifest: null,
      force: true,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted,
    });

    expect(result?.entries).toEqual([bridgeEntries.github]);
    expect(testState.executeSandboxExecCommand).toHaveBeenCalledOnce();
    expect(testState.executeSandboxExecCommand).toHaveBeenCalledWith("alpha", ":", undefined, {
      allowLocalDockerFallback: false,
    });
    expect(testState.executeSandboxCommand).toHaveBeenCalledWith("alpha", ":");
    expect(testState.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.any(Object),
    );
    expect(testState.captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.any(Object),
    );
    expect(testState.stopNimContainer).not.toHaveBeenCalled();
    expect(testState.stopNimContainerByName).toHaveBeenCalledWith("nim-alpha");
    expect(testState.runOpenshellProviderCommand).toHaveBeenCalledTimes(8);
    expect(testState.getPresetContentGatewayState).toHaveBeenCalledTimes(2);
    expect(testState.recoverNamedGatewayRuntime).toHaveBeenCalledTimes(2);
    expect(testState.executeSandboxExecCommand.mock.invocationCallOrder[0]).toBeLessThan(
      testState.runOpenshellProviderCommand.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(testState.runOpenshellProviderCommand.mock.invocationCallOrder[1]).toBeLessThan(
      testState.runOpenshell.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(testState.runOpenshell.mock.invocationCallOrder[0]).toBeLessThan(
      testState.stopNimContainerByName.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect([...testState.providers.keys()]).toContain("alpha-mcp-github");
    expect([...testState.attachedProviders]).toContain("alpha-mcp-github");
    expect(testState.adapterRegistered).toBe(true);
    expect(testState.adapterCalls).toEqual([":"]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("preserves real MCP ownership and running NIM when sandbox deletion fails (#7062)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      nimContainer: "nim-alpha",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    const beforeRegistry = registry.getSandbox("alpha");
    const beforeProviders = [...testState.providers.entries()];
    const beforeAttachments = [...testState.attachedProviders];
    const beforeAdapterRegistered = testState.adapterRegistered;
    testState.executeSandboxExecCommand.mockReturnValue(null);
    testState.runOpenshell
      .mockReturnValueOnce({
        status: 9,
        stdout: "",
        stderr: "delete failed",
      })
      .mockReturnValueOnce({ status: 0, stdout: "Phase: Ready\n", stderr: "" });
    const onDeleted = vi.fn();

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: beforeRegistry ?? { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded: vi.fn(() => true),
        onDeleted,
      }),
    ).rejects.toThrow("Failed to delete sandbox.");

    expect(registry.getSandbox("alpha")).toEqual(beforeRegistry);
    expect([...testState.providers.entries()]).toEqual(beforeProviders);
    expect([...testState.attachedProviders]).toEqual(beforeAttachments);
    expect(testState.adapterRegistered).toBe(beforeAdapterRegistered);
    expect(testState.adapterCalls).toEqual([":"]);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
    expect(testState.stopNimContainer).not.toHaveBeenCalled();
    expect(testState.stopNimContainerByName).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("rejects policy drift before prepareMcpBridgesForRebuild mutates adapter or provider state", async () => {
    registerAlphaGithubBridge();
    testState.getPresetContentGatewayState.mockReturnValue("drift");

    const message = await captureMessage(() => bridge.prepareMcpBridgesForRebuild("alpha"));

    expect(message).toMatch(/policy.*drift/i);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
  });

  it("rejects a credential-key collision before rebuild changes MCP state (#9388)", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    testState.providers.set("example-api", {
      credential: "GITHUB_TOKEN",
      id: "99999999-8888-4777-8666-555555555555",
    });
    testState.attachedProviders.add("example-api");
    const before = registry.getSandbox("alpha");

    const message = await captureMessage(() => bridge.prepareMcpBridgesForRebuild("alpha"));

    expect(message).toContain(
      "Credential key 'GITHUB_TOKEN' is already supplied by attached provider 'example-api'",
    );
    expect(registry.getSandbox("alpha")).toEqual(before);
    expect([...testState.attachedProviders].sort()).toEqual([
      "alpha-mcp-github",
      "alpha-mcp-slack",
      "example-api",
    ]);
    expect(testState.adapterRegistered).toBe(true);
    expect(testState.calls.some((call) => call.startsWith("sandbox provider detach"))).toBe(false);
    expect(testState.applyPresetContent).not.toHaveBeenCalled();
    expect(testState.removePreset).not.toHaveBeenCalled();
  });

  it("rejects an unowned same-name policy record during absent-sandbox rebuild", async () => {
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
    testState.getPresetContentGatewayState.mockImplementation(() => {
      throw new Error("absent rebuild queried live policy");
    });

    const message = await captureMessage(() =>
      bridge.prepareMcpBridgesForAbsentSandboxRebuild("alpha"),
    );

    expect(message).toMatch(/unowned same-name registry record/);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
  });

  it("finalizes an externally absent sandbox without attempting sandbox adapter exec", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: { github: bridgeEntries.github },
        managedServerNames: ["github", "retired"],
      },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));

    const preparation = await bridge.prepareMcpBridgesForAbsentSandboxDestroy("alpha");
    await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation);
    const sandbox = registry.getSandbox("alpha");

    expect(preparation.entries).toHaveLength(1);
    expect(testState.adapterCalls).toEqual([]);
    expect(testState.calls.some((call) => call.includes("sandbox provider"))).toBe(false);
    expect([...testState.providers.keys()]).not.toContain("alpha-mcp-github");
    expect(sandbox?.mcp).toBeUndefined();
    expect(sandbox?.customPolicies).toBeUndefined();
  });

  it("restores policy, attachment, and adapter without rotating an exported host secret", async () => {
    process.env.GITHUB_TOKEN = "ambient-value-that-must-not-rotate";
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: { github: bridgeEntries.github },
        managedServerNames: ["github", "retired"],
      },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));

    const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
    await bridge.restoreMcpBridgesAfterDestroyAbort("alpha", preparation);
    const sandbox = registry.getSandbox("alpha");

    expect(process.env.GITHUB_TOKEN).toBe("ambient-value-that-must-not-rotate");
    expect([...testState.providers.keys()]).toContain("alpha-mcp-github");
    expect(testState.calls).toContain("sandbox provider attach alpha alpha-mcp-github");
    expect(testState.providers.get("alpha-mcp-github")?.resourceVersion).toBe(2);
    expect(testState.calls.some((call) => /^provider (create|update) .*--credential/.test(call))).toBe(false);
    expect(testState.policyApplyCalls).toBe(2);
    expect(testState.adapterCalls).toContain("command -v mcporter");
    expect(testState.adapterCalls.some((call) => call.includes("openshell:resolve:env:GITHUB_TOKEN"))).toBe(true);
    expect(sandbox?.mcp?.bridges).toHaveProperty("github");
    expect(sandbox?.mcp?.managedServerNames).toEqual(["github", "retired"]);
    expect(sandbox?.mcp?.destroyPreparedAt).toBeUndefined();
    expect(sandbox?.mcp?.destroyPendingAt).toBeUndefined();
  });

  it("restores the durable destroy marker when abort rollback fails", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: { github: bridgeEntries.github },
        managedServerNames: ["github", "retired"],
      },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));

    const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
    testState.applyPresetContent.mockReturnValue(false);
    const error = await captureMessage(() =>
      bridge.restoreMcpBridgesAfterDestroyAbort("alpha", preparation),
    );
    const sandbox = registry.getSandbox("alpha");

    expect(error).toMatch(/failed to activate generated MCP policy/i);
    expect(sandbox?.mcp?.bridges).toHaveProperty("github");
    expect(sandbox?.mcp?.managedServerNames).toEqual(["github", "retired"]);
    expect(sandbox?.mcp?.destroyPreparedAt).toBeTruthy();
    expect([...testState.attachedProviders]).not.toContain("alpha-mcp-github");
    expect(testState.adapterRegistered).toBe(false);
  });

  it("preserves credentials and bridge state until sandbox deletion is confirmed", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    registry.addCustomPolicy("alpha", { name: "operator", content: "version: 1\n" });

    const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
    const afterPrepare = registry.getSandbox("alpha");
    await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation);
    const afterFinalize = registry.getSandbox("alpha");

    expect(afterPrepare?.mcp?.bridges).toHaveProperty("github");
    expect(afterPrepare?.mcp?.destroyPreparedAt).toBeTruthy();
    expect(afterPrepare?.mcp?.destroyPendingAt).toBeUndefined();
    expect(afterPrepare?.customPolicies?.map((policy) => policy.name)).toEqual(["operator"]);
    expect(afterFinalize?.mcp).toBeUndefined();
    expect(afterFinalize?.customPolicies?.map((policy) => policy.name)).toEqual(["operator"]);
    expect([...testState.providers.keys()]).not.toContain("alpha-mcp-github");
    expect(
      testState.calls.some((call) => call === "sandbox provider detach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(
      testState.adapterCalls.some((call) => call.includes("config") && call.includes("remove")),
    ).toBe(true);
  });

  it("restores a rebuilt sandbox without rotating an exported MCP credential", async () => {
    process.env.GITHUB_TOKEN = "ambient-value-that-must-not-rotate";
    testState.attachedProviders.delete("alpha-mcp-github");
    testState.adapterRegistered = false;
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));

    await bridge.restoreMcpBridgesAfterRebuild("alpha", [bridgeEntries.github]);

    expect(process.env.GITHUB_TOKEN).toBe("ambient-value-that-must-not-rotate");
    expect(testState.providers.get("alpha-mcp-github")?.resourceVersion).toBe(2);
    expect(testState.calls.some((call) => /^provider (create|update) .*--credential/.test(call))).toBe(false);
    expect([...testState.attachedProviders]).toContain("alpha-mcp-github");
    expect(testState.adapterRegistered).toBe(true);
    expect(testState.policyApplyCalls).toBe(2);
  });

  it.each([
    ["destroy", "prepareMcpBridgesForDestroy"],
    ["rebuild", "prepareMcpBridgesForRebuild"],
  ] as const)(
    "reattaches an already-absent first provider when a later %s detach fails",
    async (_label, prepareFunction) => {
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
      testState.attachedProviders.delete("alpha-mcp-github");
      testState.failProviderDetach = "alpha-mcp-slack";

      const message = await captureMessage(() => bridge[prepareFunction]("alpha"));

      expect(message).toContain("provider detach failed");
      expect([...testState.attachedProviders].sort()).toEqual([
        "alpha-mcp-github",
        "alpha-mcp-slack",
      ]);
      expect(
        testState.calls.some((call) => call === "sandbox provider attach alpha alpha-mcp-github"),
      ).toBe(true);
      expect(testState.adapterRegistered).toBe(true);
    },
  );

  it("reattaches every desired provider when rebuild deletion aborts after a retry", async () => {
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
    testState.attachedProviders.delete("alpha-mcp-github");

    const preparation = await bridge.prepareMcpBridgesForRebuild("alpha");
    const detachedBeforeAbort = [...testState.attachedProviders].sort();
    await bridge.reattachMcpProvidersAfterRebuildAbort(
      "alpha",
      preparation.detachedProviderEntries,
      preparation.scrubbedAdapterEntries,
    );

    expect(preparation.detachedProviderEntries).toHaveLength(2);
    expect(detachedBeforeAbort).toEqual([]);
    expect([...testState.attachedProviders].sort()).toEqual([
      "alpha-mcp-github",
      "alpha-mcp-slack",
    ]);
    expect(
      testState.calls.some((call) => call === "sandbox provider attach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(testState.adapterRegistered).toBe(true);
  });

  it("keeps a pending manifest after partial provider deletion and completes on retry", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: {
        bridges: bridgeEntries,
        managedServerNames: ["github", "retired", "slack"],
      },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    registry.addCustomPolicy("alpha", ownedPolicy("slack"));

    const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
    testState.failProviderDelete = "alpha-mcp-slack";
    const firstError = await captureMessage(() =>
      bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation, { force: true }),
    );
    const afterFailure = registry.getSandbox("alpha");
    testState.failProviderDelete = null;
    const retry = await bridge.prepareMcpBridgesForDestroy("alpha");
    await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", retry, { force: true });
    const afterRetry = registry.getSandbox("alpha");

    expect(firstError).toContain("provider delete failed");
    expect(afterFailure?.mcp?.destroyPendingAt).toBeTruthy();
    expect(afterFailure?.mcp?.destroyPreparedAt).toBeUndefined();
    expect(afterFailure?.mcp?.managedServerNames).toEqual(["github", "retired", "slack"]);
    expect(Object.keys(afterFailure?.mcp?.bridges ?? {})).toEqual(["github", "slack"]);
    expect(afterFailure?.customPolicies).toBeUndefined();
    expect(retry.destroyAlreadyPending).toBe(true);
    expect(afterRetry?.mcp).toBeUndefined();
    expect(afterRetry?.customPolicies).toBeUndefined();
    expect([...testState.providers.keys()]).toEqual([]);
    expect(
      testState.calls.filter((call) => call === "sandbox provider detach alpha alpha-mcp-github"),
    ).toHaveLength(1);
  });

  it("resumes from the durable prepared phase after delete-before-finalize interruption", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));

    await bridge.prepareMcpBridgesForDestroy("alpha");
    const callsAfterFirstPrepare = testState.calls.length;
    const adapterCallsAfterFirstPrepare = testState.adapterCalls.length;
    const retry = await bridge.prepareMcpBridgesForDestroy("alpha");
    await bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", retry);
    const sandbox = registry.getSandbox("alpha");

    expect(retry.destroyAlreadyPrepared).toBe(true);
    expect(retry.destroyAlreadyPending).toBe(false);
    expect(
      testState.calls
        .slice(0, callsAfterFirstPrepare)
        .some((call) => call === "sandbox provider detach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(
      testState.calls
        .slice(callsAfterFirstPrepare)
        .filter((call) => call.includes("sandbox provider detach")),
    ).toEqual([]);
    expect(testState.adapterCalls).toHaveLength(adapterCallsAfterFirstPrepare);
    expect(sandbox?.mcp).toBeUndefined();
    expect([...testState.providers.keys()]).not.toContain("alpha-mcp-github");
  });

  it("does not let force delete a drifted global provider", async () => {
    testState.providers.set("alpha-mcp-github", {
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
    const preparation = {
      entries: [bridgeEntries.github],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      destroyAlreadyPrepared: false,
      destroyAlreadyPending: true,
    };

    const message = await captureMessage(() =>
      bridge.finalizeMcpBridgesAfterSandboxDelete("alpha", preparation, { force: true }),
    );
    const sandbox = registry.getSandbox("alpha");

    expect(message).toContain("no longer exactly matches");
    expect(message).toContain("--force does not delete");
    expect(sandbox?.mcp?.bridges).toHaveProperty("github");
    expect([...testState.providers.keys()]).toContain("alpha-mcp-github");
    expect(
      testState.calls.some((call) => call.startsWith("provider delete alpha-mcp-github ")),
    ).toBe(false);
  });
});
