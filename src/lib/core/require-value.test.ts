// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { requireValue } from "./require-value";

describe("requireValue", () => {
  it("returns the value when non-null and non-undefined", () => {
    expect(requireValue("hello", "should not throw")).toBe("hello");
  });

  it("throws with the given message when value is null", () => {
    expect(() => requireValue(null, "value is required")).toThrow("value is required");
  });

  it("throws with the given message when value is undefined", () => {
    expect(() => requireValue(undefined, "value is required")).toThrow("value is required");
  });
});
