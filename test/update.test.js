// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseUpdateArgs,
  normalizeSemver,
  isUpdateAvailable,
  printUpdateUsage,
} from "../dist/lib/update";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(TEST_DIR, "..", "bin", "nemoclaw.js");

describe("nemoclaw update command", () => {
  describe("command registration", () => {
    it("update command appears in help output", () => {
      const output = execSync(`node "${CLI}" help`, { encoding: "utf-8" });
      expect(output).toContain("update");
    });

    it("update is in Getting Started group", () => {
      const output = execSync(`node "${CLI}" help`, { encoding: "utf-8" });
      // Verify that "update" appears after "Getting Started" header
      const helpLines = output.split("\n");
      let inGettingStarted = false;
      let foundUpdate = false;
      for (const line of helpLines) {
        if (line.includes("Getting Started")) {
          inGettingStarted = true;
        } else if (line.includes("Sandbox Management")) {
          inGettingStarted = false;
        }
        if (inGettingStarted && line.includes("update")) {
          foundUpdate = true;
        }
      }
      expect(foundUpdate).toBe(true);
    });

    it("update command supports --check flag", () => {
      const output = execSync(`node "${CLI}" help`, { encoding: "utf-8" });
      expect(output).toContain("--check");
    });

    it("update command supports --auto flag", () => {
      const output = execSync(`node "${CLI}" help`, { encoding: "utf-8" });
      expect(output).toContain("--auto");
    });
  });

  describe("parseUpdateArgs", () => {
    it("parses --check flag", () => {
      const parsed = parseUpdateArgs(["--check"]);
      expect(parsed.check).toBe(true);
      expect(parsed.auto).toBe(false);
    });

    it("parses --auto flag", () => {
      const parsed = parseUpdateArgs(["--auto"]);
      expect(parsed.auto).toBe(true);
      expect(parsed.check).toBe(false);
    });

    it("parses both --check and --auto", () => {
      const parsed = parseUpdateArgs(["--check", "--auto"]);
      expect(parsed.check).toBe(true);
      expect(parsed.auto).toBe(true);
    });

    it("defaults to check=false, auto=false when no flags", () => {
      const parsed = parseUpdateArgs([]);
      expect(parsed.check).toBe(false);
      expect(parsed.auto).toBe(false);
    });

    it("parses --help flag", () => {
      const parsed = parseUpdateArgs(["--help"]);
      expect(parsed.help).toBe(true);
    });

    it("throws on unknown flags", () => {
      expect(() => parseUpdateArgs(["--check", "--unknown", "--auto"])).toThrow(
        /Unknown update option/,
      );
    });
  });

  describe("normalizeSemver", () => {
    it("accepts valid semantic versions", () => {
      expect(normalizeSemver("1.0.0")).toBe("1.0.0");
      expect(normalizeSemver("2.3.4")).toBe("2.3.4");
      expect(normalizeSemver("0.0.0")).toBe("0.0.0");
    });

    it("cleans versions with leading v", () => {
      const result = normalizeSemver("v1.2.3");
      expect(result).toBeTruthy();
      expect(result).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("handles edge case: empty string", () => {
      expect(normalizeSemver("")).toBeNull();
    });

    it("handles edge case: whitespace only", () => {
      expect(normalizeSemver("   ")).toBeNull();
    });

    it("rejects completely invalid versions", () => {
      expect(normalizeSemver("not-a-version")).toBeNull();
      expect(normalizeSemver("abc")).toBeNull();
    });

    it("coerces partial versions like 1.2", () => {
      const result = normalizeSemver("1.2");
      // semver.coerce may handle this
      if (result) {
        expect(result).toMatch(/^\d+\.\d+\.\d+$/);
      }
    });
  });

  describe("isUpdateAvailable", () => {
    it("detects newer major version available", () => {
      expect(isUpdateAvailable("1.0.0", "2.0.0")).toBe(true);
      expect(isUpdateAvailable("0.1.0", "1.0.0")).toBe(true);
    });

    it("detects newer minor version available", () => {
      expect(isUpdateAvailable("1.0.0", "1.1.0")).toBe(true);
      expect(isUpdateAvailable("1.5.0", "1.6.0")).toBe(true);
    });

    it("detects newer patch version available", () => {
      expect(isUpdateAvailable("1.0.0", "1.0.1")).toBe(true);
      expect(isUpdateAvailable("1.0.5", "1.0.6")).toBe(true);
    });

    it("detects when current version is latest", () => {
      expect(isUpdateAvailable("1.0.0", "1.0.0")).toBe(false);
      expect(isUpdateAvailable("2.5.3", "2.5.3")).toBe(false);
    });

    it("detects when current version is newer than available", () => {
      expect(isUpdateAvailable("2.0.0", "1.0.0")).toBe(false);
      expect(isUpdateAvailable("1.1.0", "1.0.0")).toBe(false);
      expect(isUpdateAvailable("1.0.5", "1.0.3")).toBe(false);
    });
  });

  describe("printUpdateUsage", () => {
    it("prints usage message without error", () => {
      const messages = [];
      printUpdateUsage((msg) => {
        if (msg) messages.push(msg);
      });
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join("\n")).toContain("nemoclaw update");
    });

    it("mentions --check flag in usage", () => {
      const messages = [];
      printUpdateUsage((msg) => {
        if (msg) messages.push(msg);
      });
      const usage = messages.join("\n");
      expect(usage).toContain("--check");
    });

    it("mentions --auto flag in usage", () => {
      const messages = [];
      printUpdateUsage((msg) => {
        if (msg) messages.push(msg);
      });
      const usage = messages.join("\n");
      expect(usage).toContain("--auto");
    });
  });
});
