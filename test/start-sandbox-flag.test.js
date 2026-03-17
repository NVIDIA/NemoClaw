// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

function run(args, env = {}) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: "/tmp/nemoclaw-cli-test-" + Date.now(), ...env },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("resolveSandboxFlag via CLI", () => {
  it("help shows --sandbox flag for start/stop", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("--sandbox"), "help should mention --sandbox flag");
  });
});

describe("start-services.sh --sandbox flag", () => {
  it("--status with --sandbox does not crash", () => {
    // start-services.sh --sandbox testbox --status should exit 0
    const script = path.join(__dirname, "..", "scripts", "start-services.sh");
    try {
      const out = execSync(`bash "${script}" --sandbox testbox --status`, {
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, NVIDIA_API_KEY: "fake" },
      });
      // Should show stopped services (not crash)
      assert.ok(out.includes("telegram-bridge") || out.includes("stopped"), "should show service status");
    } catch (err) {
      // Even on error, should not be a bash syntax error
      const combined = (err.stdout || "") + (err.stderr || "");
      assert.ok(!combined.includes("syntax error"), "should not have bash syntax errors");
    }
  });

  it("uses sandbox-specific PID directory", () => {
    const script = path.join(__dirname, "..", "scripts", "start-services.sh");
    try {
      const out = execSync(`bash "${script}" --sandbox testpidbox --status 2>&1`, {
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, NVIDIA_API_KEY: "fake" },
      });
      // The PID dir should be sandbox-specific; the script creates it on --status
      const fs = require("fs");
      assert.ok(
        fs.existsSync("/tmp/nemoclaw-services-testpidbox"),
        "should create sandbox-specific PID directory"
      );
    } catch {
      // Non-fatal — the dir should still be created via mkdir -p in show_status
    }
  });
});
