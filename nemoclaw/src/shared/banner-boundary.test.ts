// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { renderBox } from "./banner-boundary.cjs";

// Direct contract test for the one shared renderer (replaced the two per-package parity suites).
describe("renderBox", () => {
  it("renders a default-width box", () => {
    const lines = renderBox(["  Hello"], { columns: 100 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^  ┌─+┐$/);
    expect(lines[2]).toMatch(/^  └─+┘$/);
    expect(lines[0].length).toBeGreaterThanOrEqual(57);
  });

  it("renders equal-width rows with a blank separator for null entries", () => {
    const lines = renderBox(
      ["  NemoClaw registered", null, "  Endpoint:  https://integrate.api.nvidia.com/v1"],
      { columns: 100 },
    );
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[2]).toMatch(/^  │ +│$/);
  });

  it("expands for long URLs and leaves a safety gap before the border", () => {
    const url = "  Public URL:  https://very-long-subdomain-name.trycloudflare.com";
    const lines = renderBox([url], { columns: 120 });
    expect(lines[1]).toContain("very-long-subdomain-name.trycloudflare.com");
    expect(lines[1]).toMatch(/ {2}│$/);
  });

  it("caps every row at terminal columns while preserving the safety gap", () => {
    const lines = renderBox(["x".repeat(200)], { columns: 80 });
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines[1]).toMatch(/ {2}│$/);
  });

  it("handles very narrow terminals without overflowing", () => {
    const lines = renderBox(["abcdef"], { columns: 5 });
    expect(lines.every((line) => line.length <= 5)).toBe(true);
    expect(lines[1]).toBe("  │ │");
  });
});
