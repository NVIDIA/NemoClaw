// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../agent/defs";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import { applyReusedSandboxDashboardState } from "./sandbox-reuse";

const sandboxGpuConfig: SandboxGpuConfig = {
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  mode: "auto",
  sandboxGpuDevice: null,
  errors: [],
};

async function reuseWith(
  requested: readonly string[] | undefined,
  recorded: string[] | undefined,
  agentName = "openclaw",
) {
  const note = vi.fn();
  const updateSandbox = vi.fn();
  await applyReusedSandboxDashboardState({
    sandboxName: "reuse-me",
    chatUiUrl: "http://127.0.0.1:18789",
    env: {},
    agent: loadAgent(agentName),
    model: "test-model",
    provider: "nvidia-prod",
    selectionVerified: true,
    sandboxGpuConfig,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    getSandbox: () => ({ name: "reuse-me", dashboardOrigins: recorded }) as never,
    ensureDashboardForward: vi.fn(() => 18789),
    hermesDashboardForwarding: {
      resolveStateForPort: vi.fn(() => ({ enabled: false, config: null })),
      ensureForState: vi.fn(),
    },
    updateSandbox,
    updateReusedSandboxMetadata: vi.fn(),
    note,
    cliName: "nemoclaw",
    ...(requested === undefined ? {} : { dashboardOrigins: requested }),
  });
  return { note, update: updateSandbox.mock.calls[0]?.[1] as Record<string, unknown> };
}

describe("reused sandbox dashboard origins (#13177)", () => {
  it("records new origins and says a rebuild applies them", async () => {
    const { note, update } = await reuseWith(["https://launchpad.example.test:8443"], undefined);

    expect(update.dashboardOrigins).toEqual(["https://launchpad.example.test:8443"]);
    expect(note).toHaveBeenCalledWith(
      "  Dashboard origins changed to https://launchpad.example.test:8443. The running sandbox still allows only its previous origins; run: nemoclaw reuse-me rebuild",
    );
  });

  it("clears removed origins and says a rebuild removes them", async () => {
    const { note, update } = await reuseWith(undefined, ["https://launchpad.example.test:8443"]);

    expect(update).toHaveProperty("dashboardOrigins", undefined);
    expect(note).toHaveBeenCalledWith(
      "  Dashboard origins https://launchpad.example.test:8443 were removed. The running sandbox still allows them until you run: nemoclaw reuse-me rebuild",
    );
  });

  it("stays quiet when the origins do not change", async () => {
    const { note } = await reuseWith(
      ["https://launchpad.example.test:8443"],
      ["https://launchpad.example.test:8443"],
    );

    expect(note).not.toHaveBeenCalled();
  });

  it("does not record origins for other agents", async () => {
    const { note, update } = await reuseWith(undefined, undefined, "hermes");

    expect(update).not.toHaveProperty("dashboardOrigins");
    expect(note).not.toHaveBeenCalled();
  });
});
