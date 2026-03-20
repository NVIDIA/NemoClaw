// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

function run(args, extraEnv = {}) {
  const createdHome = !extraEnv.HOME;
  const home = extraEnv.HOME || fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-"));
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...extraEnv, HOME: home },
    });
    return { code: 0, out, home };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || ""), home };
  } finally {
    if (createdHome) {
      fs.rmSync(home, { recursive: true, force: true });
    }
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

  it("logs dispatch uses openshell logs with tail follow mode", () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-bin-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-home-"));
    const fakeOpenShell = path.join(fakeBin, "openshell");
    const registryDir = path.join(fakeHome, ".nemoclaw");

    fs.writeFileSync(
      fakeOpenShell,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/openshell-args.txt\"\n",
      { mode: 0o755 },
    );
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          "my-assistant": {
            name: "my-assistant",
            model: "test-model",
            provider: "nvidia-nim",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "my-assistant",
      }),
    );

    const r = run("my-assistant logs --follow", {
      HOME: fakeHome,
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    assert.equal(r.code, 0);
    const args = fs
      .readFileSync(path.join(fakeHome, "openshell-args.txt"), "utf-8")
      .trim()
      .split("\n");
    assert.deepEqual(args, ["logs", "my-assistant", "--tail"]);
  });

  it("cleans up internally-created HOME directories after each run", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.home, "expected run() to report the HOME directory it used");
    assert.equal(fs.existsSync(r.home), false, "expected auto-created HOME directory to be removed");
  });
});
