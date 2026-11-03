// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readHermesBuildSettings } from "../../agents/hermes/config/build-env.ts";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_ROUTING_ENV,
} from "../../src/lib/hermes-switchyard-routing.ts";
import { PROVIDERLESS_INFERENCE_ENV } from "../../src/lib/providerless-inference.ts";

describe("Hermes Switchyard build environment", () => {
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
