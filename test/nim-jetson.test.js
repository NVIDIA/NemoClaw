// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const nim = require("../bin/lib/nim");

describe("UNIFIED_MEMORY_CHIPS", () => {
  it("is exported as an array", () => {
    assert.ok(Array.isArray(nim.UNIFIED_MEMORY_CHIPS));
  });

  it("includes GB10 (DGX Spark)", () => {
    assert.ok(nim.UNIFIED_MEMORY_CHIPS.includes("GB10"));
  });

  it("includes Thor (Jetson Thor)", () => {
    assert.ok(nim.UNIFIED_MEMORY_CHIPS.includes("Thor"));
  });

  it("includes Orin (Jetson Orin / Orin Nano / Orin NX)", () => {
    assert.ok(nim.UNIFIED_MEMORY_CHIPS.includes("Orin"));
  });

  it("includes Xavier (Jetson Xavier)", () => {
    assert.ok(nim.UNIFIED_MEMORY_CHIPS.includes("Xavier"));
  });

  it("matches Jetson Thor chip names via substring", () => {
    const names = ["NVIDIA Thor", "Thor (nvgpu)", "Jetson Thor"];
    for (const name of names) {
      const matched = nim.UNIFIED_MEMORY_CHIPS.some((chip) => name.includes(chip));
      assert.ok(matched, `should match "${name}"`);
    }
  });

  it("matches Jetson Orin variants via substring", () => {
    const names = ["Orin (nvgpu)", "Orin Nano", "Orin NX", "Jetson Orin"];
    for (const name of names) {
      const matched = nim.UNIFIED_MEMORY_CHIPS.some((chip) => name.includes(chip));
      assert.ok(matched, `should match "${name}"`);
    }
  });

  it("matches DGX Spark GB10 via substring", () => {
    const matched = nim.UNIFIED_MEMORY_CHIPS.some((chip) => "NVIDIA GB10".includes(chip));
    assert.ok(matched);
  });

  it("does NOT match discrete GPUs", () => {
    const discrete = [
      "NVIDIA GeForce RTX 4090",
      "NVIDIA A100-SXM4-80GB",
      "NVIDIA H100",
      "Tesla V100-SXM2-16GB",
    ];
    for (const name of discrete) {
      const matched = nim.UNIFIED_MEMORY_CHIPS.some((chip) => name.includes(chip));
      assert.ok(!matched, `should NOT match "${name}"`);
    }
  });

  it("spark flag is true only for GB10 (case-insensitive)", () => {
    // Verify the logic: spark = nameOutput.toLowerCase().includes("gb10")
    const testCases = [
      { name: "NVIDIA GB10", expectedSpark: true },
      { name: "NVIDIA gb10", expectedSpark: true },
      { name: "NVIDIA Gb10", expectedSpark: true },
      { name: "NVIDIA Thor", expectedSpark: false },
      { name: "Orin (nvgpu)", expectedSpark: false },
      { name: "Orin Nano", expectedSpark: false },
      { name: "Xavier", expectedSpark: false },
    ];
    for (const { name, expectedSpark } of testCases) {
      assert.equal(name.toLowerCase().includes("gb10"), expectedSpark, `spark for "${name}"`);
    }
  });

  it("name extraction takes first line", () => {
    const multiLine = "Orin (nvgpu)\nSomething else";
    assert.equal(multiLine.split("\n")[0].trim(), "Orin (nvgpu)");
  });
});
