// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SMOKE_SCRIPT = path.join(__dirname, "..", "scripts", "smoke-macos-install.sh");

describe("macOS smoke install script guardrails", () => {
  it("prints help", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--help"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: \.\/scripts\/smoke-macos-install\.sh/);
  });

  it("requires NVIDIA_API_KEY", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_API_KEY: "" },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /NVIDIA_API_KEY must be set/);
  });

  it("rejects invalid sandbox names", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--sandbox-name", "Bad Name"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_API_KEY: "nvapi-test" },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Invalid sandbox name/);
  });
});
