// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { detectContainerSocket } = require("../bin/lib/runner");

describe("detectContainerSocket", () => {
  it("returns null when no sockets exist", () => {
    const result = detectContainerSocket({
      home: "/nonexistent",
      existsSync: () => false,
      uid: 1000,
    });
    assert.equal(result, null);
  });

  it("detects Docker Desktop socket", () => {
    const dockerDesktopPath = "/home/test/.docker/run/docker.sock";

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === dockerDesktopPath,
      uid: 1000,
    });
    assert.equal(result, dockerDesktopPath);
  });

  it("prefers Colima over Docker Desktop", () => {
    const colimaPath = "/home/test/.colima/default/docker.sock";
    const dockerDesktopPath = "/home/test/.docker/run/docker.sock";

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === colimaPath || p === dockerDesktopPath,
      uid: 1000,
    });
    assert.equal(result, colimaPath);
  });

  it("prefers Docker Desktop over Podman", () => {
    const dockerDesktopPath = "/home/test/.docker/run/docker.sock";
    const podmanPath = "/home/test/.local/share/containers/podman/machine/podman.sock";

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === dockerDesktopPath || p === podmanPath,
      uid: 1000,
    });
    assert.equal(result, dockerDesktopPath);
  });

  it("prefers Colima over Podman when both exist", () => {
    const colimaPath = "/home/test/.colima/default/docker.sock";
    const podmanPath = "/home/test/.local/share/containers/podman/machine/podman.sock";

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === colimaPath || p === podmanPath,
      uid: 1000,
    });
    assert.equal(result, colimaPath);
  });

  it("falls back to Podman when Colima absent", () => {
    const podmanPath = "/home/test/.local/share/containers/podman/machine/podman.sock";

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === podmanPath,
      uid: 1000,
    });
    assert.equal(result, podmanPath);
  });

  it("detects rootless Podman socket", () => {
    const uid = 1001;
    const rootlessPath = `/run/user/${uid}/podman/podman.sock`;

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === rootlessPath,
      uid,
    });
    assert.equal(result, rootlessPath);
  });

  it("detects XDG Colima socket", () => {
    const xdgPath = "/home/test/.config/colima/default/docker.sock";

    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === xdgPath,
      uid: 1000,
    });
    assert.equal(result, xdgPath);
  });

  it("detects Podman QEMU socket path", () => {
    const qemuPath = "/home/test/.local/share/containers/podman/machine/qemu/podman.sock";
    const result = detectContainerSocket({
      home: "/home/test",
      existsSync: (p) => p === qemuPath,
      uid: 1000,
    });
    assert.equal(result, qemuPath);
  });
});
