// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const nim = require("../bin/lib/nim");

function withMockedRunner({ runResult, runCaptureResults = [] }, callback) {
  const nimPath = require.resolve("../bin/lib/nim");
  const runnerPath = require.resolve("../bin/lib/runner");
  const savedNim = require.cache[nimPath];
  const savedRunner = require.cache[runnerPath];
  const childProcess = require("node:child_process");
  const savedSpawnSync = childProcess.spawnSync;
  const calls = { run: [], runCapture: [], spawnSync: [] };

  require.cache[runnerPath] = {
    id: runnerPath,
    filename: runnerPath,
    loaded: true,
    exports: {
      run(command, options) {
        calls.run.push({ command, options });
        return runResult;
      },
      runCapture(command, options) {
        calls.runCapture.push({ command, options });
        return runCaptureResults.shift() ?? "";
      },
    },
  };
  delete require.cache[nimPath];
  childProcess.spawnSync = (...args) => {
    calls.spawnSync.push(args);
    return { status: 0 };
  };

  try {
    callback(require("../bin/lib/nim"), calls);
  } finally {
    delete require.cache[nimPath];
    if (savedNim) {
      require.cache[nimPath] = savedNim;
    }
    if (savedRunner) {
      require.cache[runnerPath] = savedRunner;
    } else {
      delete require.cache[runnerPath];
    }
    childProcess.spawnSync = savedSpawnSync;
  }
}

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

    it("probes health with a connect timeout and quoted container name", () => {
      withMockedRunner(
        {
          runCaptureResults: ["/usr/bin/docker", "running", '{"data":[]}'],
        },
        (mockedNim, calls) => {
          const st = mockedNim.nimStatus("my-sandbox");
          assert.equal(st.running, true);
          assert.equal(st.healthy, true);
          assert.equal(
            calls.runCapture[1].command,
            `docker inspect --format '{{.State.Status}}' "nemoclaw-nim-my-sandbox" 2>/dev/null`,
          );
          assert.equal(
            calls.runCapture[2].command,
            "curl -sf --connect-timeout 5 http://localhost:8000/v1/models 2>/dev/null",
          );
        },
      );
    });
  });

  describe("shell command construction", () => {
    it("quotes docker image pulls", () => {
      withMockedRunner({}, (mockedNim, calls) => {
        mockedNim.pullNimImage("nvidia/nemotron-3-nano-30b-a3b");
        assert.equal(
          calls.run[0].command,
          'docker pull "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"',
        );
      });
    });

    it("quotes docker run and cleanup commands", () => {
      withMockedRunner({}, (mockedNim, calls) => {
        mockedNim.startNimContainer("my-sandbox", "nvidia/nemotron-3-nano-30b-a3b", 9000);
        mockedNim.stopNimContainer("my-sandbox");

        assert.equal(
          calls.run[0].command,
          'docker rm -f "nemoclaw-nim-my-sandbox" 2>/dev/null || true',
        );
        assert.equal(
          calls.run[1].command,
          'docker run -d --gpus all -p 9000:8000 --name "nemoclaw-nim-my-sandbox" --shm-size 16g "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"',
        );
        assert.equal(
          calls.run[2].command,
          'docker stop "nemoclaw-nim-my-sandbox" 2>/dev/null || true',
        );
        assert.equal(
          calls.run[3].command,
          'docker rm "nemoclaw-nim-my-sandbox" 2>/dev/null || true',
        );
      });
    });
  });

  describe("waitForNimHealth", () => {
    it("uses curl connect timeout for readiness probes", () => {
      withMockedRunner({ runCaptureResults: ['{"data":[]}'] }, (mockedNim, calls) => {
        assert.equal(mockedNim.waitForNimHealth(9000, 1), true);
        assert.equal(
          calls.runCapture[0].command,
          "curl -sf --connect-timeout 5 http://localhost:9000/v1/models",
        );
        assert.equal(calls.spawnSync.length, 0);
      });
    });
  });
});
