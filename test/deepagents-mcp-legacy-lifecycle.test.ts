// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyPresetContent: vi.fn(),
  executeGatewaySupervisorAction: vi.fn(),
  executeSandboxCommand: vi.fn(),
  executeSandboxExecCommand: vi.fn(),
  getPresetContentGatewayState: vi.fn(),
  recoverNamedGatewayRuntime: vi.fn(),
  removePreset: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("../src/lib/actions/global", () => ({
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

vi.mock("../src/lib/gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
}));

vi.mock("../src/lib/policy", () => ({
  applyPresetContent: mocks.applyPresetContent,
  getPresetContentGatewayState: mocks.getPresetContentGatewayState,
  removePreset: mocks.removePreset,
}));

vi.mock("../src/lib/actions/sandbox/process-recovery", () => ({
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
  executeSandboxCommand: mocks.executeSandboxCommand,
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
}));

const MATCHING_OPENSHELL = path.resolve("test/fixtures/openshell-v0.0.72");
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENSHELL_BIN = process.env.NEMOCLAW_OPENSHELL_BIN;
const ORIGINAL_OPENSHELL_GATEWAY = process.env.OPENSHELL_GATEWAY;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-mcp-legacy-"));

process.env.HOME = TMP_HOME;
process.env.NEMOCLAW_OPENSHELL_BIN = MATCHING_OPENSHELL;

const registry = await import("../src/lib/state/registry");
const bridge = await import("../src/lib/actions/sandbox/mcp-bridge");

const providerId = "11111111-2222-4333-8444-555555555555";
let providerExists = true;
let attached = true;
let adapterRegistered = true;
let adapterRemovalOutcome = "";
let deepAgentsCapability = false;
let policyApplyCalls = 0;
let policyState = "match";
let adapterCalls: string[] = [];

function lifecycleResult() {
  return {
    attached,
    adapterRegistered,
    providerExists,
    policyApplyCalls,
    markerCalls: adapterCalls.filter((call) =>
      call.includes("deepagents-code --nemoclaw-mcp-capability"),
    ).length,
  };
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  switch (value) {
    case undefined:
      delete process.env[name];
      break;
    default:
      process.env[name] = value;
  }
}

afterAll(() => {
  restoreEnvironmentVariable("HOME", ORIGINAL_HOME);
  restoreEnvironmentVariable("NEMOCLAW_OPENSHELL_BIN", ORIGINAL_OPENSHELL_BIN);
  restoreEnvironmentVariable("OPENSHELL_GATEWAY", ORIGINAL_OPENSHELL_GATEWAY);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.dirname(registry.REGISTRY_FILE), { recursive: true, force: true });
  restoreEnvironmentVariable("OPENSHELL_GATEWAY", ORIGINAL_OPENSHELL_GATEWAY);

  providerExists = true;
  attached = true;
  adapterRegistered = true;
  adapterRemovalOutcome = "";
  deepAgentsCapability = false;
  policyApplyCalls = 0;
  policyState = "match";
  adapterCalls = [];

  mocks.runOpenshellProviderCommand.mockReset().mockImplementation((args: string[]) => {
    const command = args.join(" ");
    switch (true) {
      case command === "status --output json":
        return { status: 0, stdout: "ready", stderr: "" };
      case args[0] === "provider" && args[1] === "get":
        return providerExists
          ? {
              status: 0,
              stdout: `Id: ${providerId}\nType: generic\nResource version: 1\nCredential keys: GITHUB_TOKEN\n`,
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "Provider not found" };
      case args[0] === "sandbox" && args[1] === "provider" && args[2] === "list":
        return {
          status: 0,
          stdout: attached
            ? "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-github generic 1 0\n"
            : "No providers attached to sandbox alpha.\n",
          stderr: "",
        };
      case args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach":
        attached = false;
        return { status: 0, stdout: "Detached provider", stderr: "" };
      case args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach":
        attached = true;
        return { status: 0, stdout: "Attached provider", stderr: "" };
      case args[0] === "provider" && args[1] === "delete":
        providerExists = false;
        attached = false;
        return { status: 0, stdout: "Deleted provider", stderr: "" };
      default:
        throw new Error(`Unexpected OpenShell call: ${command}`);
    }
  });

  mocks.recoverNamedGatewayRuntime.mockReset().mockResolvedValue({
    recovered: true,
    attempted: false,
    before: { state: "healthy_named" },
    after: { state: "healthy_named" },
  });

  mocks.getPresetContentGatewayState.mockReset().mockImplementation(() => policyState);
  mocks.applyPresetContent.mockReset().mockImplementation(() => {
    policyApplyCalls += 1;
    policyState = "match";
    return true;
  });
  mocks.removePreset.mockReset().mockImplementation(() => {
    policyState = "absent";
    return true;
  });

  mocks.executeGatewaySupervisorAction.mockReset();
  mocks.executeSandboxCommand
    .mockReset()
    .mockImplementation((_sandbox: string, command: string) => {
      adapterCalls.push(command);
      switch (true) {
        case command === "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability":
          return deepAgentsCapability
            ? { status: 0, stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n", stderr: "" }
            : { status: 2, stdout: "", stderr: "unknown option" };
        case command.includes("servers.pop(payload['server'])"): {
          const outcome = adapterRemovalOutcome || (adapterRegistered ? "removed" : "absent");
          adapterRegistered = outcome === "unowned" ? adapterRegistered : false;
          return {
            status: 0,
            stdout: `NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=${outcome}\n`,
            stderr: "",
          };
        }
        case command.includes("data = {'mcpServers': payload['expectedServers']}"):
          adapterRegistered = true;
          return {
            status: 0,
            stdout: command.includes("NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED")
              ? "NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1\n"
              : "",
            stderr: "",
          };
        case command.includes(
          "print('registered' if ok else ('mismatch' if present else 'absent'))",
        ):
          return {
            status: 0,
            stdout: adapterRegistered ? "registered\n" : "absent\n",
            stderr: "",
          };
        default:
          return { status: 0, stdout: "", stderr: "" };
      }
    });

  mocks.executeSandboxExecCommand
    .mockReset()
    .mockImplementation((_sandbox: string, command: string) => {
      const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] || "";
      const proof = encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
      const isRevisionObservation = proof.includes("valid_placeholder()");
      const isDetachedProof =
        !isRevisionObservation && proof.includes('[ -z "${GITHUB_TOKEN+x}" ]');
      return {
        status: isDetachedProof && attached ? 1 : 0,
        stdout: attached ? "canonical" : "absent",
        stderr: "",
      };
    });

  const entry = {
    server: "github",
    agent: "langchain-deepagents-code",
    adapter: "deepagents-config" as const,
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
});

describe("legacy Deep Agents managed MCP lifecycle", () => {
  it("removes an existing entry without requiring the new launcher marker", async () => {
    await bridge.removeMcpBridge("alpha", "github");

    expect(lifecycleResult()).toMatchObject({
      attached: false,
      adapterRegistered: false,
      providerExists: false,
      markerCalls: 0,
    });
  });

  it("treats an already-absent legacy entry as an idempotent removal retry", async () => {
    adapterRegistered = false;

    await bridge.removeMcpBridge("alpha", "github");

    expect(lifecycleResult()).toMatchObject({
      attached: false,
      adapterRegistered: false,
      providerExists: false,
      markerCalls: 0,
    });
  });

  it("preserves ownership state when legacy adapter cleanup is unproved", async () => {
    adapterRemovalOutcome = "unowned";

    let error = "";
    try {
      await bridge.removeMcpBridge("alpha", "github", { force: true });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    expect({
      error,
      ...lifecycleResult(),
      registryEntryPresent: Boolean(registry.getSandbox("alpha")?.mcp?.bridges?.github),
    }).toMatchObject({
      error: expect.stringMatching(/left residual resources/),
      adapterRegistered: true,
      providerExists: true,
      registryEntryPresent: true,
      markerCalls: 0,
    });
  });

  for (const [label, method] of [
    ["destroy", "prepareMcpBridgesForDestroy"],
    ["rebuild", "prepareMcpBridgesForRebuild"],
  ] as const) {
    it(`${label} teardown does not require the marker from the old image`, async () => {
      const preparation = await bridge[method]("alpha");

      expect({ entryCount: preparation.entries.length, ...lifecycleResult() }).toMatchObject({
        entryCount: 1,
        attached: false,
        adapterRegistered: false,
        providerExists: true,
        markerCalls: 0,
      });
    });

    it(`${label} teardown fails closed when adapter ownership is unproved`, async () => {
      adapterRemovalOutcome = "unowned";

      let error = "";
      try {
        await bridge[method]("alpha");
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      expect({ error, ...lifecycleResult() }).toMatchObject({
        error: expect.stringMatching(/Could not prove removal of the exact managed adapter entry/),
        attached: true,
        adapterRegistered: true,
        providerExists: true,
        markerCalls: 0,
      });
    });
  }

  it("proves the replacement image marker before post-rebuild reattachment", async () => {
    const preparation = await bridge.prepareMcpBridgesForRebuild("alpha");
    let error = "";
    try {
      await bridge.restoreMcpBridgesAfterRebuild("alpha", preparation.entries);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    expect({ error, ...lifecycleResult() }).toMatchObject({
      error: expect.stringMatching(/does not contain managed MCP capability v2/i),
      attached: false,
      adapterRegistered: false,
      providerExists: true,
      policyApplyCalls: 0,
      markerCalls: 1,
    });
  });

  it("restores the old image when destroy deletion aborts", async () => {
    const preparation = await bridge.prepareMcpBridgesForDestroy("alpha");
    await bridge.restoreMcpBridgesAfterDestroyAbort("alpha", preparation);

    expect(lifecycleResult()).toMatchObject({
      attached: true,
      adapterRegistered: true,
      providerExists: true,
      markerCalls: 0,
    });
  });

  it("restores the old image when rebuild deletion aborts", async () => {
    const preparation = await bridge.prepareMcpBridgesForRebuild("alpha");
    await bridge.reattachMcpProvidersAfterRebuildAbort(
      "alpha",
      preparation.detachedProviderEntries,
      preparation.scrubbedAdapterEntries,
    );

    expect(lifecycleResult()).toMatchObject({
      attached: true,
      adapterRegistered: true,
      providerExists: true,
      markerCalls: 0,
    });
  });
});
