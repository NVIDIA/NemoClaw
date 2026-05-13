// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { renderBox } from "./banner.js";

describe("renderBox (plugin)", () => {
  it("renders the registration banner with equal-width rows", () => {
    const lines = renderBox(
      [
        "  NemoClaw registered",
        null,
        "  Endpoint:  https://integrate.api.nvidia.com/v1",
        "  Provider:  NVIDIA Endpoints",
        "  Model:     nvidia/nemotron-3-super-120b-a12b",
        "  Slash:     /nemoclaw",
      ],
      { columns: 100 },
    );

    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[3]).toMatch(/ {2,}│$/);
  });

  it("expands for long endpoint URLs", () => {
    const endpoint =
      "  Endpoint:  https://very-long-custom-endpoint.internal.nvidia.com/v1/completions";
    const lines = renderBox([endpoint], { columns: 120 });

    expect(lines[1]).toContain("very-long-custom-endpoint.internal.nvidia.com");
    expect(lines[1]).toMatch(/ {2}│$/);
  });

  it("truncates in narrow terminals but keeps a border safety gap", () => {
    const lines = renderBox(["x".repeat(200)], { columns: 80 });

    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines[1]).toMatch(/ {2}│$/);
  });
});
