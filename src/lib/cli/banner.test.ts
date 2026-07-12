// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { renderBox } from "./banner";

describe("renderBox", () => {
  it("renders a default-width box", () => {
    const lines = renderBox(["  Hello"], { columns: 100 });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^  ┌─+┐$/);
    expect(lines[2]).toMatch(/^  └─+┘$/);
    expect(lines[0].length).toBeGreaterThanOrEqual(57);
  });

  it("expands for long URLs and leaves a safety gap before the border", () => {
    const url = "  Public URL:  https://very-long-subdomain-name.trycloudflare.com";
    const lines = renderBox([url], { columns: 120 });

    expect(lines[1]).toContain("very-long-subdomain-name.trycloudflare.com");
    expect(lines[1]).toMatch(/ {2}│$/);
  });

  it("caps every row at terminal columns while preserving URL safety gap", () => {
    const lines = renderBox(["x".repeat(200)], { columns: 80 });

    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines[1]).toMatch(/ {2}│$/);
  });

  it("renders null entries as blank separator rows", () => {
    const lines = renderBox(["  Title", null, "  Content"], { columns: 100 });

    expect(lines[2]).toMatch(/^  │ +│$/);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it("handles very narrow terminals without overflowing", () => {
    const lines = renderBox(["abcdef"], { columns: 5 });

    expect(lines.every((line) => line.length <= 5)).toBe(true);
    expect(lines[1]).toBe("  │ │");
  });
});
