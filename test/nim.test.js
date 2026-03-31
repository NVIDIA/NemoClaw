// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import { describe, it, expect, vi } from "vitest";
import nim from "../bin/lib/nim";

const require = createRequire(import.meta.url);
const NIM_PATH = require.resolve("../bin/lib/nim");
const RUNNER_PATH = require.resolve("../bin/lib/runner");

function loadNimWithMockedRunner(runCapture) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;

  delete require.cache[NIM_PATH];
  runner.run = vi.fn();
  runner.runCapture = runCapture;
  const nimModule = require(NIM_PATH);

  return {
    nimModule,
    restore() {
      delete require.cache[NIM_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
    },
  };
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
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      expect(st.running).toBe(false);
    });
  });

  describe("nimStatusByName", () => {
    it("uses provided port directly", () => {
      const runCapture = vi.fn((cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("http://localhost:9000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo", 9000);
        const commands = runCapture.mock.calls.map(([cmd]) => cmd);

        expect(st).toMatchObject({
          running: true,
          healthy: true,
          container: "foo",
          state: "running",
        });
        expect(commands.some((cmd) => cmd.includes("docker port"))).toBe(false);
        expect(commands.some((cmd) => cmd.includes("http://localhost:9000/v1/models"))).toBe(true);
      } finally {
        restore();
      }
    });

    it("uses published docker port when no port is provided", () => {
      for (const mapping of ["0.0.0.0:9000", "127.0.0.1:9000", "[::]:9000", ":::9000"]) {
        const runCapture = vi.fn((cmd) => {
          if (cmd.includes("docker inspect")) return "running";
          if (cmd.includes("docker port")) return mapping;
          if (cmd.includes("http://localhost:9000/v1/models")) return '{"data":[]}';
          return "";
        });
        const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

        try {
          const st = nimModule.nimStatusByName("foo");
          const commands = runCapture.mock.calls.map(([cmd]) => cmd);

          expect(st).toMatchObject({
            running: true,
            healthy: true,
            container: "foo",
            state: "running",
          });
          expect(commands.some((cmd) => cmd.includes("docker port"))).toBe(true);
          expect(commands.some((cmd) => cmd.includes("http://localhost:9000/v1/models"))).toBe(
            true,
          );
        } finally {
          restore();
        }
      }
    });

    it("falls back to 8000 when docker port lookup fails", () => {
      const runCapture = vi.fn((cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("docker port")) return "";
        if (cmd.includes("http://localhost:8000/v1/models")) return '{"data":[]}';
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        const commands = runCapture.mock.calls.map(([cmd]) => cmd);

        expect(st).toMatchObject({
          running: true,
          healthy: true,
          container: "foo",
          state: "running",
        });
        expect(commands.some((cmd) => cmd.includes("docker port"))).toBe(true);
        expect(commands.some((cmd) => cmd.includes("http://localhost:8000/v1/models"))).toBe(true);
      } finally {
        restore();
      }
    });

    it("does not run health check when container is not running", () => {
      const runCapture = vi.fn((cmd) => {
        if (cmd.includes("docker inspect")) return "exited";
        return "";
      });
      const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

      try {
        const st = nimModule.nimStatusByName("foo");
        const commands = runCapture.mock.calls.map(([cmd]) => cmd);

        expect(st).toMatchObject({
          running: false,
          healthy: false,
          container: "foo",
          state: "exited",
        });
        expect(commands).toHaveLength(1);
        expect(commands.some((cmd) => cmd.includes("docker port"))).toBe(false);
        expect(commands.some((cmd) => cmd.includes("http://localhost:"))).toBe(false);
      } finally {
        restore();
      }
    });
  });
});
