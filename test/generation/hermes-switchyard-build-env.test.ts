// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readHermesBuildSettings } from "../../agents/hermes/config/build-env.ts";
import { generateHermesConfig } from "../../agents/hermes/config/generate.ts";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_ROUTING_ENV,
} from "../../src/lib/hermes-switchyard-routing.ts";
import { PROVIDERLESS_INFERENCE_ENV } from "../../src/lib/providerless-inference.ts";

describe("Hermes Switchyard build environment", () => {
  it("rejects routed configuration without observed bindings before writing files (#13863)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-missing-bindings-"));
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/efficient-model" },
      capable: { provider: "openai-api", model: "openai/capable-model" },
    });
    try {
      expect(() =>
        generateHermesConfig({
          homeDir,
          scriptDir: path.resolve(import.meta.dirname, "../../agents/hermes"),
          env: {
            NEMOCLAW_INFERENCE_BASE_URL: "https://api.openai.com/v1",
            [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing),
          },
          log: () => {},
        }),
      ).toThrow("Hermes Switchyard provider binding");
      expect(fs.existsSync(path.join(homeDir, ".hermes", "config.yaml"))).toBe(false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects Switchyard routing without configured inference providers (#13862)", () => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/efficient-model" },
      capable: { provider: "openai-api", model: "openai/capable-model" },
    });

    expect(() =>
      readHermesBuildSettings({
        ...PROVIDERLESS_INFERENCE_ENV,
        [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing),
      }),
    ).toThrow("Hermes Switchyard routing requires configured inference providers");
  });
});
