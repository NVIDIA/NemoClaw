// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";

// Import from compiled dist/ for coverage attribution.
import * as nim from "../../dist/lib/nim";

const require = createRequire(import.meta.url);
const NIM_DIST_PATH = require.resolve("../../dist/lib/nim");
const RUNNER_PATH = require.resolve("../../dist/lib/runner");

function loadNimWithMockedRunner(runCapture: Mock) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;

  delete require.cache[NIM_DIST_PATH];
  runner.run = vi.fn();
  runner.runCapture = runCapture;
  const nimModule = require(NIM_DIST_PATH);

  return {
    nimModule,
    restore() {
      delete require.cache[NIM_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
    },
  };
}

/** Check if an argv array or legacy shell command contains a specific argument. */
function hasArg(cmd: string | string[], arg: string): boolean {
  return Array.isArray(cmd) ? cmd.includes(arg) : cmd.includes(arg);
}

function hasCurlTimeoutArgs(cmd: string | string[]): boolean {
  if (!Array.isArray(cmd)) {
    return (
      cmd.includes("curl") &&
      cmd.includes("--connect-timeout 5") &&
      cmd.includes("--max-time 5")
    );
  }
  const connectTimeout = cmd.indexOf("--connect-timeout");
  const maxTime = cmd.indexOf("--max-time");
  return cmd[0] === "curl" && cmd[connectTimeout + 1] === "5" && cmd[maxTime + 1] === "5";
}

