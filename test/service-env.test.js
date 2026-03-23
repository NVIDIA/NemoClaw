// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { resolveOpenshell } from "../bin/lib/resolve-openshell";

describe("service environment", () => {
  describe("resolveOpenshell logic", () => {
    it("returns command -v result when absolute path", () => {
      expect(resolveOpenshell({ commandVResult: "/usr/bin/openshell" })).toBe("/usr/bin/openshell");
    });

    it("rejects non-absolute command -v result (alias)", () => {
      expect(
        resolveOpenshell({ commandVResult: "openshell", checkExecutable: () => false })
      ).toBe(null);
    });

    it("rejects alias definition from command -v", () => {
      expect(
        resolveOpenshell({ commandVResult: "alias openshell='echo pwned'", checkExecutable: () => false })
      ).toBe(null);
    });

    it("falls back to ~/.local/bin when command -v fails", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/fakehome/.local/bin/openshell",
        home: "/fakehome",
      })).toBe("/fakehome/.local/bin/openshell");
    });

    it("falls back to /usr/local/bin", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/local/bin/openshell",
      })).toBe("/usr/local/bin/openshell");
    });

    it("falls back to /usr/bin", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/bin/openshell",
      })).toBe("/usr/bin/openshell");
    });

    it("prefers ~/.local/bin over /usr/local/bin", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/fakehome/.local/bin/openshell" || p === "/usr/local/bin/openshell",
        home: "/fakehome",
      })).toBe("/fakehome/.local/bin/openshell");
    });

    it("returns null when openshell not found anywhere", () => {
      expect(resolveOpenshell({
        commandVResult: null,
        checkExecutable: () => false,
      })).toBe(null);
    });
  });

  describe("SANDBOX_NAME defaulting", () => {
    it("start-services.sh preserves existing SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "my-box" },
        }
      ).trim();
      expect(result).toBe("my-box");
    });

    it("start-services.sh uses NEMOCLAW_SANDBOX over SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "from-env", SANDBOX_NAME: "old" },
        }
      ).trim();
      expect(result).toBe("from-env");
    });

    it("start-services.sh falls back to default when both unset", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "" },
        }
      ).trim();
      expect(result).toBe("default");
    });
  });

  describe("SANDBOX_NAME consistency across start/stop/status (#587)", () => {
    it("stop() passes SANDBOX_NAME via sandboxEnvPrefix", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      // stop() must use sandboxEnvPrefix so the PIDDIR matches start()
      const stopFn = src.match(/function stop\(\)\s*\{[\s\S]*?\n\}/);
      expect(stopFn).toBeTruthy();
      expect(
        stopFn[0].includes("sandboxEnvPrefix")
      ).toBe(true);
    });

    it("showStatus() passes SANDBOX_NAME via sandboxEnvPrefix", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      const statusFn = src.match(/function showStatus\(\)\s*\{[\s\S]*?\n\}/);
      expect(statusFn).toBeTruthy();
      expect(
        statusFn[0].includes("sandboxEnvPrefix")
      ).toBe(true);
    });

    it("sandboxEnvPrefix() is a shared helper used by start, stop, and status", () => {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      const uses = (
        src.match(/\bconst\s+envPrefix\s*=\s*sandboxEnvPrefix\(\)/g) || []
      ).length;
      // Exactly 3 call sites: start(), stop(), showStatus()
      expect(uses).toBe(3);
    });
  });
});
