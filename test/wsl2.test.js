// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isWSL2, detectGpu } = require("../bin/lib/nim");

describe("isWSL2", () => {
  it("returns a boolean", () => {
    assert.equal(typeof isWSL2(), "boolean");
  });

  it("returns false on non-linux platforms", () => {
    // /proc/version does not exist on macOS/Windows, so isWSL2() returns false.
    if (process.platform !== "linux") {
      assert.equal(isWSL2(), false);
    }
  });

  it("does not throw on any platform", () => {
    assert.doesNotThrow(() => isWSL2());
  });
});

describe("detectGpu WSL2 awareness", () => {
  it("returns an object or null", () => {
    const gpu = detectGpu();
    assert.ok(gpu === null || typeof gpu === "object");
  });

  it("includes wsl2 field when nvidia GPU detected", () => {
    const gpu = detectGpu();
    if (gpu && gpu.type === "nvidia") {
      assert.equal(typeof gpu.wsl2, "boolean");
      // On WSL2, nimCapable should be false despite GPU presence
      if (gpu.wsl2) {
        assert.equal(gpu.nimCapable, false);
      }
    }
  });
});
