// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("sandbox inference route reservation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("persists a complete route without claiming the default sandbox", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");

      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: "https://api.example.test/v1",
          credentialEnv: "CUSTOM_API_KEY",
          preferredInferenceApi: "openai-responses",
          gatewayName: "nemoclaw-9090",
        }),
      ).toBe(true);

      expect(registry.listSandboxes()).toMatchObject({
        defaultSandbox: null,
        sandboxes: [
          {
            name: "alpha",
            provider: "compatible-endpoint",
            model: "model-a",
            endpointUrl: "https://api.example.test/v1",
            credentialEnv: "CUSTOM_API_KEY",
            preferredInferenceApi: "openai-responses",
            gatewayName: "nemoclaw-9090",
          },
        ],
      });
      expect(registry.getDefault()).toBeNull();
      expect(registry.setDefault("alpha")).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("retargets an existing row to the gateway protected by the reservation", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "nvidia-prod",
        model: "model-a",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      });

      registry.reserveSandboxInferenceRoute("alpha", {
        provider: "anthropic-prod",
        model: "model-b",
        endpointUrl: null,
        credentialEnv: "ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
        gatewayName: "nemoclaw-9090",
      });

      expect(registry.getSandbox("alpha")).toMatchObject({
        gatewayName: "nemoclaw-9090",
        provider: "anthropic-prod",
        model: "model-b",
        pendingRouteReservation: true,
      });
      expect(registry.getSandbox("alpha")?.gatewayPort).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
