// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

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

describe("weather policy preset", () => {
  it("allows only current weather hosts and keeps wttr.in read-only (#1417)", () => {
    const presetPath = new URL(
      "../nemoclaw-blueprint/policies/presets/weather.yaml",
      import.meta.url,
    );
    const parsed = YAML.parse(fs.readFileSync(presetPath, "utf8")) as WeatherPreset;
    const endpoints = parsed.network_policies?.weather?.endpoints ?? [];

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
});