function timeoutForCommand(
  runCapture: Mock,
  predicate: (cmd: string | string[]) => boolean,
): number | undefined {
  const call = runCapture.mock.calls.find((mockCall) => {
    const cmd = mockCall[0] as string | string[];
    return predicate(cmd);
  });
  return (call?.[1] as { timeout?: number } | undefined)?.timeout;
}

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
      expect(nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b")).toBe(
        "nvcr.io/nim/nvidia/nemotron-3-nano:latest",
      );
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

    it("populates name and memory from primary nvidia-smi path", () => {
      // Primary path returns name+memory.total in a single CSV line per GPU.
      // Regression guard for #2669: the GB300 preflight line was missing the
      // GPU model because only memory.total was being queried.
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA GB300, 284208\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA GB300",
          count: 1,
          totalMemoryMB: 284208,
          perGpuMB: 284208,
        });
      } finally {
        restore();
      }
    });

    it("aggregates totalMemoryMB across multiple GPUs from primary path", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA H100 80GB HBM3, 81920\nNVIDIA H100 80GB HBM3, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA H100 80GB HBM3",
          count: 2,
          totalMemoryMB: 163840,
          perGpuMB: 81920,
        });
      } finally {
        restore();
      }
    });

    it("preserves commas inside the GPU model name (last-comma split)", () => {
      // The CSV split must use the LAST comma, not the first, so that GPU
      // models whose names contain a comma round-trip intact. The split was
      // designed for this; the test guards against future "split on first
      // comma" regressions.
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA RTX A,B, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA RTX A,B",
          count: 1,
          totalMemoryMB: 81920,
          perGpuMB: 81920,
        });
      } finally {
        restore();
      }
    });

    it("drops name on mixed-model multi-GPU hosts so we don't attribute one model to the others", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (
          cmd[0] === "nvidia-smi" &&
          cmd.some((a: string) => a.includes("name,memory.total"))
        ) {
          return "NVIDIA H100 80GB HBM3, 81920\nNVIDIA A100-SXM4-80GB, 81920\n";
        }
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const result = nimModule.detectGpu();
        expect(result).toMatchObject({
          type: "nvidia",
          count: 2,
          totalMemoryMB: 163840,
        });
        // Mixed-model hosts must not pin a single name; the preflight line
        // would otherwise read "2x NVIDIA H100" on a host that's actually
        // half H100 and half A100.
        expect(result?.name).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("detects GB10 unified-memory GPUs as Spark-capable NVIDIA devices", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) return "NVIDIA GB10";
        if (cmd[0] === "free" && cmd[1] === "-m") return "              total        used        free      shared  buff/cache   available\nMem:         131072       10240       90000        1024       30832      119808\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA GB10",
          count: 1,
          totalMemoryMB: 131072,
          perGpuMB: 131072,
          nimCapable: true,
          unifiedMemory: true,
          spark: true,
        });
      } finally {
        restore();
      }
    });

    it("detects Orin unified-memory GPUs without marking them as Spark", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) return "NVIDIA Jetson AGX Orin";
        if (cmd[0] === "free" && cmd[1] === "-m") return "              total        used        free      shared  buff/cache   available\nMem:          32768        5120       20000         512       7148       27136\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA Jetson AGX Orin",
          count: 1,
          totalMemoryMB: 32768,
          perGpuMB: 32768,
          nimCapable: true,
          unifiedMemory: true,
          spark: false,
        });
      } finally {
        restore();
      }
    });

    it("marks low-memory unified-memory NVIDIA devices as not NIM-capable", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd.some((a: string) => a.includes("memory.total"))) return "";
        if (cmd.some((a: string) => a.includes("query-gpu=name"))) return "NVIDIA Xavier";
        if (cmd[0] === "free" && cmd[1] === "-m") return "              total        used        free      shared  buff/cache   available\nMem:           4096        1024        2048         256       1024        2816\nSwap:             0           0           0";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          name: "NVIDIA Xavier",
          totalMemoryMB: 4096,
          nimCapable: false,
          unifiedMemory: true,
          spark: false,
        });
      } finally {
        restore();
      }
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      expect(st.running).toBe(false);
    });
  });

  describe("waitForNimHealth", () => {
    it("bounds curl health probes with connect and total timeouts", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:9000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        expect(nimModule.waitForNimHealth(9000, 1)).toBe(true);
        const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

        expect(commands.some((c) => c[0] === "curl" && hasCurlTimeoutArgs(c))).toBe(true);
      } finally {
        restore();
      }
    });
  });

  describe("nimStatusByName", () => {
    it("uses provided port directly", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "docker" && cmd.includes("inspect")) return "running";
        if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:9000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo", 9000);
        const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

        expect(st).toMatchObject({
          running: true,
          healthy: true,
          container: "foo",
          state: "running",
        });
        expect(commands.some((c) => c[0] === "docker" && c.includes("port"))).toBe(false);
        expect(commands.some((c) => c.includes("http://127.0.0.1:9000/v1/models"))).toBe(
          true,
        );
        expect(commands.some((c) => c[0] === "curl" && hasCurlTimeoutArgs(c))).toBe(true);
        expect(
          timeoutForCommand(
            runCapture,
            (c) => Array.isArray(c) && c[0] === "docker" && c.includes("inspect"),
          ),
        ).toBe(5000);
        expect(
          timeoutForCommand(
            runCapture,
            (c) => Array.isArray(c) && c[0] === "curl" && c.includes("http://127.0.0.1:9000/v1/models"),
          ),
        ).toBe(6000);
      } finally {
        restore();
      }
    });

    it("uses published docker port when no port is provided", () => {
      for (const mapping of ["0.0.0.0:9000", "127.0.0.1:9000", "[::]:9000", ":::9000"]) {
        const runCapture = vi.fn((cmd: string | string[]) => {
          if (!Array.isArray(cmd)) throw new Error("expected argv array");
          if (cmd[0] === "docker" && cmd.includes("inspect")) return "running";
          if (cmd[0] === "docker" && cmd.includes("port")) return mapping;
          if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:9000/v1/models")) return '{"data":[]}';
          return "";
        });
        const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

        try {
          const st = nimModule.nimStatusByName("foo");
          const commands = runCapture.mock.calls.map(([c]: [string | string[]]) => c);

          expect(st).toMatchObject({ running: true, healthy: true, container: "foo", state: "running" });
          expect(commands.some((c) => c[0] === "docker" && c.includes("port"))).toBe(true);
          expect(
            timeoutForCommand(
              runCapture,
              (c) => Array.isArray(c) && c[0] === "docker" && c.includes("inspect"),
            ),
          ).toBe(5000);
          expect(
            timeoutForCommand(
              runCapture,
              (c) => Array.isArray(c) && c[0] === "docker" && c.includes("port"),
            ),
          ).toBe(5000);
        } finally {
          restore();
        }
      }
    });

    it("falls back to 8000 when docker port lookup fails", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "docker" && cmd.includes("inspect")) return "running";
        if (cmd[0] === "docker" && cmd.includes("port")) return "";
        if (cmd[0] === "curl" && hasArg(cmd, "http://127.0.0.1:8000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        expect(st).toMatchObject({ running: true, healthy: true, container: "foo", state: "running" });
      } finally {
        restore();
      }
    });

    it("does not run health check when container is not running", () => {
      const runCapture = vi.fn((cmd: string | string[]) => {
        if (!Array.isArray(cmd)) throw new Error("expected argv array");
        if (cmd[0] === "docker" && cmd.includes("inspect")) return "exited";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        expect(st).toMatchObject({ running: false, healthy: false, container: "foo", state: "exited" });
        expect(
          timeoutForCommand(
            runCapture,
            (c) => Array.isArray(c) && c[0] === "docker" && c.includes("inspect"),
          ),
        ).toBe(5000);
        expect(runCapture.mock.calls).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });

  describe("shouldShowNimLine", () => {
    it("hides the line for cloud-only sandboxes (no container, nothing running)", () => {
      expect(nim.shouldShowNimLine(null, false)).toBe(false);
      expect(nim.shouldShowNimLine(undefined, false)).toBe(false);
      expect(nim.shouldShowNimLine("", false)).toBe(false);
    });

    it("shows the line when the sandbox is bound to a NIM container", () => {
      expect(nim.shouldShowNimLine("nim-foo", false)).toBe(true);
      expect(nim.shouldShowNimLine("nim-foo", true)).toBe(true);
    });

    it("still surfaces an orphan NIM container even when none is registered", () => {
      expect(nim.shouldShowNimLine(null, true)).toBe(true);
      expect(nim.shouldShowNimLine(undefined, true)).toBe(true);
    });
  });

  describe("isNgcLoggedIn", () => {
    const fs = require("fs");
    const os = require("os");

    function mockDockerConfig(config: string | null) {
      const origReadFileSync = fs.readFileSync;
      const origHomedir = os.homedir;
      os.homedir = () => "/mock-home";
      if (config === null) {
        fs.readFileSync = () => { throw new Error("ENOENT"); };
      } else {
        fs.readFileSync = (p: string, ...args: unknown[]) => {
          if (typeof p === "string" && p.includes(".docker/config.json")) return config;
          return origReadFileSync(p, ...args);
        };
      }
      return () => {
        fs.readFileSync = origReadFileSync;
        os.homedir = origHomedir;
      };
    }

    it("returns true when credHelpers has nvcr.io", () => {
      const restore = mockDockerConfig(JSON.stringify({ credHelpers: { "nvcr.io": "secretservice" } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns true when auths has nvcr.io with auth field", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: { "nvcr.io": { auth: "dXNlcjpwYXNz" } } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns true when auths has https://nvcr.io with auth field", () => {
      const restore = mockDockerConfig(
        JSON.stringify({ auths: { "https://nvcr.io": { auth: "dXNlcjpwYXNz" } } }),
      );
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns false when auths has nvcr.io but empty entry", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: { "nvcr.io": {} } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when config file is missing", () => {
      const restore = mockDockerConfig(null);
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when config has malformed JSON", () => {
      const restore = mockDockerConfig("not json");
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when auths is empty and no credHelpers", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: {} }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns true when empty nvcr.io marker exists and credsStore is set (Docker Desktop)", () => {
      const restore = mockDockerConfig(
        JSON.stringify({ credsStore: "desktop", auths: { "nvcr.io": {} } }),
      );
      try {
        expect(nim.isNgcLoggedIn()).toBe(true);
      } finally {
        restore();
      }
    });

    it("returns false when credsStore is set but no nvcr.io marker (not logged in)", () => {
      const restore = mockDockerConfig(
        JSON.stringify({ credsStore: "desktop", auths: {} }),
      );
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });

    it("returns false when empty nvcr.io marker exists but no credsStore", () => {
      const restore = mockDockerConfig(JSON.stringify({ auths: { "nvcr.io": {} } }));
      try {
        expect(nim.isNgcLoggedIn()).toBe(false);
      } finally {
        restore();
      }
    });
  });
});
