// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import _fs from "node:fs";
import _os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function run(args) {
  return runWithEnv(args);
}

function runWithEnv(args, env = {}, timeout = 10000) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout,
      env: { ...process.env, HOME: "/tmp/nemoclaw-cli-test-" + Date.now(), ...env },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("CLI dispatch", () => {
  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("-h exits 0", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("unknown command exits 1", () => {
    const r = run("boguscmd");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option")).toBeTruthy();
  });

  it("accepts onboard --resume in CLI parsing", () => {
    const r = run("onboard --resume --non-interactiv");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown onboard option(s): --non-interactiv")).toBeTruthy();
  });

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collect NemoClaw diagnostic information")).toBeTruthy();
    expect(r.out.includes("--quick")).toBeTruthy();
    expect(r.out.includes("--output")).toBeTruthy();
  });

  it("debug --quick exits 0 and produces diagnostic output", { timeout: 15000 }, () => {
    const r = run("debug --quick");
    expect(r.code).toBe(0);
    expect(r.out.includes("Collecting diagnostics")).toBeTruthy();
    expect(r.out.includes("System")).toBeTruthy();
    expect(r.out.includes("Onboard Session")).toBeTruthy();
    expect(r.out.includes("Done")).toBeTruthy();
  });

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown option")).toBeTruthy();
  });

  it("help mentions debug command", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Troubleshooting")).toBeTruthy();
    expect(r.out.includes("nemoclaw debug")).toBeTruthy();
  });

  it("help mentions telegram probe command", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("telegram-probe"), "help should mention telegram-probe command");
    assert.ok(r.out.includes("Probe api.telegram.org from inside a sandbox"));
  });

  it("help mentions discord probe command", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("discord-probe"), "help should mention discord-probe command");
    assert.ok(r.out.includes("Probe discord.com from inside a sandbox"));
  });

  it("help mentions dashboard command", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("dashboard"), "help should mention dashboard command");
    assert.ok(
      r.out.includes("Show dashboard access URL"),
      "help should describe dashboard command",
    );
  });

  it("help mentions backup and restore commands", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("backup"), "help should mention backup command");
    assert.ok(r.out.includes("restore"), "help should mention restore command");
    assert.ok(r.out.includes("repair-main"), "help should mention repair-main command");
  });

  it("unknown sandbox action mentions dashboard in valid actions", () => {
    const r = run("bogus-sandbox-name bogus-action");
    // Exits 1 (unknown sandbox) or the error path for unknown action
    assert.ok(
      r.out.includes("dashboard") ||
        r.out.includes("repair-main") ||
        r.out.includes("Unknown command"),
      "error output should be informative",
    );
  });

  it("help mentions Discord service support", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(
      r.out.includes("Telegram, Discord, tunnel"),
      "help should mention Discord in the services section",
    );
  });
});
