// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WEATHER_RESPONSE_VALIDATION_PYTHON } from "../live/common-egress-agent-helpers.ts";

describe("weather response proof", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "nemoclaw-weather-proof-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function validate(body: unknown): void {
    const path = join(directory, "response.json");
    writeFileSync(path, JSON.stringify(body));
    execFileSync("python3", ["-c", WEATHER_RESPONSE_VALIDATION_PYTHON, path], { stdio: "pipe" });
  }

  function response() {
    return {
      latitude: 37.7749,
      longitude: -122.4194,
      current: { temperature_2m: 12.3, time: "2026-11-02T12:00" },
      current_units: { temperature_2m: "°C" },
    };
  }

  it("accepts a finite Celsius temperature for the requested location", () => {
    expect(() => validate(response())).not.toThrow();
  });

  it.each([
    ["a reply token", "WEATHER_AGENT_OK"],
    ["an empty object", {}],
    ["another location", { ...response(), latitude: 40 }],
    ["another longitude", { ...response(), longitude: 122.4194 }],
    [
      "a string temperature",
      { ...response(), current: { ...response().current, temperature_2m: "12" } },
    ],
    [
      "a Boolean temperature",
      { ...response(), current: { ...response().current, temperature_2m: true } },
    ],
    ["a missing time", { ...response(), current: { temperature_2m: 12 } }],
    ["an empty time", { ...response(), current: { ...response().current, time: "" } }],
    ["a different unit", { ...response(), current_units: { temperature_2m: "°F" } }],
    ["a missing temperature", { ...response(), current: { time: response().current.time } }],
  ])("rejects %s", (_label, body) => {
    expect(() => validate(body)).toThrow();
  });
});
