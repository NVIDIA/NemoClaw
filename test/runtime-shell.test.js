// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUNTIME_SH = path.join(import.meta.dirname, "..", "scripts", "lib", "runtime.sh");

function runShell(script, env = {}) {
  return spawnSync("bash", ["-lc", script], {
    cwd: path.join(import.meta.dirname, ".."),
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("unix:///custom/docker.sock");
  });

  it("prefers Colima over Docker Desktop", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const colimaSocket = path.join(home, ".colima/default/docker.sock");
    const dockerDesktopSocket = path.join(home, ".docker/run/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: `${colimaSocket}:${dockerDesktopSocket}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`unix://${colimaSocket}`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects Docker Desktop when Colima is absent", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const dockerDesktopSocket = path.join(home, ".docker/run/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; detect_docker_host`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: dockerDesktopSocket,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`unix://${dockerDesktopSocket}`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("classifies a Docker Desktop DOCKER_HOST correctly", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; docker_host_runtime "unix:///Users/test/.docker/run/docker.sock"`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("docker-desktop");
  });

  it("selects the matching gateway cluster when a gateway name is present", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       select_openshell_cluster_container "nemoclaw" $'openshell-cluster-alpha\\nopenshell-cluster-nemoclaw'`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("openshell-cluster-nemoclaw");
  });

  it("fails on ambiguous cluster selection", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       select_openshell_cluster_container "" $'openshell-cluster-a\\nopenshell-cluster-b'`,
    );

    expect(result.status).not.toBe(0);
  });

  it("finds the XDG Colima socket", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-shell-"));
    const xdgColimaSocket = path.join(home, ".config/colima/default/docker.sock");

    const result = runShell(`source "${RUNTIME_SH}"; find_colima_docker_socket`, {
      HOME: home,
      NEMOCLAW_TEST_SOCKET_PATHS: xdgColimaSocket,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(xdgColimaSocket);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects podman from docker info output", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; infer_container_runtime_from_info "podman version 5.4.1"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("podman");
  });

  it("flags podman on macOS as unsupported", () => {
    const result = runShell(`source "${RUNTIME_SH}"; is_unsupported_macos_runtime Darwin podman`);
    expect(result.status).toBe(0);
  });

  it("does not flag podman on Linux", () => {
    const result = runShell(`source "${RUNTIME_SH}"; is_unsupported_macos_runtime Linux podman`);
    expect(result.status).not.toBe(0);
  });

  it("returns the vllm-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url vllm-local`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:8000/v1");
  });

  it("returns the ollama-local base URL", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url ollama-local`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("http://host.openshell.internal:11434/v1");
  });

  it("rejects unknown local providers", () => {
    const result = runShell(`source "${RUNTIME_SH}"; get_local_provider_base_url bogus-provider`);
    expect(result.status).not.toBe(0);
  });

  it("returns the first non-loopback nameserver", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; first_non_loopback_nameserver $'nameserver 127.0.0.11\\nnameserver 10.0.0.2'`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("10.0.0.2");
  });

  it("prefers the container nameserver when it is not loopback", () => {
    const result = runShell(
      `source "${RUNTIME_SH}"; resolve_coredns_upstream $'nameserver 10.0.0.2' $'nameserver 1.1.1.1' colima`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("10.0.0.2");
  });

  it("falls back to the Colima VM nameserver when the container resolver is loopback", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       get_colima_vm_nameserver() { printf '192.168.5.1\\n'; }
       resolve_coredns_upstream $'nameserver 127.0.0.11' $'nameserver 1.1.1.1' colima`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("192.168.5.1");
  });

  it("falls back to the host nameserver when no Colima VM nameserver is available", () => {
    const result = runShell(
      `source "${RUNTIME_SH}";
       get_colima_vm_nameserver() { return 1; }
       resolve_coredns_upstream $'nameserver 127.0.0.11' $'nameserver 9.9.9.9' colima`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("9.9.9.9");
  });

  it("does not consume installer stdin when reading the Colima VM nameserver", () => {
    const result = runShell(
      `function colima() { cat > /dev/null || true; printf 'nameserver 100.100.100.100\\n'; }
       source "${RUNTIME_SH}"
       printf 'sandbox-answer\\n' | {
         get_colima_vm_nameserver > /tmp/nemoclaw-colima-ns.out
         cat
       }`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("sandbox-answer");
  });
});
