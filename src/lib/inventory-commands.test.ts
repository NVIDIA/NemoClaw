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

  it("shows stored sandbox inference instead of live gateway inference in list output", async () => {
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

    expect(lines).toContain(
      "      model: configured-alpha  provider: configured-provider  GPU  policies: none",
    );
    expect(lines).not.toContain(
      "      model: live-model  provider: live-provider  GPU  policies: none",
    );
    expect(lines).toContain(
      "      model: configured-beta  provider: beta-provider  CPU  policies: none",
    );
  });

  it("prints stored sandbox models in status and delegates service status", () => {
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
    expect(lines).toContain("    alpha * (nvidia/nemotron-3-super-120b-a12b)");
    expect(lines).not.toContain("    alpha * (moonshotai/kimi-k2.5)");
    expect(lines).toContain("    beta (z-ai/glm5)");
    expect(showServiceStatus).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });
});
