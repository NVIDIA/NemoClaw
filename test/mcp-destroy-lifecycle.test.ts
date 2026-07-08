// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../src/lib/state/registry";

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
    executeGatewaySupervisorAction: vi.fn(),
    executeSandboxCommand: vi.fn(),
    executeSandboxExecCommand: vi.fn(),
    failProviderDelete: null as string | null,
    failProviderDetach: null as string | null,
    getPresetContentGatewayState: vi.fn(),
    home,
    originalEnv,
    policyApplyCalls: 0,
    providers: new Map<string, { credential: string; id: string }>(),
    attachedProviders: new Set<string>(),
    recoverNamedGatewayRuntime: vi.fn(),
    removePreset: vi.fn(),
    runOpenshellProviderCommand: vi.fn(),
  };
});

vi.mock("../src/lib/actions/global", () => ({
  runOpenshellProviderCommand: testState.runOpenshellProviderCommand,
}));

vi.mock("../src/lib/gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: testState.recoverNamedGatewayRuntime,
}));

vi.mock("../src/lib/policy", () => ({
  applyPresetContent: testState.applyPresetContent,
  getPresetContentGatewayState: testState.getPresetContentGatewayState,
  removePreset: testState.removePreset,
}));

vi.mock("../src/lib/actions/sandbox/process-recovery", () => ({
  executeGatewaySupervisorAction: testState.executeGatewaySupervisorAction,
  executeSandboxCommand: testState.executeSandboxCommand,
  executeSandboxExecCommand: testState.executeSandboxExecCommand,
}));

import * as bridge from "../src/lib/actions/sandbox/mcp-bridge";
import * as registry from "../src/lib/state/registry";

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.72");

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

function ownedPolicy(server: "github" | "slack") {
  return {
    name: `mcp-bridge-${server}`,
    content: "network_policies: {}\n",
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
  testState.failProviderDelete = null;
  testState.failProviderDetach = null;

  vi.resetAllMocks();
  testState.recoverNamedGatewayRuntime.mockResolvedValue({
    recovered: true,
    attempted: false,
    before: { state: "healthy_named" },
    after: { state: "healthy_named" },
  });
  testState.applyPresetContent.mockImplementation(() => {
    testState.policyApplyCalls += 1;
    return true;
  });
  testState.getPresetContentGatewayState.mockReturnValue("match");
  testState.removePreset.mockReturnValue(true);

  testState.runOpenshellProviderCommand.mockImplementation((args: string[]) => {
    testState.calls.push(args.join(" "));
    switch (args.join(" ")) {
      case "status --output json":
        return { status: 0, stdout: "ready", stderr: "" };
    }
    switch (true) {
      case args[0] === "provider" && args[1] === "get": {
        const provider = testState.providers.get(args[2]);
        return provider
          ? {
              status: 0,
              stdout: `Id: ${provider.id}\nType: generic\nResource version: 1\nCredential keys: ${provider.credential}\n`,
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
                      .map((name) => `${name} generic 1 0`)
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
      case command.includes('["config", "remove"'):
        testState.adapterRegistered = false;
        return { status: 0, stdout: "", stderr: "" };
      case command.includes('["config", "get"'):
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
  for (const method of [
    "prepareMcpBridgesForAbsentSandboxDestroy",
    "prepareMcpBridgesForAbsentSandboxRebuild",
  ] as const) {
    it(`clears a providerless preflighted add during ${method}`, async () => {
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
  }

  for (const method of [
    "prepareMcpBridgesForRebuild",
    "prepareMcpBridgesForAbsentSandboxRebuild",
  ] as const) {
    for (const marker of ["destroyPreparedAt", "destroyPendingAt"] as const) {
      it(`rejects ${method} while ${marker} is durable`, async () => {
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
    }
  }

  it("prepares an absent-sandbox rebuild without adapter exec or provider detach", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
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

  it("rejects policy drift before prepareMcpBridgesForRebuild mutates adapter or provider state", async () => {
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      mcp: { bridges: { github: bridgeEntries.github } },
    });
    registry.addCustomPolicy("alpha", ownedPolicy("github"));
    testState.getPresetContentGatewayState.mockReturnValue("drift");

    const message = await captureMessage(() => bridge.prepareMcpBridgesForRebuild("alpha"));

    expect(message).toMatch(/policy.*drift/i);
    expect(testState.calls).toEqual([]);
    expect(testState.adapterCalls).toEqual([]);
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
    expect(
      testState.calls.some((call) => call === "sandbox provider attach alpha alpha-mcp-github"),
    ).toBe(true);
    expect(testState.calls.some((call) => /^provider (create|update) /.test(call))).toBe(false);
    expect(testState.policyApplyCalls).toBe(1);
    expect(testState.adapterCalls).toContain("command -v mcporter");
    expect(
      testState.adapterCalls.some((call) => call.includes("openshell:resolve:env:GITHUB_TOKEN")),
    ).toBe(true);
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
    expect(afterPrepare?.customPolicies?.map((policy) => policy.name)).toContain(
      "mcp-bridge-github",
    );
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
    expect(testState.calls.some((call) => /^provider (create|update) /.test(call))).toBe(false);
    expect([...testState.attachedProviders]).toContain("alpha-mcp-github");
    expect(testState.adapterRegistered).toBe(true);
    expect(testState.policyApplyCalls).toBe(1);
  });

  for (const [label, prepareFunction] of [
    ["destroy", "prepareMcpBridgesForDestroy"],
    ["rebuild", "prepareMcpBridgesForRebuild"],
  ] as const) {
    it(`reattaches an already-absent first provider when a later ${label} detach fails`, async () => {
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
    });
  }

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
    expect(afterFailure?.customPolicies).toHaveLength(2);
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
