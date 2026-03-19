// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const nim = require("../bin/lib/nim");

// Detect GPU once for conditional test gating.
const detectedGpu = nim.detectGpu();
const isDiscreteNvidia = detectedGpu && detectedGpu.type === "nvidia" && !detectedGpu.jetson;
const isJetson = detectedGpu && detectedGpu.type === "nvidia" && detectedGpu.jetson;
const isApple = detectedGpu && detectedGpu.type === "apple";

describe("nim", () => {
  describe("listModels", () => {
    it("returns 5 models", () => {
      assert.equal(nim.listModels().length, 5);
    });

    it("each model has name, image, and minGpuMemoryMB", () => {
      for (const m of nim.listModels()) {
        assert.ok(m.name, "missing name");
        assert.ok(m.image, "missing image");
        assert.ok(typeof m.minGpuMemoryMB === "number", "minGpuMemoryMB should be number");
        assert.ok(m.minGpuMemoryMB > 0, "minGpuMemoryMB should be positive");
      }
    });
  });

  describe("getImageForModel", () => {
    it("returns correct image for known model", () => {
      assert.equal(
        nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b"),
        "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"
      );
    });

    it("returns null for unknown model", () => {
      assert.equal(nim.getImageForModel("bogus/model"), null);
    });
  });

  describe("containerName", () => {
    it("prefixes with nemoclaw-nim-", () => {
      assert.equal(nim.containerName("my-sandbox"), "nemoclaw-nim-my-sandbox");
    });
  });

  describe("detectGpu", () => {
    it("returns object or null", () => {
      const gpu = nim.detectGpu();
      if (gpu !== null) {
        assert.ok(gpu.type, "gpu should have type");
        assert.ok(typeof gpu.count === "number", "count should be number");
        assert.ok(typeof gpu.totalMemoryMB === "number", "totalMemoryMB should be number");
        assert.ok(typeof gpu.nimCapable === "boolean", "nimCapable should be boolean");
      }
    });

    it("nvidia (discrete) type is nimCapable", { skip: !isDiscreteNvidia }, () => {
      assert.equal(detectedGpu.nimCapable, true);
    });

    it("nvidia (jetson) type is not nimCapable", { skip: !isJetson }, () => {
      assert.equal(detectedGpu.nimCapable, false);
      assert.ok(detectedGpu.name, "jetson gpu should have name");
      assert.ok(detectedGpu.jetson === true, "jetson flag should be true");
      assert.ok(detectedGpu.totalMemoryMB > 0, "should report unified memory");
    });

    it("apple type is not nimCapable", { skip: !isApple }, () => {
      assert.equal(detectedGpu.nimCapable, false);
      assert.ok(detectedGpu.name, "apple gpu should have name");
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      assert.equal(st.running, false);
    });
  });
});
