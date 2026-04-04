// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function run(args, home) {
  try {
    const out = execSync(`${JSON.stringify(process.execPath)} "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: home },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("--json output", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-json-test-"));
    const nemoclawDir = path.join(tmpHome, ".nemoclaw");
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "my-assistant",
        sandboxes: {
          "my-assistant": {
            name: "my-assistant",
            createdAt: "2026-04-04T00:00:00.000Z",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-nim",
            gpuEnabled: false,
            policies: ["pypi", "npm"],
          },
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("list --json", () => {
    it("outputs valid JSON with sandbox array", () => {
      const r = run("list --json", tmpHome);
      expect(r.code).toBe(0);
      const data = JSON.parse(r.out);
      expect(data.sandboxes).toBeInstanceOf(Array);
      expect(data.sandboxes).toHaveLength(1);
      expect(data.sandboxes[0]).toMatchObject({
        name: "my-assistant",
        default: true,
        model: "nvidia/nemotron-3-super-120b-a12b",
        provider: "nvidia-nim",
        gpuEnabled: false,
        policies: ["pypi", "npm"],
      });
      expect(data.defaultSandbox).toBe("my-assistant");
    });

    it("outputs empty array when no sandboxes", () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-json-empty-"));
      try {
        const r = run("list --json", emptyHome);
        expect(r.code).toBe(0);
        const data = JSON.parse(r.out);
        expect(data.sandboxes).toEqual([]);
      } finally {
        fs.rmSync(emptyHome, { recursive: true, force: true });
      }
    });

    // Note: `list` without --json requires a live OpenShell gateway for
    // registry recovery, so it cannot be tested without the full runtime.
  });

  describe("<name> status --json", () => {
    it("outputs valid JSON with sandbox details", () => {
      const r = run("my-assistant status --json", tmpHome);
      expect(r.code).toBe(0);
      const data = JSON.parse(r.out);
      expect(data.name).toBe("my-assistant");
      expect(data.model).toBe("nvidia/nemotron-3-super-120b-a12b");
      expect(data.provider).toBe("nvidia-nim");
      expect(data.gpuEnabled).toBe(false);
      expect(data.policies).toEqual(["pypi", "npm"]);
      expect(data.nim).toBeDefined();
      expect(typeof data.nim.running).toBe("boolean");
    });
  });

  describe("<name> policy-list --json", () => {
    it("outputs valid JSON with presets and applied status", () => {
      const r = run("my-assistant policy-list --json", tmpHome);
      expect(r.code).toBe(0);
      const data = JSON.parse(r.out);
      expect(data.sandbox).toBe("my-assistant");
      expect(data.presets).toBeInstanceOf(Array);
      expect(data.presets.length).toBeGreaterThan(0);
      expect(data.applied).toEqual(["pypi", "npm"]);

      // Check that presets have the right shape
      const pypi = data.presets.find((p) => p.name === "pypi");
      expect(pypi).toBeDefined();
      expect(pypi.applied).toBe(true);
      expect(typeof pypi.description).toBe("string");

      // Check an unapplied preset
      const docker = data.presets.find((p) => p.name === "docker");
      expect(docker).toBeDefined();
      expect(docker.applied).toBe(false);
    });
  });

  describe("help text", () => {
    it("shows --json in help output", () => {
      const r = run("help", tmpHome);
      expect(r.out).toContain("--json");
    });
  });
});
