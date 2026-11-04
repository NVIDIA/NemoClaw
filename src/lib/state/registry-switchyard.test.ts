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
