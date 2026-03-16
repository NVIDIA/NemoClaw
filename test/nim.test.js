// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, before, after } = require("node:test");
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

  describe("nimStatus (stubbed runner + registry)", () => {
    let nimStubbed;
    let captureImpl;
    const runnerPath = require.resolve("../bin/lib/runner");
    const registryPath = require.resolve("../bin/lib/registry");
    const nimPath = require.resolve("../bin/lib/nim");
    let savedRunner;
    let savedRegistry;
    let savedNim;

    before(() => {
      savedRunner = require.cache[runnerPath];
      savedRegistry = require.cache[registryPath];
      savedNim = require.cache[nimPath];

      // Inject mock runner — captureImpl is a shared variable so tests can swap it
      require.cache[runnerPath] = {
        id: runnerPath,
        filename: runnerPath,
        loaded: true,
        exports: {
          run: () => {},
          runCapture: (...args) => (captureImpl ? captureImpl(...args) : null),
          ROOT: "",
          SCRIPTS: "",
        },
      };

      // Inject mock registry — default: nimPort 9000
      require.cache[registryPath] = {
        id: registryPath,
        filename: registryPath,
        loaded: true,
        exports: {
          getSandbox: () => ({ nimPort: 9000 }),
        },
      };

      // Force nim.js to reload and destructure from our mocked runner
      delete require.cache[nimPath];
      nimStubbed = require("../bin/lib/nim");
    });

    after(() => {
      require.cache[runnerPath] = savedRunner;
      require.cache[registryPath] = savedRegistry;
      // Restore original nim so other test suites are unaffected
      delete require.cache[nimPath];
      if (savedNim) require.cache[nimPath] = savedNim;
    });

    it("returns running+healthy when container running and health check succeeds on port 9000", () => {
      captureImpl = (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) return '{"data":[]}';
        return null;
      };

      const st = nimStubbed.nimStatus("test-sandbox");
      assert.equal(st.running, true);
      assert.equal(st.healthy, true);
    });

    it("health check URL uses port from registry (port 9000)", () => {
      let curlCmd = null;
      captureImpl = (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) {
          curlCmd = cmd;
          return '{"data":[]}';
        }
        return null;
      };

      nimStubbed.nimStatus("test-sandbox");
      assert.ok(curlCmd, "curl should have been called");
      assert.ok(curlCmd.includes(":9000/"), `Expected :9000/ in curl URL, got: ${curlCmd}`);
    });

    it("defaults to port 8000 when no nimPort stored in registry (backwards compat)", () => {
      // Override getSandbox to simulate no stored port
      require.cache[registryPath].exports.getSandbox = () => null;

      let curlCmd = null;
      captureImpl = (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) {
          curlCmd = cmd;
          return '{"data":[]}';
        }
        return null;
      };

      const st = nimStubbed.nimStatus("test-sandbox");
      assert.equal(st.running, true);
      assert.equal(st.healthy, true);
      assert.ok(curlCmd && curlCmd.includes(":8000/"), `Expected :8000/ in curl URL, got: ${curlCmd}`);

      // Restore default getSandbox for subsequent tests
      require.cache[registryPath].exports.getSandbox = () => ({ nimPort: 9000 });
    });
  });
});
