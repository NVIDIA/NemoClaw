// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

function run(args) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: "/tmp/nemoclaw-cli-test-" + Date.now() },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("CLI dispatch", () => {
  it("help exits 0 and shows sections", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Getting Started"), "missing Getting Started section");
    assert.ok(r.out.includes("Sandbox Management"), "missing Sandbox Management section");
    assert.ok(r.out.includes("Policy Presets"), "missing Policy Presets section");
  });

  it("--help exits 0", () => {
    assert.equal(run("--help").code, 0);
  });

  it("-h exits 0", () => {
    assert.equal(run("-h").code, 0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("nemoclaw"));
  });

  it("unknown command exits 1", () => {
    const r = run("boguscmd");
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("Unknown command"));
  });

  it("list exits 0", () => {
    const r = run("list");
    assert.equal(r.code, 0);
    // With empty HOME, should say no sandboxes
    assert.ok(r.out.includes("No sandboxes"));
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("Unknown onboard option"));
  });
});
