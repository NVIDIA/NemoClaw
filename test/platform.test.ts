// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";

import {
  detectDockerHost,
  findColimaDockerSocket,
  getDockerSocketCandidates,
  getPodmanSocketCandidates,
  inferContainerRuntime,
  isWsl,
  shouldPatchCoredns,
} from "../dist/lib/platform";

describe("platform helpers", () => {
  describe("isWsl", () => {
    it("detects WSL from environment", () => {
      expect(
        isWsl({
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          release: "6.6.87.2-microsoft-standard-WSL2",
        }),
      ).toBe(true);
    });

    it("does not treat macOS as WSL", () => {
      expect(
        isWsl({
          platform: "darwin",
          env: {},
          release: "24.6.0",
        }),
      ).toBe(false);
    });
  });

  describe("getPodmanSocketCandidates", () => {
    it("returns macOS Podman socket paths", () => {
      const home = "/tmp/test-home";
      expect(getPodmanSocketCandidates({ platform: "darwin", home })).toEqual([
        path.join(home, ".local/share/containers/podman/machine/podman.sock"),
        "/var/run/docker.sock",
      ]);
    });

    it("returns Linux Podman socket paths with uid", () => {
      expect(
        getPodmanSocketCandidates({ platform: "linux", home: "/tmp/test-home", uid: 1001 }),
      ).toEqual(["/run/user/1001/podman/podman.sock", "/run/podman/podman.sock"]);
    });

    it("returns no Podman socket paths on unsupported platforms", () => {
      expect(getPodmanSocketCandidates({ platform: "win32", home: "C:/Users/test" })).toEqual([]);
    });
  });

  describe("getDockerSocketCandidates", () => {
    it("returns macOS candidates in priority order (Colima > Podman > Docker Desktop)", () => {
      const home = "/tmp/test-home";
      expect(getDockerSocketCandidates({ platform: "darwin", home })).toEqual([
        path.join(home, ".colima/default/docker.sock"),
        path.join(home, ".config/colima/default/docker.sock"),
        path.join(home, ".local/share/containers/podman/machine/podman.sock"),
        "/var/run/docker.sock",
        path.join(home, ".docker/run/docker.sock"),
      ]);
    });

    it("returns Linux candidates (Podman > native Docker)", () => {
      expect(
        getDockerSocketCandidates({ platform: "linux", home: "/tmp/test-home", uid: 1000 }),
      ).toEqual([
        "/run/user/1000/podman/podman.sock",
        "/run/podman/podman.sock",
        "/run/docker.sock",
        "/var/run/docker.sock",
      ]);
    });
  });

  describe("findColimaDockerSocket", () => {
    it("finds the first available Colima socket", () => {
      const home = "/tmp/test-home";
      const sockets = new Set([path.join(home, ".config/colima/default/docker.sock")]);
      const existsSync = (socketPath) => sockets.has(socketPath);

      expect(findColimaDockerSocket({ home, existsSync })).toBe(
        path.join(home, ".config/colima/default/docker.sock"),
      );
    });
  });

  describe("detectDockerHost", () => {
    it("respects an existing DOCKER_HOST", () => {
      expect(
        detectDockerHost({
          env: { DOCKER_HOST: "unix:///custom/docker.sock" },
          platform: "darwin",
          home: "/tmp/test-home",
          existsSync: () => false,
        }),
      ).toEqual({
        dockerHost: "unix:///custom/docker.sock",
        source: "env",
        socketPath: null,
      });
    });

    it("prefers Colima over Docker Desktop on macOS", () => {
      const home = "/tmp/test-home";
      const sockets = new Set([
        path.join(home, ".colima/default/docker.sock"),
        path.join(home, ".docker/run/docker.sock"),
      ]);
      const existsSync = (socketPath) => sockets.has(socketPath);

      expect(detectDockerHost({ env: {}, platform: "darwin", home, existsSync })).toEqual({
        dockerHost: `unix://${path.join(home, ".colima/default/docker.sock")}`,
        source: "socket",
        socketPath: path.join(home, ".colima/default/docker.sock"),
      });
    });

    it("detects Docker Desktop when Colima is absent", () => {
      const home = "/tmp/test-home";
      const socketPath = path.join(home, ".docker/run/docker.sock");
      const existsSync = (candidate) => candidate === socketPath;

      expect(detectDockerHost({ env: {}, platform: "darwin", home, existsSync })).toEqual({
        dockerHost: `unix://${socketPath}`,
        source: "socket",
        socketPath,
      });
    });

    it("returns null when no auto-detected socket is available", () => {
      expect(
        detectDockerHost({
          env: {},
          platform: "linux",
          home: "/tmp/test-home",
          existsSync: () => false,
        }),
      ).toBe(null);
    });
  });

  describe("inferContainerRuntime", () => {
    it("detects podman", () => {
      expect(inferContainerRuntime("podman version 5.4.1")).toBe("podman");
    });

    it("detects Docker Desktop", () => {
      expect(inferContainerRuntime("Docker Desktop 4.42.0 (190636)")).toBe("docker-desktop");
    });

    it("detects Colima", () => {
      expect(inferContainerRuntime("Server: Colima\n Docker Engine - Community")).toBe("colima");
    });
  });

  describe("shouldPatchCoredns", () => {
    // Pass explicit `isWsl: false` so this test pins the function's runtime
    // matching logic on every host. Without the override, `shouldPatchCoredns`
    // consults `isWsl()`, which returns true on WSL2 dev machines (via
    // `os.release()`), and the assertions flip below.
    it("patches CoreDNS for Colima and Podman (non-WSL host)", () => {
      expect(shouldPatchCoredns("colima", { isWsl: false })).toBe(true);
      expect(shouldPatchCoredns("podman", { isWsl: false })).toBe(true);
      expect(shouldPatchCoredns("docker-desktop", { isWsl: false })).toBe(false);
      expect(shouldPatchCoredns("docker", { isWsl: false })).toBe(false);
    });

    it("never patches CoreDNS on WSL2 (host DNS unreachable from k3s pods)", () => {
      expect(shouldPatchCoredns("colima", { isWsl: true })).toBe(false);
      expect(shouldPatchCoredns("podman", { isWsl: true })).toBe(false);
      expect(shouldPatchCoredns("docker-desktop", { isWsl: true })).toBe(false);
      expect(shouldPatchCoredns("docker", { isWsl: true })).toBe(false);
    });
  });

  describe("detectDockerHost with Podman", () => {
    it("detects Podman socket on macOS when Colima is absent", () => {
      const home = "/tmp/test-home";
      const podmanSocket = path.join(home, ".local/share/containers/podman/machine/podman.sock");
      const existsSync = (candidate) => candidate === podmanSocket;

      expect(detectDockerHost({ env: {}, platform: "darwin", home, existsSync })).toEqual({
        dockerHost: `unix://${podmanSocket}`,
        source: "socket",
        socketPath: podmanSocket,
      });
    });

    it("prefers Colima over Podman on macOS", () => {
      const home = "/tmp/test-home";
      const colimaSocket = path.join(home, ".colima/default/docker.sock");
      const podmanSocket = path.join(home, ".local/share/containers/podman/machine/podman.sock");
      const sockets = new Set([colimaSocket, podmanSocket]);
      const existsSync = (candidate) => sockets.has(candidate);

      expect(detectDockerHost({ env: {}, platform: "darwin", home, existsSync })).toEqual({
        dockerHost: `unix://${colimaSocket}`,
        source: "socket",
        socketPath: colimaSocket,
      });
    });
  });
});
