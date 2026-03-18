// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RUNTIME_SH = path.join(__dirname, "..", "scripts", "lib", "runtime.sh");

afterEach(() => {});

function runShell(script, env = {}) {
  return spawnSync("bash", ["-lc", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe("shell runtime helpers", () => {
  it("respects an existing DOCKER_HOST", () => {
    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      DOCKER_HOST: "unix:///custom/docker.sock",
      HOME: "/tmp/unused-home",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "unix:///custom/docker.sock");
  });

  it("prefers Colima over Docker Desktop", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const colimaSocket = path.join(home, ".colima/default/docker.sock");
    const dockerDesktopSocket = path.join(home, ".docker/run/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: `${colimaSocket}:${dockerDesktopSocket}`,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `unix://${colimaSocket}`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects Docker Desktop when Colima is absent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const dockerDesktopSocket = path.join(home, ".docker/run/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: dockerDesktopSocket,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `unix://${dockerDesktopSocket}`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds the XDG Colima socket", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const xdgColimaSocket = path.join(home, ".config/colima/default/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; find_colima_docker_socket`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: xdgColimaSocket,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), xdgColimaSocket);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects podman from docker info output", () => {
    const result = runShell(`source "${RUNTIME_SH}"; infer_container_runtime_from_info "podman version 5.4.1"`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "podman");
  });

  it("flags podman on macOS as unsupported", () => {
    const result = runShell(`source "${RUNTIME_SH}"; is_unsupported_macos_runtime Darwin podman`);
    assert.equal(result.status, 0);
  });

  it("does not flag podman on Linux", () => {
    const result = runShell(`source "${RUNTIME_SH}"; is_unsupported_macos_runtime Linux podman`);
    assert.notEqual(result.status, 0);
  });

  it("returns the vllm-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url vllm-local`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "http://host.openshell.internal:8000/v1");
  });

  it("returns the ollama-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ollama-local`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "http://host.openshell.internal:11434/v1");
  });

  it("rejects unknown local providers", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url bogus-provider`);
    assert.notEqual(result.status, 0);
  });
});
