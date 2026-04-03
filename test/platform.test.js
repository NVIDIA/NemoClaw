// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import {
  detectDockerHost,
  findColimaDockerSocket,
  getColimaDockerSocketCandidates,
  getDockerSocketCandidates,
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  isWsl,
  shouldPatchCoredns,
} from "../bin/lib/platform";

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

    it("detects WSL from /proc version text even without WSL env vars", () => {
      expect(
        isWsl({
          platform: "linux",
          env: {},
          release: "6.6.87-generic",
          procVersion: "Linux version 6.6.87.2-microsoft-standard-WSL2",
        }),
      ).toBe(true);
    });
  });

  describe("getDockerSocketCandidates", () => {
    it("returns macOS candidates in priority order", () => {
      const home = "/tmp/test-home";
      expect(getDockerSocketCandidates({ platform: "darwin", home })).toEqual([
        path.join(home, ".colima/default/docker.sock"),
        path.join(home, ".config/colima/default/docker.sock"),
        path.join(home, ".docker/run/docker.sock"),
      ]);
    });

    it("does not auto-detect sockets on Linux", () => {
      expect(getDockerSocketCandidates({ platform: "linux", home: "/tmp/test-home" })).toEqual([]);
    });
  });

  describe("getColimaDockerSocketCandidates", () => {
    it("returns both legacy and config-path Colima sockets", () => {
      expect(getColimaDockerSocketCandidates({ home: "/tmp/test-home" })).toEqual([
        "/tmp/test-home/.colima/default/docker.sock",
        "/tmp/test-home/.config/colima/default/docker.sock",
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

    it("returns null when no Colima socket exists", () => {
      expect(
        findColimaDockerSocket({ home: "/tmp/test-home", existsSync: () => false }),
      ).toBeNull();
    });

    it("uses fs.existsSync when no custom existsSync is provided", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-colima-"));
      const socketPath = path.join(home, ".config/colima/default/docker.sock");
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.writeFileSync(socketPath, "");

      expect(findColimaDockerSocket({ home })).toBe(socketPath);
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

    it("uses fs.existsSync when no custom existsSync is provided", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-"));
      const socketPath = path.join(home, ".docker/run/docker.sock");
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.writeFileSync(socketPath, "");

      expect(detectDockerHost({ env: {}, platform: "darwin", home })).toEqual({
        dockerHost: `unix://${socketPath}`,
        source: "socket",
        socketPath,
      });
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

    it("detects plain Docker and unknown output", () => {
      expect(inferContainerRuntime("Docker Engine - Community")).toBe("docker");
      expect(inferContainerRuntime("")).toBe("unknown");
      expect(inferContainerRuntime("some unrelated runtime")).toBe("unknown");
    });
  });

  describe("isUnsupportedMacosRuntime", () => {
    it("flags podman on macOS", () => {
      expect(isUnsupportedMacosRuntime("podman", { platform: "darwin" })).toBe(true);
    });

    it("does not flag podman on Linux", () => {
      expect(isUnsupportedMacosRuntime("podman", { platform: "linux" })).toBe(false);
    });
  });

  describe("shouldPatchCoredns", () => {
    it("patches on non-WSL runtimes", () => {
      const nonWslOpts = { platform: "darwin", env: {} };
      expect(shouldPatchCoredns("colima", nonWslOpts)).toBe(true);
      expect(shouldPatchCoredns("docker-desktop", nonWslOpts)).toBe(true);
      expect(shouldPatchCoredns("docker", nonWslOpts)).toBe(true);
      expect(shouldPatchCoredns("podman", nonWslOpts)).toBe(true);
    });

    it("skips unknown runtimes", () => {
      expect(shouldPatchCoredns("unknown")).toBe(false);
    });

    it("skips on WSL", () => {
      expect(
        shouldPatchCoredns("docker-desktop", {
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          release: "6.6.87.2-microsoft-standard-WSL2",
        }),
      ).toBe(false);
    });
  });
});
