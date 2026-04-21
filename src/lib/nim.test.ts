// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";

// Import from compiled dist/ for coverage attribution.
import nim from "../../dist/lib/nim";

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
        expect(runCapture.mock.calls).toHaveLength(1);
      } finally {
        restore();
      }
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
