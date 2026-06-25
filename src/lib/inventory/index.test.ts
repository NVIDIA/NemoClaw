// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSandboxInventory,
  getStatusReport,
  listSandboxesCommand,
  renderSandboxInventoryText,
  type SandboxEntry,
  showStatusCommand,
} from "./index";

type MessagingState = NonNullable<SandboxEntry["messaging"]>;
type MessagingChannelId = MessagingState["plan"]["channels"][number]["channelId"];

function messagingState(
  sandboxName: string,
  channels: readonly MessagingChannelId[],
): MessagingState {
  return {
    schemaVersion: 1,
    plan: {
      schemaVersion: 1,
      sandboxName,
      agent: "openclaw",
      workflow: "onboard",
      channels: channels.map((channelId) => ({
        channelId,
        displayName: channelId,
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      })),
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    },
  };
}

describe("inventory commands", () => {
  it("returns structured empty inventory for JSON consumers", async () => {
    const getLiveInference = vi.fn().mockReturnValue(null);

    const inventory = await getSandboxInventory({
      recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
      getLiveInference,
      loadLastSession: () => ({
        sandboxName: "alpha",
        steps: { sandbox: { status: "complete" } },
      }),
    });

    expect(inventory).toEqual({
      schemaVersion: 1,
      defaultSandbox: null,
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: "alpha",
      sandboxes: [],
    });
    expect(getLiveInference).not.toHaveBeenCalled();
  });

  it("returns structured sandbox inventory with connection state", async () => {
    const getLiveInference = vi.fn().mockReturnValue({
      provider: "live-provider",
      model: "live-model",
    });

    const inventory = await getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-alpha",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
          },
        ],
        defaultSandbox: "alpha",
        recoveredFromSession: true,
        recoveredFromGateway: 2,
      }),
      getLiveInference,
      loadLastSession: () => ({
        sandboxName: "alpha",
        steps: { sandbox: { status: "complete" } },
      }),
      getActiveSessionCount: (sandboxName) => (sandboxName === "alpha" ? 1 : 0),
    });

    expect(inventory).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: true,
        recoveredFromGateway: 2,
      },
      lastOnboardedSandbox: "alpha",
      sandboxes: [
        {
          name: "alpha",
          model: "configured-alpha",
          provider: "configured-provider",
          gpuEnabled: true,
          hostGpuDetected: false,
          sandboxGpuEnabled: true,
          sandboxGpuMode: null,
          sandboxGpuDevice: null,
          openshellDriver: null,
          openshellVersion: null,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
        },
      ],
    });
    expect(getLiveInference).not.toHaveBeenCalled();
  });

  it("shows agent as 'unknown' for a gateway-recovered sandbox (#5714), not the OpenClaw default", async () => {
    const inventory = await getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          { name: "dcode-station", model: null, provider: null, recoveredFromGateway: true },
        ],
        defaultSandbox: null,
        recoveredFromSession: false,
        recoveredFromGateway: 1,
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
    });

    expect(inventory.sandboxes[0]).toMatchObject({
      name: "dcode-station",
      agent: "unknown",
      recoveredFromGateway: true,
    });
  });

  it("renders a gateway-recovered row with the trusted live phase but unknown agent/GPU (#5714)", async () => {
    const inventory = await getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "dcode-station",
            model: null,
            provider: null,
            recoveredFromGateway: true,
            livePhase: "Ready",
          },
        ],
        defaultSandbox: null,
        recoveredFromSession: false,
        recoveredFromGateway: 1,
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
    });

    expect(inventory.sandboxes[0]).toMatchObject({
      recoveredFromGateway: true,
      livePhase: "Ready",
    });

    const lines: string[] = [];
    renderSandboxInventoryText(inventory, (m = "") => lines.push(m), null);
    const body = lines.join("\n");
    expect(body).toContain("Recovered 1 sandbox");
    expect(body).toContain("agent: unknown");
    expect(body).toContain("GPU: unknown");
    // Trusted PHASE from `openshell sandbox list` is surfaced so list agrees
    // with `nemoclaw <name> status` (the reporter's Ready expectation).
    expect(body).toContain("phase: Ready");
    expect(body).not.toContain("CPU sandbox");
    expect(body).not.toContain("agent: openclaw");
  });

  it("normalizes invalid configured inference fields out of inventory rows", async () => {
    const inventory = await getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          { name: "blank-provider", provider: "", model: "nvidia/test" },
          { name: "blank-model", provider: "nvidia-prod", model: "   " },
          { name: "configured", provider: "nvidia-prod", model: "nvidia/test" },
        ],
        defaultSandbox: "blank-provider",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
    });

    expect(inventory.sandboxes).toMatchObject([
      { name: "blank-provider", provider: null, model: "nvidia/test" },
      { name: "blank-model", provider: "nvidia-prod", model: null },
      { name: "configured", provider: "nvidia-prod", model: "nvidia/test" },
    ]);
  });

  it("normalizes invalid configured inference fields out of status rows", () => {
    const report = getStatusReport({
      listSandboxes: () => ({
        sandboxes: [
          { name: "blank-provider", provider: "", model: "nvidia/test" },
          { name: "blank-model", provider: "nvidia-prod", model: "   " },
          { name: "configured", provider: "nvidia-prod", model: "nvidia/test" },
        ],
        defaultSandbox: "blank-provider",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
    });

    expect(report.sandboxes).toMatchObject([
      { name: "blank-provider", provider: null, model: "nvidia/test" },
      { name: "blank-model", provider: "nvidia-prod", model: null },
      { name: "configured", provider: "nvidia-prod", model: "nvidia/test" },
    ]);
  });

  it("omits invalid configured inference fields from status text", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", provider: "", model: "   " }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha *");
    expect(lines.some((line) => line.includes("Inference:"))).toBe(false);
  });

  it("prints the empty-state onboarding hint when no sandboxes exist", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
      getLiveInference: () => null,
      loadLastSession: () => ({
        sandboxName: "alpha",
        steps: { sandbox: { status: "complete" } },
      }),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "  No sandboxes registered locally, but the last onboarded sandbox was 'alpha'.",
    );
  });

  it("#2753: suppresses last-onboarded hint when sandbox step never completed", async () => {
    // The session retains a sandbox name from an interrupted onboard
    // (pre-fix sessions on disk, or any in-progress write between steps).
    // Surfacing it as the "last onboarded sandbox" would resurrect the
    // phantom users were complaining about.
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
      getLiveInference: () => null,
      loadLastSession: () => ({
        sandboxName: "interrupt-test",
        steps: { sandbox: { status: "in_progress" } },
      }),
      log: (message = "") => lines.push(message),
    });

    expect(lines.some((l) => l.includes("interrupt-test"))).toBe(false);
    expect(lines).toContain("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
  });

  it("prints recovered sandbox inventory details", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            gpuEnabled: true,
            policies: ["pypi"],
          },
        ],
        defaultSandbox: "alpha",
        recoveredFromSession: true,
        recoveredFromGateway: 1,
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("  Recovered sandbox inventory from the last onboard session.");
    expect(lines).toContain("  Recovered 1 sandbox entry from the live OpenShell gateway.");
    expect(lines).toContain("    alpha *");
    expect(lines).toContain(
      "      agent: openclaw  model: nvidia/nemotron-3-super-120b-a12b  provider: nvidia-prod  sandbox GPU  policies: pypi",
    );
  });

  it("prints the per-sandbox agent type in list output", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "hermes",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            agent: "hermes",
          },
        ],
        defaultSandbox: "hermes",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      agent: hermes  model: nvidia/nemotron-3-super-120b-a12b  provider: nvidia-prod  CPU sandbox  policies: none",
    );
  });

  it("uses live gateway inference for the default sandbox in list output (#2369)", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-alpha",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: [],
          },
          {
            name: "beta",
            model: "configured-beta",
            provider: "beta-provider",
            gpuEnabled: false,
            policies: [],
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "live-provider", model: "live-model" }),
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    // Default sandbox reflects live gateway state, with an explicit drift note.
    expect(lines).toContain(
      "      agent: openclaw  model: live-model  provider: live-provider  sandbox GPU  policies: none",
    );
    // Stale stored row for the default sandbox must not leak through.
    expect(lines).not.toContain(
      "      agent: openclaw  model: configured-alpha  provider: configured-provider  sandbox GPU  policies: none",
    );
    expect(lines).toContain(
      "      (live OpenShell gateway differs from onboarded: model=configured-alpha, provider=configured-provider)",
    );
    // Non-default sandbox keeps its stored config — the gateway only applies
    // to whichever sandbox is currently connected.
    expect(lines).toContain(
      "      agent: openclaw  model: configured-beta  provider: beta-provider  CPU sandbox  policies: none",
    );
  });

  it("does not annotate the default sandbox when live gateway matches onboarded config", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-alpha",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: [],
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "configured-provider", model: "configured-alpha" }),
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      agent: openclaw  model: configured-alpha  provider: configured-provider  sandbox GPU  policies: none",
    );
    expect(lines.some((l) => l.includes("onboarded"))).toBe(false);
  });

  it("falls back to onboarded config when the gateway is unreachable", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-alpha",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: [],
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      agent: openclaw  model: configured-alpha  provider: configured-provider  sandbox GPU  policies: none",
    );
    expect(lines.some((l) => l.includes("onboarded"))).toBe(false);
  });

  it("annotates only the drifting field when the live gateway reports partial overrides", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-alpha",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: [],
          },
        ],
        defaultSandbox: "alpha",
      }),
      // Only the model changed at the gateway; provider matches onboarded.
      getLiveInference: () => ({ provider: "configured-provider", model: "live-model" }),
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      agent: openclaw  model: live-model  provider: configured-provider  sandbox GPU  policies: none",
    );
    expect(lines).toContain(
      "      (live OpenShell gateway differs from onboarded: model=configured-alpha)",
    );
  });

  it("annotates only the provider field when the live gateway provider drifts", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "configured-alpha",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: [],
          },
        ],
        defaultSandbox: "alpha",
      }),
      // Only the provider changed at the gateway; model matches onboarded.
      getLiveInference: () => ({ provider: "live-provider", model: "configured-alpha" }),
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "      agent: openclaw  model: configured-alpha  provider: live-provider  sandbox GPU  policies: none",
    );
    expect(lines).toContain(
      "      (live OpenShell gateway differs from onboarded: provider=configured-provider)",
    );
  });

  it("flags messaging bridge as degraded when checkMessagingBridgeHealth reports conflicts", () => {
    const lines: string[] = [];
    const checkMessagingBridgeHealth = vi
      .fn()
      .mockReturnValue([{ channel: "telegram", conflicts: 7 }]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            messaging: messagingState("alpha", ["telegram"]),
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      checkMessagingBridgeHealth,
      log: (message = "") => lines.push(message),
    });

    expect(checkMessagingBridgeHealth).toHaveBeenCalledWith("alpha", ["telegram"], undefined);
    expect(lines).toContain(
      "  ⚠ telegram bridge: degraded (7 conflict errors in /tmp/gateway.log)",
    );
  });

  it("skips messaging bridge check when the default sandbox has no channels", () => {
    const lines: string[] = [];
    const checkMessagingBridgeHealth = vi.fn().mockReturnValue([]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "m" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      checkMessagingBridgeHealth,
      log: (message = "") => lines.push(message),
    });

    expect(checkMessagingBridgeHealth).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("degraded"))).toBe(false);
  });

  it("prints a cross-sandbox overlap warning when findMessagingOverlaps reports overlaps", () => {
    const lines: string[] = [];
    const findMessagingOverlaps = vi
      .fn()
      .mockReturnValue([
        { channel: "telegram", sandboxes: ["alice", "bob"], reason: "matching-token" },
      ]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alice", model: "m", messaging: messagingState("alice", ["telegram"]) },
          { name: "bob", model: "m", messaging: messagingState("bob", ["telegram"]) },
        ],
        defaultSandbox: "alice",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      findMessagingOverlaps,
      log: (message = "") => lines.push(message),
    });

    expect(findMessagingOverlaps).toHaveBeenCalled();
    expect(
      lines.some((l) => l.includes("'alice' and 'bob' share the same telegram credential")),
    ).toBe(true);
  });

  it("defaults missing overlap reason to the conservative warning", () => {
    const lines: string[] = [];
    const findMessagingOverlaps = vi
      .fn()
      .mockReturnValue([{ channel: "telegram", sandboxes: ["alice", "bob"] }]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alice", model: "m", messaging: messagingState("alice", ["telegram"]) },
          { name: "bob", model: "m", messaging: messagingState("bob", ["telegram"]) },
        ],
        defaultSandbox: "alice",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      findMessagingOverlaps,
      log: (message = "") => lines.push(message),
    });

    expect(
      lines.some((l) =>
        l.includes(
          "'alice' and 'bob' may share a telegram credential; stored credential hashes are incomplete",
        ),
      ),
    ).toBe(true);
  });

  it("marks a shared-gateway Slack Socket Mode overlap as conflicted (#4953)", () => {
    const lines: string[] = [];
    const findMessagingOverlaps = vi.fn().mockReturnValue([
      {
        channel: "slack",
        sandboxes: ["alice", "bob"],
        reason: "socket-mode-gateway",
        message:
          "'{first}' and '{second}' both have Slack Socket Mode enabled on the same gateway; only one sandbox can receive Slack Socket Mode events unless the gateway supports multiplexing.",
      },
    ]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alice", model: "m", messaging: messagingState("alice", ["slack"]) },
          { name: "bob", model: "m", messaging: messagingState("bob", ["slack"]) },
        ],
        defaultSandbox: "alice",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      findMessagingOverlaps,
      log: (message = "") => lines.push(message),
    });

    expect(
      lines.some((l) =>
        l.includes("'alice' and 'bob' both have Slack Socket Mode enabled on the same gateway"),
      ),
    ).toBe(true);
  });

  it("prints a Teams webhook port overlap warning with the port", () => {
    const lines: string[] = [];
    const findMessagingOverlaps = vi.fn().mockReturnValue([
      {
        channel: "teams",
        sandboxes: ["alice", "bob"],
        reason: "host-forward-port",
        port: 3978,
        message:
          "'{first}' and '{second}' both use Microsoft Teams webhook port {port}; no two active Teams sandboxes can share that local forward.",
      },
    ]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alice", model: "m", messaging: messagingState("alice", ["teams"]) },
          { name: "bob", model: "m", messaging: messagingState("bob", ["teams"]) },
        ],
        defaultSandbox: "alice",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      findMessagingOverlaps,
      log: (message = "") => lines.push(message),
    });

    expect(
      lines.some((line) =>
        line.includes(
          "'alice' and 'bob' both use Microsoft Teams webhook port 3978; no two active Teams sandboxes can share that local forward.",
        ),
      ),
    ).toBe(true);
  });

  it("surfaces Hermes gateway log when messaging is degraded", () => {
    const lines: string[] = [];
    const checkMessagingBridgeHealth = vi
      .fn()
      .mockReturnValue([{ channel: "telegram", conflicts: 3 }]);
    const readGatewayLog = vi
      .fn()
      .mockReturnValue(
        "2026-04-17 getUpdates conflict: terminated by other getUpdates\n" +
          "2026-04-17 retrying in 5s",
      );
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            messaging: messagingState("alpha", ["telegram"]),
            agent: "hermes",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      checkMessagingBridgeHealth,
      readGatewayLog,
      log: (message = "") => lines.push(message),
    });

    expect(readGatewayLog).toHaveBeenCalledWith("alpha");
    expect(lines.some((l) => l.includes("Messaging gateway log (last 10 lines):"))).toBe(true);
    expect(lines.some((l) => l.includes("getUpdates conflict"))).toBe(true);
  });

  it("does not show gateway log for non-Hermes sandboxes", () => {
    const lines: string[] = [];
    const checkMessagingBridgeHealth = vi
      .fn()
      .mockReturnValue([{ channel: "telegram", conflicts: 3 }]);
    const readGatewayLog = vi.fn();
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            messaging: messagingState("alpha", ["telegram"]),
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      checkMessagingBridgeHealth,
      readGatewayLog,
      log: (message = "") => lines.push(message),
    });

    expect(readGatewayLog).not.toHaveBeenCalled();
  });

  it("prints sandbox models in status and delegates service status", () => {
    const lines: string[] = [];
    const showServiceStatus = vi.fn();
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
          {
            name: "beta",
            model: "z-ai/glm-5.1",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "nvidia-prod", model: "minimaxai/minimax-m2.7" }),
      showServiceStatus,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("  Sandboxes:");
    // Default sandbox shows the live gateway model (#2369), annotated with
    // the onboarded model when they differ.
    expect(lines).toContain("    alpha * (minimaxai/minimax-m2.7)");
    expect(lines).toContain("      (onboarded: nvidia/nemotron-3-super-120b-a12b)");
    // Non-default sandbox keeps its stored model — the gateway only applies
    // to whichever sandbox is currently connected.
    expect(lines).toContain("    beta (z-ai/glm-5.1)");
    expect(showServiceStatus).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  describe("#1077 — env-resolved default sandbox", () => {
    const savedSandboxName = process.env.SANDBOX_NAME;
    const savedNemoclawSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedNemoclawSandbox = process.env.NEMOCLAW_SANDBOX;

    beforeEach(() => {
      delete process.env.SANDBOX_NAME;
      delete process.env.NEMOCLAW_SANDBOX_NAME;
      delete process.env.NEMOCLAW_SANDBOX;
    });

    afterEach(() => {
      if (savedSandboxName !== undefined) process.env.SANDBOX_NAME = savedSandboxName;
      else delete process.env.SANDBOX_NAME;
      if (savedNemoclawSandboxName !== undefined) {
        process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawSandboxName;
      } else {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      }
      if (savedNemoclawSandbox !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclawSandbox;
      else delete process.env.NEMOCLAW_SANDBOX;
    });

    it("reuses the existing sandbox list when resolving status service sandbox", () => {
      const listSandboxes = vi.fn(() => ({
        sandboxes: [{ name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" }],
        defaultSandbox: "alpha",
      }));
      const showServiceStatus = vi.fn();
      showStatusCommand({
        listSandboxes,
        getLiveInference: () => null,
        showServiceStatus,
        log: vi.fn(),
      });
      expect(listSandboxes).toHaveBeenCalledOnce();
      expect(showServiceStatus).toHaveBeenCalledWith({ sandboxName: "alpha" });
    });

    it("reuses the existing sandbox list when resolving JSON status service sandbox", () => {
      const listSandboxes = vi.fn(() => ({
        sandboxes: [{ name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" }],
        defaultSandbox: "alpha",
      }));
      const getServiceStatuses = vi.fn().mockReturnValue([]);
      const report = getStatusReport({
        listSandboxes,
        getLiveInference: () => null,
        getServiceStatuses,
        showServiceStatus: vi.fn(),
      });
      expect(listSandboxes).toHaveBeenCalledOnce();
      expect(getServiceStatuses).toHaveBeenCalledWith({ sandboxName: "alpha" });
      expect(report.defaultSandbox).toBe("alpha");
    });

    it("resolves service status sandbox from SANDBOX_NAME env", () => {
      process.env.SANDBOX_NAME = "env-sandbox";
      const showServiceStatus = vi.fn();
      showStatusCommand({
        listSandboxes: () => ({
          sandboxes: [{ name: "env-sandbox" }, { name: "registry-default" }],
          defaultSandbox: "registry-default",
        }),
        getLiveInference: () => null,
        showServiceStatus,
        log: vi.fn(),
      });
      expect(showServiceStatus).toHaveBeenCalledWith({ sandboxName: "env-sandbox" });
    });

    it("resolves JSON service status sandbox from NEMOCLAW_SANDBOX_NAME env", () => {
      process.env.NEMOCLAW_SANDBOX_NAME = "json-sandbox";
      const getServiceStatuses = vi.fn().mockReturnValue([]);
      const report = getStatusReport({
        listSandboxes: () => ({
          sandboxes: [{ name: "json-sandbox" }],
          defaultSandbox: "other",
        }),
        getLiveInference: () => null,
        getServiceStatuses,
        showServiceStatus: vi.fn(),
      });
      expect(getServiceStatuses).toHaveBeenCalledWith({ sandboxName: "json-sandbox" });
      expect(report.defaultSandbox).toBe("json-sandbox");
      expect(report.sandboxes[0]?.isDefault).toBe(true);
    });

    it("resolves list default sandbox from SANDBOX_NAME env", async () => {
      process.env.SANDBOX_NAME = "env-sandbox";
      const inventory = await getSandboxInventory({
        recoverRegistryEntries: async () => ({
          sandboxes: [
            { name: "env-sandbox", model: "m1", provider: "p1" },
            { name: "registry-default", model: "m2", provider: "p2" },
          ],
          defaultSandbox: "registry-default",
        }),
        getLiveInference: () => null,
        loadLastSession: () => null,
        getActiveSessionCount: () => 0,
      });

      expect(inventory.defaultSandbox).toBe("env-sandbox");
      expect(inventory.sandboxes.find((row) => row.name === "env-sandbox")?.isDefault).toBe(true);
      expect(inventory.sandboxes.find((row) => row.name === "registry-default")?.isDefault).toBe(
        false,
      );
    });

    it("marks the env-resolved sandbox with * in list output", async () => {
      process.env.SANDBOX_NAME = "env-sandbox";
      const lines: string[] = [];
      await listSandboxesCommand({
        recoverRegistryEntries: async () => ({
          sandboxes: [
            { name: "registry-default", model: "m1", provider: "p1" },
            { name: "env-sandbox", model: "m2", provider: "p2" },
          ],
          defaultSandbox: "registry-default",
        }),
        getLiveInference: () => null,
        loadLastSession: () => null,
        log: (message = "") => lines.push(message),
      });

      expect(lines).toContain("    env-sandbox *");
      expect(lines.some((line) => line.startsWith("    registry-default *"))).toBe(false);
    });
  });

  it("does not annotate status when the live gateway matches the onboarded model", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (nvidia/nemotron-3-super-120b-a12b)");
    expect(lines.some((l) => l.includes("onboarded"))).toBe(false);
  });

  it("falls back to stored status model when the gateway is unreachable", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "nvidia/nemotron-3-super-120b-a12b" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (nvidia/nemotron-3-super-120b-a12b)");
    expect(lines.some((l) => l.includes("onboarded"))).toBe(false);
  });

  it("annotates status drift with 'unknown' when the onboarded model is missing", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        // sandbox registered without a model (possible per SandboxEntry type).
        sandboxes: [{ name: "alpha" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "nvidia-prod", model: "minimaxai/minimax-m2.7" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (minimaxai/minimax-m2.7)");
    expect(lines).toContain("      (onboarded: unknown)");
  });

  // #2604: bare `nemoclaw status` previously only showed the model in parens
  // and didn't label provider or connection state. Users had to run the
  // per-sandbox `nemoclaw <name> status` to see those fields.
  it("emits an Inference line with provider / model under each sandbox row (#2604)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
          },
          { name: "beta", model: "qwen3.5:9b", provider: "ollama-local" },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Inference: nvidia-prod / nvidia/nemotron-3-super-120b-a12b");
    expect(lines).toContain("      Inference: ollama-local / qwen3.5:9b");
  });

  it("prefers live gateway provider for the default sandbox in the Inference line (#2604)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "stored-model", provider: "stored-provider" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "live-provider", model: "live-model" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Inference: live-provider / live-model");
  });

  it("emits a Connected line per sandbox when getActiveSessionCount is provided (#2604)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alpha", model: "m" },
          { name: "beta", model: "m" },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getActiveSessionCount: (name) => (name === "alpha" ? 2 : 0),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Connected: yes (2 sessions)");
    expect(lines).toContain("      Connected: no");
  });

  it("renders `1 session` (singular) when the active count is exactly one (#2604)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "m" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getActiveSessionCount: () => 1,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("      Connected: yes (1 session)");
  });

  it("omits the Connected line when getActiveSessionCount returns null (probe unavailable)", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "m" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getActiveSessionCount: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines.some((l) => l.includes("Connected:"))).toBe(false);
  });

  it("omits the Connected line when the dep is not wired", () => {
    const lines: string[] = [];
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha", model: "m" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines.some((l) => l.includes("Connected:"))).toBe(false);
  });

  it("emits a gateway-down diagnostic and sets process.exitCode when the gateway is unhealthy (#3386)", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const lines: string[] = [];
    try {
      showStatusCommand({
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha", model: "m" }],
          defaultSandbox: "alpha",
        }),
        getLiveInference: () => null,
        showServiceStatus: vi.fn(),
        getGatewayHealth: () => ({
          healthy: false,
          state: "named_unreachable",
          reason: "host port held or container not running",
        }),
        log: (message = "") => lines.push(message),
      });

      expect(
        lines.some((l) =>
          l.includes("gateway: down [named_unreachable] (host port held or container not running)"),
        ),
      ).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("keeps process.exitCode at 0 when getGatewayHealth reports healthy", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const lines: string[] = [];
    try {
      showStatusCommand({
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha", model: "m" }],
          defaultSandbox: "alpha",
        }),
        getLiveInference: () => null,
        showServiceStatus: vi.fn(),
        getGatewayHealth: () => ({ healthy: true, state: "healthy_named" }),
        log: (message = "") => lines.push(message),
      });

      expect(lines.some((l) => l.includes("gateway: down"))).toBe(false);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves legacy 0-exit behaviour when getGatewayHealth dep is omitted", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      showStatusCommand({
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha", model: "m" }],
          defaultSandbox: "alpha",
        }),
        getLiveInference: () => null,
        showServiceStatus: vi.fn(),
      });
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("skips the gateway health check when no sandboxes are registered", () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const lines: string[] = [];
    const getGatewayHealth = vi.fn();
    try {
      showStatusCommand({
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        getLiveInference: () => null,
        showServiceStatus: vi.fn(),
        getGatewayHealth,
        log: (message = "") => lines.push(message),
      });

      expect(getGatewayHealth).not.toHaveBeenCalled();
      expect(lines.some((l) => l.includes("gateway: down"))).toBe(false);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
