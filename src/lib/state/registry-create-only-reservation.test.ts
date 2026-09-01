// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PROVIDERLESS_ROUTE = {
  provider: null,
  model: null,
  endpointUrl: null,
  endpointSource: null,
  credentialEnv: null,
  preferredInferenceApi: null,
  gatewayName: "nemoclaw",
  reservationSessionId: "session-apf",
} as const;

describe("create-only sandbox route reservation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("atomically refuses a reservation when any registry row exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-create-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.registerSandbox({
        name: "alpha",
        provider: "nim",
        model: "model-a",
        endpointUrl: null,
        endpointSource: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        agent: "openclaw",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
      });
      const before = registry.getSandbox("alpha");

      expect(
        registry.reserveSandboxInferenceRoute("alpha", PROVIDERLESS_ROUTE, {
          requireAbsent: true,
        }),
      ).toBe(false);
      expect(registry.getSandbox("alpha")).toEqual(before);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("creates an absent providerless reservation without claiming the default", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-create-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");

      expect(
        registry.reserveSandboxInferenceRoute("alpha", PROVIDERLESS_ROUTE, {
          requireAbsent: true,
        }),
      ).toBe(true);
      expect(registry.getSandbox("alpha")).toMatchObject({
        name: "alpha",
        pendingRouteReservation: true,
        reservationSessionId: "session-apf",
        provider: null,
        model: null,
      });
      expect(registry.getDefault()).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each(["session-apf", "session-foreign"])(
    "does not reuse an existing %s pending row",
    async (existingSessionId) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-create-reservation-"));
      vi.stubEnv("HOME", home);
      vi.resetModules();
      try {
        const registry = await import("./registry");
        registry.reserveSandboxInferenceRoute("alpha", {
          ...PROVIDERLESS_ROUTE,
          reservationSessionId: existingSessionId,
        });
        const before = registry.getSandbox("alpha");

        expect(
          registry.reserveSandboxInferenceRoute("alpha", PROVIDERLESS_ROUTE, {
            requireAbsent: true,
          }),
        ).toBe(false);
        expect(registry.getSandbox("alpha")).toEqual(before);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );
});
