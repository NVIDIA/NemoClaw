// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runner = require("../bin/lib/runner");
const nim    = require("../bin/lib/nim");

const _originalRunCapture = runner.runCapture;
afterEach(() => {
  runner.runCapture = _originalRunCapture;
  vi.restoreAllMocks();
});

describe("nim", () => {
  describe("listModels", () => {
    it("returns 5 models", () => {
      expect(nim.listModels().length).toBe(5);
    });

    it("each model has name, image, and minGpuMemoryMB", () => {
      for (const m of nim.listModels()) {
        expect(m.name).toBeTruthy();
        expect(m.image).toBeTruthy();
        expect(typeof m.minGpuMemoryMB === "number").toBeTruthy();
        expect(m.minGpuMemoryMB > 0).toBeTruthy();
      }
    });
  });

  describe("getImageForModel", () => {
    it("returns correct image for known model", () => {
      expect(nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe("nvcr.io/nim/nvidia/nemotron-3-nano:latest");
    });

    it("returns null for unknown model", () => {
      expect(nim.getImageForModel("bogus/model")).toBe(null);
    });
  });

  describe("containerName", () => {
    it("prefixes with nemoclaw-nim-", () => {
      expect(nim.containerName("my-sandbox")).toBe("nemoclaw-nim-my-sandbox");
    });
  });

  describe("detectGpu", () => {
    it("returns object or null", () => {
      const gpu = nim.detectGpu();
      if (gpu !== null) {
        expect(gpu.type).toBeTruthy();
        expect(typeof gpu.count === "number").toBeTruthy();
        expect(typeof gpu.totalMemoryMB === "number").toBeTruthy();
        expect(typeof gpu.nimCapable === "boolean").toBeTruthy();
      }
    });

    it("nvidia type is nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "nvidia") {
        expect(gpu.nimCapable).toBe(true);
      }
    });

    it("apple type is not nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "apple") {
        expect(gpu.nimCapable).toBe(false);
        expect(gpu.name).toBeTruthy();
      }
    });
  });

  describe("detectGpu unified-memory fallback", () => {
    /** Build a runCapture mock where VRAM query returns [N/A] and GPU name returns `name`. */
    function mockUnifiedMemoryGpu(name, systemMemMB = "65536") {
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("--query-gpu=memory.total")) return "[N/A]";
        if (cmd.includes("--query-gpu=name"))         return name;
        if (cmd.includes("free -m"))                  return systemMemMB;
        return "";
      });
    }

    it("detects DGX Spark (GB10) via unified-memory fallback", () => {
      mockUnifiedMemoryGpu("NVIDIA Graphics Device GB10");
      const gpu = nim.detectGpu();
      expect(gpu).not.toBeNull();
      expect(gpu.type).toBe("nvidia");
      expect(gpu.nimCapable).toBe(true);
      expect(gpu.spark).toBe(true);
      expect(gpu.totalMemoryMB).toBe(65536);
    });

    it("detects Jetson AGX Thor via unified-memory fallback", () => {
      mockUnifiedMemoryGpu("Jetson AGX Thor");
      const gpu = nim.detectGpu();
      expect(gpu).not.toBeNull();
      expect(gpu.type).toBe("nvidia");
      expect(gpu.nimCapable).toBe(true);
      expect(gpu.spark).toBe(true);
    });

    it("detects Jetson AGX Orin via unified-memory fallback", () => {
      mockUnifiedMemoryGpu("Jetson AGX Orin");
      const gpu = nim.detectGpu();
      expect(gpu).not.toBeNull();
      expect(gpu.type).toBe("nvidia");
      expect(gpu.nimCapable).toBe(true);
      expect(gpu.spark).toBe(true);
    });

    it("does not trigger fallback for desktop GPU names", () => {
      // Desktop GPUs return valid VRAM, but even if VRAM were [N/A],
      // the name must not match any unified-memory tag.
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("--query-gpu=memory.total")) return "[N/A]";
        if (cmd.includes("--query-gpu=name"))         return "NVIDIA GeForce RTX 4090";
        return "";
      });
      const gpu = nim.detectGpu();
      // Should NOT match as a unified-memory device
      if (gpu) {
        expect(gpu.spark).toBeUndefined();
      }
    });

    it("skips fallback when VRAM is queryable", () => {
      runner.runCapture = vi.fn().mockImplementation((cmd) => {
        if (cmd.includes("--query-gpu=memory.total")) return "24564";
        if (cmd.includes("--query-gpu=name"))         return "NVIDIA GeForce RTX 4090";
        return "";
      });
      const gpu = nim.detectGpu();
      expect(gpu).not.toBeNull();
      expect(gpu.type).toBe("nvidia");
      expect(gpu.totalMemoryMB).toBe(24564);
      expect(gpu.spark).toBeUndefined();
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      expect(st.running).toBe(false);
    });
  });
});
