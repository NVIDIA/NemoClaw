// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadAgent } from "../src/lib/agent/defs.ts";

type WeatherEndpoint = {
  host: string;
  port: number;
  protocol: string;
  enforcement: string;
  rules: Array<{ allow: { method: string; path: string } }>;
};

type WeatherPreset = {
  network_policies?: {
    weather?: {
      endpoints?: WeatherEndpoint[];
    };
  };
};

const REVIEWED_WTTR_WEATHER_SKILL_OPENCLAW_VERSION = "2026.6.10";

describe("weather policy preset", () => {
  it("allows only current weather hosts and keeps wttr.in read-only (#1417)", () => {
    const presetPath = new URL(
      "../nemoclaw-blueprint/policies/presets/weather.yaml",
      import.meta.url,
    );
    const parsed = YAML.parse(fs.readFileSync(presetPath, "utf8")) as WeatherPreset;
    const endpoints = parsed.network_policies?.weather?.endpoints ?? [];

    // wttr.is remains intentionally excluded until a pinned runtime actually
    // requires it; weather.yaml records the OpenClaw version review boundary.
    expect(endpoints.map(({ host }) => host).sort()).toEqual([
      "api.open-meteo.com",
      "api.weather.gov",
      "geocoding-api.open-meteo.com",
      "wttr.in",
    ]);
    expect(endpoints.find(({ host }) => host === "wttr.in")).toEqual({
      host: "wttr.in",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: "/**" } },
        { allow: { method: "HEAD", path: "/**" } },
      ],
    });
  });

  it("forces wttr.in egress re-review when the OpenClaw pin changes (#1417)", () => {
    const openClaw = loadAgent("openclaw");

    expect(
      openClaw.expectedVersion,
      "Revalidate the bundled OpenClaw weather skill egress and update the weather host/rule contract before changing the reviewed version",
    ).toBe(REVIEWED_WTTR_WEATHER_SKILL_OPENCLAW_VERSION);
  });
});
