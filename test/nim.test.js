// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const nim = require("../bin/lib/nim");

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

    it("nvidia type is nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "nvidia") {
        assert.equal(gpu.nimCapable, true);
      }
    });

    it("apple type is not nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "apple") {
        assert.equal(gpu.nimCapable, false);
        assert.ok(gpu.name, "apple gpu should have name");
      }
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      assert.equal(st.running, false);
    });
  });

  describe("detectGpu (injected)", () => {
    function mockRunCapture(responses) {
      return function (cmd) {
        for (const [pattern, response] of responses) {
          if (cmd.includes(pattern)) {
            if (response instanceof Error) throw response;
            return response;
          }
        }
        throw new Error("mock: no match for " + cmd);
      };
    }

    it("detects standard NVIDIA GPU", () => {
      const gpu = nim.detectGpu({
        runCapture: mockRunCapture([
          ["memory.total", "8192"],
        ]),
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.count, 1);
      assert.equal(gpu.totalMemoryMB, 8192);
      assert.equal(gpu.perGpuMB, 8192);
      assert.equal(gpu.nimCapable, true);
      assert.equal(gpu.spark, undefined);
    });

    it("detects multiple NVIDIA GPUs", () => {
      const gpu = nim.detectGpu({
        runCapture: mockRunCapture([
          ["memory.total", "8192\n8192"],
        ]),
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.count, 2);
      assert.equal(gpu.totalMemoryMB, 16384);
      assert.equal(gpu.perGpuMB, 8192);
    });

    it("detects DGX Spark GB10", () => {
      const gpu = nim.detectGpu({
        runCapture: mockRunCapture([
          ["memory.total", ""],
          ["name", "NVIDIA GB10"],
          ["free -m", "122880"],
        ]),
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.name, "NVIDIA GB10");
      assert.equal(gpu.spark, true);
      assert.equal(gpu.count, 1);
      assert.equal(gpu.totalMemoryMB, 122880);
    });

    it("handles Spark with free -m failure", () => {
      const gpu = nim.detectGpu({
        runCapture: mockRunCapture([
          ["memory.total", ""],
          ["name", "NVIDIA GB10"],
          ["free -m", new Error("command failed")],
        ]),
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.spark, true);
      assert.equal(gpu.totalMemoryMB, 0);
    });

    it("detects macOS discrete GPU via VRAM", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: mockRunCapture([
          ["memory.total", new Error("no nvidia-smi")],
          ["name", new Error("no nvidia-smi")],
          ["system_profiler", "Chipset Model: Apple M2 Pro\n      VRAM (Total): 16 GB\n      Total Number of Cores: 19"],
        ]),
      });
      assert.equal(gpu.type, "apple");
      assert.equal(gpu.name, "Apple M2 Pro");
      assert.equal(gpu.nimCapable, false);
      assert.equal(gpu.totalMemoryMB, 16384);
      assert.equal(gpu.cores, 19);
    });

    it("detects Apple Silicon with unified memory", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: mockRunCapture([
          ["memory.total", new Error("no nvidia-smi")],
          ["query-gpu=name", new Error("no nvidia-smi")],
          ["system_profiler", "Chipset Model: Apple M4\n      Total Number of Cores: 10"],
          ["hw.memsize", "17179869184"],
        ]),
      });
      assert.equal(gpu.type, "apple");
      assert.equal(gpu.name, "Apple M4");
      assert.equal(gpu.nimCapable, false);
      assert.equal(gpu.totalMemoryMB, 16384);
      assert.equal(gpu.cores, 10);
    });

    it("returns null when no GPU detected", () => {
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: mockRunCapture([
          ["memory.total", new Error("no nvidia-smi")],
          ["name", new Error("no nvidia-smi")],
        ]),
      });
      assert.equal(gpu, null);
    });

    it("non-GB10 NVIDIA has no spark property", () => {
      const gpu = nim.detectGpu({
        runCapture: mockRunCapture([
          ["memory.total", "24576"],
        ]),
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.spark, undefined);
    });
  });

  describe("suggestModelsForGpu", () => {
    it("returns empty for null GPU", () => {
      assert.deepEqual(nim.suggestModelsForGpu(null), []);
    });

    it("returns empty for non-nimCapable GPU", () => {
      assert.deepEqual(nim.suggestModelsForGpu({ totalMemoryMB: 16384, nimCapable: false }), []);
    });

    it("filters models that exceed VRAM", () => {
      const models = nim.suggestModelsForGpu({ totalMemoryMB: 8000, nimCapable: true });
      for (const m of models) {
        assert.ok(m.minGpuMemoryMB <= 8000, `${m.name} requires ${m.minGpuMemoryMB} MB`);
      }
    });

    it("sorts by VRAM descending", () => {
      const models = nim.suggestModelsForGpu({ totalMemoryMB: 200000, nimCapable: true });
      for (let i = 1; i < models.length; i++) {
        assert.ok(models[i - 1].minGpuMemoryMB >= models[i].minGpuMemoryMB,
          "models should be sorted by VRAM descending");
      }
    });

    it("marks exactly one model as recommended", () => {
      const models = nim.suggestModelsForGpu({ totalMemoryMB: 200000, nimCapable: true });
      const recommended = models.filter((m) => m.recommended);
      assert.equal(recommended.length, 1, "exactly one model should be recommended");
    });

    it("recommended model fits within 90% VRAM", () => {
      const vram = 32000;
      const models = nim.suggestModelsForGpu({ totalMemoryMB: vram, nimCapable: true });
      const rec = models.find((m) => m.recommended);
      if (rec) {
        assert.ok(rec.minGpuMemoryMB <= vram * 0.9,
          `recommended model (${rec.minGpuMemoryMB} MB) should fit within 90% of ${vram} MB`);
      }
    });

    it("each entry has recommended boolean", () => {
      const models = nim.suggestModelsForGpu({ totalMemoryMB: 200000, nimCapable: true });
      for (const m of models) {
        assert.equal(typeof m.recommended, "boolean");
      }
    });
  });
});
