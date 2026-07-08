// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";

import { WEATHER_FIXTURE_VERSION } from "./version.js";

const WeatherParameters = Type.Object(
  {
    location: Type.String({ description: "City or place name." }),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "weather",
  name: "NemoClaw E2E Weather",
  description: "Registers a deterministic weather tool for custom-image lifecycle tests.",
  tools: (tool) => [
    tool({
      name: "get_weather",
      label: "Get Weather",
      description: "Return deterministic weather data for a location.",
      parameters: WeatherParameters,
      async execute({ location }) {
        return {
          location,
          condition: "clear",
          temperatureC: 21,
          fixtureVersion: WEATHER_FIXTURE_VERSION,
        };
      },
    }),
  ],
});
