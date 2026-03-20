// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const nim = require("../bin/lib/nim");
const { shellQuote } = require("../bin/lib/runner");

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

  describe("NGC_API_KEY escaping", () => {
    it("single-quotes a normal API key", () => {
      const key = "nvapi-abc123DEF456";
      const envFlags = key ? `-e NGC_API_KEY=${shellQuote(key)}` : "";
      assert.equal(envFlags, "-e NGC_API_KEY='nvapi-abc123DEF456'");
    });

    it("escapes embedded single quotes in key", () => {
      const key = "key'with'quotes";
      const envFlags = `-e NGC_API_KEY=${shellQuote(key)}`;
      assert.equal(envFlags, "-e NGC_API_KEY='key'\\''with'\\''quotes'");
    });

    it("produces empty string for empty key", () => {
      const key = "";
      const envFlags = key ? `-e NGC_API_KEY=${shellQuote(key)}` : "";
      assert.equal(envFlags, "");
    });

    it("blocks shell metacharacters via single quotes", () => {
      const key = '$(whoami)"; rm -rf /; echo "';
      const envFlags = `-e NGC_API_KEY=${shellQuote(key)}`;
      assert.ok(envFlags.startsWith("-e NGC_API_KEY='"));
      assert.ok(envFlags.endsWith("'"));
    });

    it("prefers NGC_API_KEY over NVIDIA_API_KEY in fallback", () => {
      const origNgc = process.env.NGC_API_KEY;
      const origNvidia = process.env.NVIDIA_API_KEY;
      try {
        process.env.NGC_API_KEY = "ngc-primary";
        process.env.NVIDIA_API_KEY = "nvidia-fallback";
        const ngcKey = process.env.NGC_API_KEY || process.env.NVIDIA_API_KEY || "";
        assert.equal(ngcKey, "ngc-primary");
      } finally {
        if (origNgc === undefined) delete process.env.NGC_API_KEY;
        else process.env.NGC_API_KEY = origNgc;
        if (origNvidia === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = origNvidia;
      }
    });

    it("falls back to NVIDIA_API_KEY when NGC_API_KEY empty", () => {
      const origNgc = process.env.NGC_API_KEY;
      const origNvidia = process.env.NVIDIA_API_KEY;
      try {
        process.env.NGC_API_KEY = "";
        process.env.NVIDIA_API_KEY = "nvidia-fallback";
        const ngcKey = process.env.NGC_API_KEY || process.env.NVIDIA_API_KEY || "";
        assert.equal(ngcKey, "nvidia-fallback");
      } finally {
        if (origNgc === undefined) delete process.env.NGC_API_KEY;
        else process.env.NGC_API_KEY = origNgc;
        if (origNvidia === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = origNvidia;
      }
    });
  });

  describe("shellQuote (shared helper)", () => {
    it("wraps a simple value in single quotes", () => {
      assert.equal(shellQuote("hello"), "'hello'");
    });

    it("escapes embedded single quotes", () => {
      assert.equal(shellQuote("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellQuote(""), "''");
    });

    it("neutralizes shell metacharacters", () => {
      const result = shellQuote('$(whoami); rm -rf /');
      assert.ok(result.startsWith("'"));
      assert.ok(result.endsWith("'"));
      assert.ok(result.includes("$(whoami)"));
    });

    it("coerces non-string values", () => {
      assert.equal(shellQuote(12345), "'12345'");
      assert.equal(shellQuote(null), "'null'");
    });
  });
});
