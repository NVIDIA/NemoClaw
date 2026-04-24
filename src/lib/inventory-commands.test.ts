// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { listSandboxesCommand, showStatusCommand } from "./inventory-commands";

describe("inventory commands", () => {
  it("prints the empty-state onboarding hint when no sandboxes exist", async () => {
    const lines: string[] = [];
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
      getLiveInference: () => null,
      loadLastSession: () => ({ sandboxName: "alpha" }),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain(
      "  No sandboxes registered locally, but the last onboarded sandbox was 'alpha'.",
    );
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
      "      model: nvidia/nemotron-3-super-120b-a12b  provider: nvidia-prod  GPU  policies: pypi",
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

    // Default sandbox reflects live gateway state, with an onboarded drift note.
    expect(lines).toContain(
      "      model: live-model  provider: live-provider  GPU  policies: none",
    );
    // Stale stored row for the default sandbox must not leak through.
    expect(lines).not.toContain(
      "      model: configured-alpha  provider: configured-provider  GPU  policies: none",
    );
    expect(lines).toContain(
      "      (onboarded: model=configured-alpha, provider=configured-provider)",
    );
    // Non-default sandbox keeps its stored config — the gateway only applies
    // to whichever sandbox is currently connected.
    expect(lines).toContain(
      "      model: configured-beta  provider: beta-provider  CPU  policies: none",
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
      "      model: configured-alpha  provider: configured-provider  GPU  policies: none",
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
      "      model: configured-alpha  provider: configured-provider  GPU  policies: none",
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
      "      model: live-model  provider: configured-provider  GPU  policies: none",
    );
    expect(lines).toContain("      (onboarded: model=configured-alpha)");
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
      "      model: configured-alpha  provider: live-provider  GPU  policies: none",
    );
    expect(lines).toContain("      (onboarded: provider=configured-provider)");
  });

  it("flags messaging bridge as degraded when checkMessagingBridgeHealth reports conflicts", () => {
    const lines: string[] = [];
    const checkMessagingBridgeHealth = vi.fn().mockReturnValue([
      { channel: "telegram", conflicts: 7 },
    ]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            messagingChannels: ["telegram"],
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      checkMessagingBridgeHealth,
      log: (message = "") => lines.push(message),
    });

    expect(checkMessagingBridgeHealth).toHaveBeenCalledWith("alpha", ["telegram"]);
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

  it("prints a cross-sandbox overlap warning when backfillAndFindOverlaps reports overlaps", () => {
    const lines: string[] = [];
    const backfillAndFindOverlaps = vi.fn().mockReturnValue([
      { channel: "telegram", sandboxes: ["alice", "bob"] },
    ]);
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          { name: "alice", model: "m", messagingChannels: ["telegram"] },
          { name: "bob", model: "m", messagingChannels: ["telegram"] },
        ],
        defaultSandbox: "alice",
      }),
      getLiveInference: () => null,
      showServiceStatus: vi.fn(),
      backfillAndFindOverlaps,
      log: (message = "") => lines.push(message),
    });

    expect(backfillAndFindOverlaps).toHaveBeenCalled();
    expect(
      lines.some((l) => l.includes("telegram is enabled on both 'alice' and 'bob'")),
    ).toBe(true);
  });

  it("surfaces Hermes gateway log when messaging is degraded", () => {
    const lines: string[] = [];
    const checkMessagingBridgeHealth = vi.fn().mockReturnValue([
      { channel: "telegram", conflicts: 3 },
    ]);
    const readGatewayLog = vi.fn().mockReturnValue(
      "2026-04-17 getUpdates conflict: terminated by other getUpdates\n" +
      "2026-04-17 retrying in 5s",
    );
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            messagingChannels: ["telegram"],
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
    const checkMessagingBridgeHealth = vi.fn().mockReturnValue([
      { channel: "telegram", conflicts: 3 },
    ]);
    const readGatewayLog = vi.fn();
    showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: "alpha",
            model: "m",
            messagingChannels: ["telegram"],
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
            model: "z-ai/glm5",
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({ provider: "nvidia-prod", model: "moonshotai/kimi-k2.5" }),
      showServiceStatus,
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("  Sandboxes:");
    // Default sandbox shows the live gateway model (#2369), annotated with
    // the onboarded model when they differ.
    expect(lines).toContain("    alpha * (moonshotai/kimi-k2.5)");
    expect(lines).toContain("      (onboarded: nvidia/nemotron-3-super-120b-a12b)");
    // Non-default sandbox keeps its stored model — the gateway only applies
    // to whichever sandbox is currently connected.
    expect(lines).toContain("    beta (z-ai/glm5)");
    expect(showServiceStatus).toHaveBeenCalledWith({ sandboxName: "alpha" });
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
      getLiveInference: () => ({ provider: "nvidia-prod", model: "moonshotai/kimi-k2.5" }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines).toContain("    alpha * (moonshotai/kimi-k2.5)");
    expect(lines).toContain("      (onboarded: unknown)");
  });
});
