// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  booleanConfigValue,
  configInputDetail,
  configValuesEqual,
  formatConfigValue,
  listConfigValues,
} from "./channel-status-config-values";

describe("channel status config value helpers", () => {
  it("formats scalar and list values for status output", () => {
    expect(configInputDetail(undefined)).toBe("not set");
    expect(formatConfigValue("")).toBe('""');
    expect(formatConfigValue(["b", "a"])).toBe("b, a");
    expect(formatConfigValue([])).toBe("[]");
    expect(formatConfigValue({ enabled: true })).toBe('{"enabled":true}');
  });

  it("normalizes comma-separated and array values before comparing", () => {
    expect(listConfigValues("b, a,")).toEqual(["a", "b"]);
    expect(configValuesEqual("b,a", ["a", "b"])).toBe(true);
    expect(configValuesEqual("a,b", ["a", "c"])).toBe(false);
  });

  it("normalizes boolean-like config values before comparing", () => {
    expect(booleanConfigValue("1")).toBe(true);
    expect(booleanConfigValue("false")).toBe(false);
    expect(booleanConfigValue(1)).toBe(true);
    expect(booleanConfigValue(0)).toBe(false);
    expect(booleanConfigValue(2)).toBeNull();
    expect(booleanConfigValue("enabled")).toBeNull();
    expect(configValuesEqual("1", true)).toBe(true);
    expect(configValuesEqual("0", false)).toBe(true);
    expect(configValuesEqual(1, true)).toBe(true);
    expect(configValuesEqual(0, false)).toBe(true);
    expect(configValuesEqual("true", false)).toBe(false);
  });
});
