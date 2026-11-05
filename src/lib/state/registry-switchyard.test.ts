// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { switchyardBindingFixture } from "../../../test/helpers/hermes-switchyard";
import { createHermesSwitchyardRoutingIntent } from "../hermes-switchyard-routing";

it("retains binding observations across reservation reload and rejects malformed persisted roles (#13863)", async () => {
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-registry-"));
  vi.stubEnv("HOME", testHome);
  vi.resetModules();
  try {
    const registry = await import("./registry");
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const bindings = switchyardBindingFixture(routing);
    const hermesSwitchyard = { routing, bindings };
    expect(
      registry.reserveSandboxInferenceRoute("alpha", {
        provider: routing.capable.provider,
        model: routing.capable.model,
        endpointUrl: "https://api.openai.com/v1",
        endpointSource: "onboard",
        credentialEnv: "OPENAI_API_KEY",
        gatewayName: "test-gateway",
        preferredInferenceApi: "openai-completions",
        reservationSessionId: "test-session",
        hermesSwitchyard,
      }),
    ).toBe(true);
    expect(registry.getSandbox("alpha")?.hermesSwitchyard).toEqual(hermesSwitchyard);
    registry.registerSandbox({
      name: "registered",
      agent: "hermes",
      provider: routing.capable.provider,
      model: routing.capable.model,
      gatewayName: "test-gateway",
      hermesSwitchyard,
    });
    expect(registry.getSandbox("registered")?.hermesSwitchyard).toEqual(hermesSwitchyard);
    expect(() =>
      registry.registerSandbox({
        name: "invalid",
        provider: routing.capable.provider,
        model: routing.capable.model,
        hermesSwitchyard: {
          routing,
          bindings: { ...bindings, judge: { ...bindings.judge, model: "wrong-model" } },
        },
      }),
    ).toThrow("provider state");
  } finally {
    await fs.rm(testHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it.each(["gpt-5", "another-model"])(
  "rejects a binding-free reservation for a routed sandbox selecting %s (#13863)",
  async (model) => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-reservation-"));
    vi.stubEnv("HOME", testHome);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
      });
      const route = {
        provider: routing.capable.provider,
        model: routing.capable.model,
        endpointUrl: "https://api.openai.com/v1",
        endpointSource: "onboard" as const,
        credentialEnv: "OPENAI_API_KEY",
        preferredInferenceApi: "openai-completions",
        gatewayName: "test-gateway",
      };
      registry.registerSandbox({
        name: "routed",
        agent: "hermes",
        ...route,
        hermesSwitchyard: { routing, bindings: switchyardBindingFixture(routing) },
      });
      const before = await fs.readFile(registry.REGISTRY_FILE, "utf8");
      expect(() =>
        registry.reserveSandboxInferenceRoute("routed", {
          ...route,
          model,
          reservationSessionId: "resume-session",
        }),
      ).toThrow("recorded Switchyard provider bindings");
      expect(await fs.readFile(registry.REGISTRY_FILE, "utf8")).toBe(before);
    } finally {
      await fs.rm(testHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);

it.each(["load", "save"] as const)(
  "identifies the sandbox and preserves the cause when binding validation prevents %s (#13863)",
  async (operation) => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-switchyard-invalid-"));
    vi.stubEnv("HOME", testHome);
    vi.resetModules();
    try {
      const persistence = await import("./registry/persistence");
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
      });
      const bindings = switchyardBindingFixture(routing);
      const data = {
        defaultSandbox: null,
        sandboxes: {
          routed: {
            name: "routed",
            hermesSwitchyard: {
              routing,
              bindings: { ...bindings, judge: { ...bindings.judge, model: "wrong-model" } },
            },
          },
        },
      };
      persistence.save({ defaultSandbox: null, sandboxes: {} });
      const attempts = {
        load: async () => {
          await fs.writeFile(persistence.REGISTRY_FILE, JSON.stringify(data));
          return () => persistence.load();
        },
        save: async () => () => persistence.save(data),
      };
      const attempt = await attempts[operation]();
      const before = await fs.readFile(persistence.REGISTRY_FILE, "utf8");
      const error = await Promise.resolve()
        .then(attempt)
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        message: expect.stringContaining(`Cannot ${operation} sandbox "routed"`),
        cause: expect.any(Error),
      });
      expect((error as Error).message).toContain(
        "Inspect and repair hermesSwitchyard before retrying",
      );
      expect(await fs.readFile(persistence.REGISTRY_FILE, "utf8")).toBe(before);
    } finally {
      await fs.rm(testHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
