// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  detectDockerHost,
  findColimaDockerSocket,
  getDockerSocketCandidates,
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  isWsl,
  shouldPatchCoredns,
} = require("../bin/lib/platform");

describe("platform helpers", () => {
  describe("isWsl", () => {
    it("detects WSL from environment", () => {
      assert.equal(
        isWsl({
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          release: "6.6.87.2-microsoft-standard-WSL2",
        }),
        true,
      );
    });

    it("does not treat macOS as WSL", () => {
      assert.equal(
        isWsl({
          platform: "darwin",
          env: {},
          release: "24.6.0",
        }),
        false,
      );
    });
  });

  describe("getDockerSocketCandidates", () => {
    it("returns macOS candidates in priority order", () => {
      const home = "/tmp/test-home";
      assert.deepEqual(getDockerSocketCandidates({ platform: "darwin", home }), [
        path.join(home, ".colima/default/docker.sock"),
        path.join(home, ".config/colima/default/docker.sock"),
        path.join(home, ".docker/run/docker.sock"),
      ]);
    });

    it("does not auto-detect sockets on Linux", () => {
      assert.deepEqual(getDockerSocketCandidates({ platform: "linux", home: "/tmp/test-home" }), []);
    });
  });

  describe("findColimaDockerSocket", () => {
    it("finds the first available Colima socket", () => {
      const home = "/tmp/test-home";
      const sockets = new Set([path.join(home, ".config/colima/default/docker.sock")]);
      const existsSync = (socketPath) => sockets.has(socketPath);

      assert.equal(
        findColimaDockerSocket({ home, existsSync }),
        path.join(home, ".config/colima/default/docker.sock"),
      );
    });
  });

  describe("detectDockerHost", () => {
    it("respects an existing DOCKER_HOST", () => {
      assert.deepEqual(
        detectDockerHost({
          env: { DOCKER_HOST: "unix:///custom/docker.sock" },
          platform: "darwin",
          home: "/tmp/test-home",
          existsSync: () => false,
        }),
        {
          dockerHost: "unix:///custom/docker.sock",
          source: "env",
          socketPath: null,
        },
      );
    });

    it("prefers Colima over Docker Desktop on macOS", () => {
      const home = "/tmp/test-home";
      const sockets = new Set([
        path.join(home, ".colima/default/docker.sock"),
        path.join(home, ".docker/run/docker.sock"),
      ]);
      const existsSync = (socketPath) => sockets.has(socketPath);

      assert.deepEqual(
        detectDockerHost({ env: {}, platform: "darwin", home, existsSync }),
        {
          dockerHost: `unix://${path.join(home, ".colima/default/docker.sock")}`,
          source: "socket",
          socketPath: path.join(home, ".colima/default/docker.sock"),
        },
      );
    });

    it("detects Docker Desktop when Colima is absent", () => {
      const home = "/tmp/test-home";
      const socketPath = path.join(home, ".docker/run/docker.sock");
      const existsSync = (candidate) => candidate === socketPath;

      assert.deepEqual(
        detectDockerHost({ env: {}, platform: "darwin", home, existsSync }),
        {
          dockerHost: `unix://${socketPath}`,
          source: "socket",
          socketPath,
        },
      );
    });

    it("returns null when no auto-detected socket is available", () => {
      assert.equal(
        detectDockerHost({
          env: {},
          platform: "linux",
          home: "/tmp/test-home",
          existsSync: () => false,
        }),
        null,
      );
    });
  });

  describe("inferContainerRuntime", () => {
    it("detects podman", () => {
      assert.equal(inferContainerRuntime("podman version 5.4.1"), "podman");
    });

    it("detects Docker Desktop", () => {
      assert.equal(inferContainerRuntime("Docker Desktop 4.42.0 (190636)"), "docker-desktop");
    });

    it("detects Colima", () => {
      assert.equal(inferContainerRuntime("Server: Colima\n Docker Engine - Community"), "colima");
    });
  });

  describe("isUnsupportedMacosRuntime", () => {
    it("flags podman on macOS", () => {
      assert.equal(isUnsupportedMacosRuntime("podman", { platform: "darwin" }), true);
    });

    it("does not flag podman on Linux", () => {
      assert.equal(isUnsupportedMacosRuntime("podman", { platform: "linux" }), false);
    });
  });

  describe("shouldPatchCoredns", () => {
    it("patches CoreDNS for Colima only", () => {
      assert.equal(shouldPatchCoredns("colima"), true);
      assert.equal(shouldPatchCoredns("docker-desktop"), false);
      assert.equal(shouldPatchCoredns("docker"), false);
    });
  });
});
