// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyDockerVersionIdentity,
  containerCanReachHostLoopback,
  detectDockerHost,
  findColimaDockerSocket,
  getDockerSocketCandidates,
  getPodmanSocketCandidates,
  inferContainerRuntime,
  isWsl,
  shouldPatchCoredns,
} from "../../src/lib/platform";

const reachableDockerFallback = (dockerHost: string | undefined) => ({
  reachable: Boolean(dockerHost),
  identity: "docker" as const,
});

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
        path.join(home, ".colima/docker.sock"),
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
      const existsSync = (socketPath: string) => sockets.has(socketPath);

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
          probeDockerHost: () => {
            throw new Error("explicit DOCKER_HOST must not be probed");
          },
        }),
      ).toEqual({
        dockerHost: "unix:///custom/docker.sock",
        source: "env",
        socketPath: null,
      });
    });

    it("preserves an explicit Podman DOCKER_HOST without probing another authority (#8816)", () => {
      const dockerHost = "unix:///run/user/1000/podman/podman.sock";

      expect(
        detectDockerHost({
          env: { DOCKER_HOST: dockerHost },
          platform: "linux",
          uid: 1000,
          existsSync: () => false,
          probeDockerHost: () => {
            throw new Error("explicit DOCKER_HOST must not be probed");
          },
        }),
      ).toEqual({ dockerHost, source: "env", socketPath: null });
    });

    it("prefers Colima over Docker Desktop on macOS", () => {
      const home = "/tmp/test-home";
      const sockets = new Set([
        path.join(home, ".colima/default/docker.sock"),
        path.join(home, ".docker/run/docker.sock"),
      ]);
      const existsSync = (socketPath: string) => sockets.has(socketPath);

      expect(
        detectDockerHost({
          env: {},
          platform: "darwin",
          home,
          existsSync,
          probeDockerHost: reachableDockerFallback,
        }),
      ).toEqual({
        dockerHost: `unix://${path.join(home, ".colima/default/docker.sock")}`,
        source: "socket",
        socketPath: path.join(home, ".colima/default/docker.sock"),
      });
    });

    it("detects Docker Desktop when Colima is absent", () => {
      const home = "/tmp/test-home";
      const socketPath = path.join(home, ".docker/run/docker.sock");
      const existsSync = (candidate: string) => candidate === socketPath;

      expect(
        detectDockerHost({
          env: {},
          platform: "darwin",
          home,
          existsSync,
          probeDockerHost: reachableDockerFallback,
        }),
      ).toEqual({
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
          probeDockerHost: () => ({ reachable: false, identity: "unknown" }),
        }),
      ).toBe(null);
    });

    it("preserves a reachable Docker CLI default when Docker and Podman sockets coexist (#8816)", () => {
      const sockets = new Set(["/run/user/1000/podman/podman.sock", "/var/run/docker.sock"]);
      const probes: Array<string | undefined> = [];

      expect(
        detectDockerHost({
          env: {},
          platform: "linux",
          uid: 1000,
          existsSync: (candidate) => sockets.has(candidate),
          probeDockerHost: (dockerHost) => {
            probes.push(dockerHost);
            return { reachable: true, identity: "docker" };
          },
        }),
      ).toBe(null);
      expect(probes).toEqual([undefined]);
    });

    it("skips an unreachable Podman socket and selects a reachable Docker fallback (#8816)", () => {
      const podmanSocket = "/run/user/1000/podman/podman.sock";
      const dockerSocket = "/var/run/docker.sock";
      const sockets = new Set([podmanSocket, dockerSocket]);

      expect(
        detectDockerHost({
          env: {},
          platform: "linux",
          uid: 1000,
          existsSync: (candidate) => sockets.has(candidate),
          probeDockerHost: (dockerHost) =>
            dockerHost === `unix://${dockerSocket}`
              ? { reachable: true, identity: "docker" }
              : { reachable: false, identity: "unknown" },
        }),
      ).toEqual({
        dockerHost: `unix://${dockerSocket}`,
        source: "socket",
        socketPath: dockerSocket,
      });
    });

    it("selects a reachable Podman fallback when no other Linux runtime is reachable (#8816)", () => {
      const socketPath = "/run/user/1000/podman/podman.sock";

      expect(
        detectDockerHost({
          env: {},
          platform: "linux",
          uid: 1000,
          existsSync: (candidate) => candidate === socketPath,
          probeDockerHost: (dockerHost) =>
            dockerHost
              ? { reachable: true, identity: "podman" }
              : { reachable: false, identity: "unknown" },
        }),
      ).toEqual({
        dockerHost: `unix://${socketPath}`,
        source: "socket",
        socketPath,
      });
    });

    it("does not select mixed Docker and Podman fallbacks when the default is unreachable (#8816)", () => {
      const podmanSocket = "/run/user/1000/podman/podman.sock";
      const dockerSocket = "/var/run/docker.sock";
      const sockets = new Set([podmanSocket, dockerSocket]);

      expect(
        detectDockerHost({
          env: {},
          platform: "linux",
          uid: 1000,
          existsSync: (candidate) => sockets.has(candidate),
          probeDockerHost: (dockerHost) =>
            dockerHost
              ? dockerHost.includes("podman")
                ? { reachable: true, identity: "podman" }
                : { reachable: true, identity: "docker" }
              : { reachable: false, identity: "unknown" },
        }),
      ).toBe(null);
    });

    it("does not select a reachable fallback with an unknown engine identity (#8816)", () => {
      const socketPath = "/var/run/docker.sock";

      expect(
        detectDockerHost({
          env: {},
          platform: "linux",
          uid: 1000,
          existsSync: (candidate) => candidate === socketPath,
          probeDockerHost: (dockerHost) => ({
            reachable: Boolean(dockerHost),
            identity: "unknown",
          }),
        }),
      ).toBe(null);
    });

    it("preserves a reachable Docker context and config before local socket fallbacks (#8816)", () => {
      const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-authority-"));
      try {
        const docker = path.join(fixtureDir, "docker");
        const dockerConfig = path.join(fixtureDir, "docker-config");
        mkdirSync(dockerConfig);
        writeFileSync(
          path.join(dockerConfig, "config.json"),
          JSON.stringify({ currentContext: "healthy-context" }),
        );
        writeFileSync(
          docker,
          [
            "#!/bin/sh",
            'test "$1" = "version" || exit 2',
            'if test -z "${DOCKER_HOST:-}"; then',
            '  test "${DOCKER_CONTEXT:-}" = "healthy-context" || exit 4',
            `  test "\${DOCKER_CONFIG:-}" = "${dockerConfig}" || exit 7`,
            '  test -f "$DOCKER_CONFIG/config.json" || exit 8',
            "else",
            '  test -z "${DOCKER_CONTEXT:-}" || exit 6',
            '  test -z "${DOCKER_CONFIG:-}" || exit 9',
            "fi",
            'test -z "${NVIDIA_INFERENCE_API_KEY:-}" || exit 5',
            'printf \'%s\\n\' \'{"Server":{"Platform":{"Name":"Docker Engine - Community"}}}\'',
          ].join("\n"),
        );
        chmodSync(docker, 0o755);

        expect(
          detectDockerHost({
            env: {
              HOME: fixtureDir,
              PATH: fixtureDir,
              DOCKER_CONFIG: dockerConfig,
              DOCKER_CONTEXT: "healthy-context",
              NVIDIA_INFERENCE_API_KEY: "test-secret-must-not-cross-probe-boundary",
            },
            platform: "linux",
            uid: 1000,
            existsSync: (candidate) =>
              candidate === "/run/user/1000/podman/podman.sock" ||
              candidate === "/var/run/docker.sock",
          }),
        ).toBe(null);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("classifyDockerVersionIdentity", () => {
    it("identifies Docker from the server platform", () => {
      expect(
        classifyDockerVersionIdentity(
          JSON.stringify({ Server: { Platform: { Name: "Docker Engine - Community" } } }),
        ),
      ).toBe("docker");
    });

    it("identifies Podman from the server components", () => {
      expect(
        classifyDockerVersionIdentity(
          JSON.stringify({ Server: { Components: [{ Name: "Podman Engine" }] } }),
        ),
      ).toBe("podman");
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

  describe("containerCanReachHostLoopback", () => {
    it("only returns true under WSL + Docker Desktop (the bridged topology)", () => {
      expect(containerCanReachHostLoopback("docker-desktop", { isWsl: true })).toBe(true);
    });

    it("returns false for WSL with native dockerd (#3695)", () => {
      expect(containerCanReachHostLoopback("docker", { isWsl: true })).toBe(false);
    });

    it("returns false for non-WSL Docker Desktop (macOS)", () => {
      expect(containerCanReachHostLoopback("docker-desktop", { isWsl: false })).toBe(false);
    });

    it("returns false for native Linux Docker", () => {
      expect(containerCanReachHostLoopback("docker", { isWsl: false })).toBe(false);
    });

    it("returns false for non-Docker runtimes regardless of WSL", () => {
      expect(containerCanReachHostLoopback("podman", { isWsl: true })).toBe(false);
      expect(containerCanReachHostLoopback("colima", { isWsl: true })).toBe(false);
      expect(containerCanReachHostLoopback("podman", { isWsl: false })).toBe(false);
      expect(containerCanReachHostLoopback("unknown", { isWsl: true })).toBe(false);
    });
  });

  describe("detectDockerHost with Podman", () => {
    it("detects Podman socket on macOS when Colima is absent", () => {
      const home = "/tmp/test-home";
      const podmanSocket = path.join(home, ".local/share/containers/podman/machine/podman.sock");
      const existsSync = (candidate: string) => candidate === podmanSocket;

      expect(
        detectDockerHost({
          env: {},
          platform: "darwin",
          home,
          existsSync,
          probeDockerHost: (dockerHost) => ({
            reachable: Boolean(dockerHost),
            identity: "podman",
          }),
        }),
      ).toEqual({
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
      const existsSync = (candidate: string) => sockets.has(candidate);

      expect(
        detectDockerHost({
          env: {},
          platform: "darwin",
          home,
          existsSync,
          probeDockerHost: reachableDockerFallback,
        }),
      ).toEqual({
        dockerHost: `unix://${colimaSocket}`,
        source: "socket",
        socketPath: colimaSocket,
      });
    });

    it("discovers the bare ~/.colima/docker.sock layout (#3503)", () => {
      // The reporter's Colima setup puts the socket at the top-level
      // ~/.colima/docker.sock rather than under ~/.colima/default/. Before
      // this fix, detection returned null and the gateway fell back to
      // /var/run/docker.sock, breaking onboard.
      const home = "/tmp/test-home";
      const bareColimaSocket = path.join(home, ".colima/docker.sock");
      const existsSync = (candidate: string) => candidate === bareColimaSocket;

      expect(
        detectDockerHost({
          env: {},
          platform: "darwin",
          home,
          existsSync,
          probeDockerHost: reachableDockerFallback,
        }),
      ).toEqual({
        dockerHost: `unix://${bareColimaSocket}`,
        source: "socket",
        socketPath: bareColimaSocket,
      });
    });
  });
});
