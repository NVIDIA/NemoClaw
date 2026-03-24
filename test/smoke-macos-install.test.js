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

  it("rejects unsupported runtimes", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--runtime", "podman"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_API_KEY: "nvapi-test" },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Unsupported runtime 'podman'/);
  });

  it("fails when a requested runtime socket is unavailable", () => {
    const result = spawnSync("bash", [SMOKE_SCRIPT, "--runtime", "docker-desktop"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        NVIDIA_API_KEY: "nvapi-test",
        HOME: "/tmp/nemoclaw-smoke-no-runtime",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /no Docker Desktop socket was found/);
  });

  it("stages the policy preset no answer after sandbox setup", () => {
    const script = `
      set -euo pipefail
      source "${SMOKE_SCRIPT}"
      answers_pipe="$(mktemp -u)"
      install_log="$(mktemp)"
      mkfifo "$answers_pipe"
      trap 'rm -f "$answers_pipe" "$install_log"' EXIT
      SANDBOX_NAME="smoke-test"
      feed_install_answers "$answers_pipe" "$install_log" &
      feeder_pid="$!"
      {
        IFS= read -r first_line
        printf '%s\\n' "$first_line"
        printf '  ✓ OpenClaw gateway launched inside sandbox\\n' >> "$install_log"
        IFS= read -r second_line
        printf '%s\\n' "$second_line"
      } < "$answers_pipe"
      wait "$feeder_pid"
    `;

    const result = spawnSync("bash", ["-lc", script], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, NVIDIA_API_KEY: "nvapi-test" },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "smoke-test\nn\n");
  });
});
