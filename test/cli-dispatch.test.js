// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

describe("nemoclaw CLI dispatch", () => {
  it("--help exits 0 and prints usage", () => {
    const out = execFileSync("node", [CLI, "--help"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    assert.ok(out.includes("nemoclaw"), "should mention nemoclaw");
    assert.ok(out.includes("onboard"), "should list onboard command");
    assert.ok(out.includes("deploy"), "should list deploy command");
  });

  it("help subcommand exits 0", () => {
    const out = execFileSync("node", [CLI, "help"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    assert.ok(out.includes("Sandbox Management"), "should show Sandbox Management section");
  });

  it("-h is an alias for --help", () => {
    const out = execFileSync("node", [CLI, "-h"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    assert.ok(out.includes("nemoclaw"), "should mention nemoclaw");
  });

  it("unknown command exits non-zero", () => {
    try {
      execFileSync("node", [CLI, "nonexistent-cmd-xyz"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: "pipe",
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err.status !== 0, "should exit non-zero");
      assert.ok(err.stderr.includes("Unknown command"), "should mention Unknown command");
    }
  });

  it("list command exits 0 when no sandboxes registered", () => {
    // Uses a temp HOME so registry is empty
    const out = execFileSync("node", [CLI, "list"], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: "/tmp/nemoclaw-test-empty-" + Date.now() },
    });
    assert.ok(
      out.includes("No sandboxes") || out.includes("nemoclaw onboard"),
      "should indicate no sandboxes or suggest onboard",
    );
  });
});
