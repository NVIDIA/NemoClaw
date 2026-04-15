// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

describe("nemoclaw CLI dispatch", () => {
  it("--help exits 0 and prints usage", () => {
    const out = execFileSync("node", [CLI, "--help"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(out).toContain("nemoclaw");
    expect(out).toContain("onboard");
    expect(out).toContain("deploy");
  });

  it("help subcommand exits 0", () => {
    const out = execFileSync("node", [CLI, "help"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(out).toContain("Sandbox Management");
  });

  it("-h is an alias for --help", () => {
    const out = execFileSync("node", [CLI, "-h"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(out).toContain("nemoclaw");
  });

  it("unknown command exits non-zero", () => {
    try {
      execFileSync("node", [CLI, "nonexistent-cmd-xyz"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err.status).not.toBe(0);
      expect(err.stderr).toContain("Unknown command");
    }
  });

  it("list command exits 0 when no sandboxes registered", () => {
    // Uses a temp HOME so registry is empty
    const out = execFileSync("node", [CLI, "list"], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: "/tmp/nemoclaw-test-empty-" + Date.now() },
    });
    expect(out.includes("No sandboxes") || out.includes("nemoclaw onboard")).toBe(true);
  });
});
