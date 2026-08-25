// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { boundedSecretFreeText } from "./secret-free-text";

describe("boundedSecretFreeText", () => {
  it("bounds the fallback when the input is empty (#10140)", () => {
    expect(boundedSecretFreeText("", 4, "fallback")).toBe("fall");
    expect(boundedSecretFreeText("", 1, "🔒 fallback")).toBe("");
  });

  it("returns no text for invalid or zero byte limits (#10140)", () => {
    expect(boundedSecretFreeText("diagnostic", 0, "fallback")).toBe("");
    expect(boundedSecretFreeText("diagnostic", Number.NaN, "fallback")).toBe("");
    expect(boundedSecretFreeText("diagnostic", Number.POSITIVE_INFINITY, "fallback")).toBe("");
  });
});
