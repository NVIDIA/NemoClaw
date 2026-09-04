// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { writeOpenShell0044PreAuthState } from "../../../test/support/openshell-gateway-config-helpers";

import {
  buildDockerDriverGatewayEnv,
  buildDockerGatewayDebEnvFile,
  startPackageManagedDockerDriverGatewayWithEnvOverride,
  writeDockerGatewayDebEnvOverride,
} from "./docker-driver-gateway-env";
import { PORTABLE_HOST_GATEWAY_IP } from "./experimental/portable-profile";

function homeEnv(home: string, xdgConfigHome = ""): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv;
}

function trustedPackageServiceOptions(home: string) {
  return {
    env: homeEnv(home),
    getUpstreamGatewayVersion: () => "openshell-gateway 0.0.85",
    getUpstreamGatewayVersionBounds: () => ({ max: "0.0.85", min: "0.0.85" }),
    platform: "linux" as const,
    spawnSyncImpl: () => ({
      status: 0,
      stdout: [
        "FragmentPath=/usr/lib/systemd/user/openshell-gateway.service",
        "ExecStart={ path=/usr/bin/openshell-gateway ; argv[]=/usr/bin/openshell-gateway ; }",
      ].join("\n"),
    }),
  };
}

describe("buildDockerDriverGatewayEnv", () => {
  it("uses the shared configured Docker network authority (#9461)", () => {
    vi.stubEnv("OPENSHELL_DOCKER_NETWORK_NAME", "openshell-portable-proof");

    const env = buildDockerDriverGatewayEnv({
      platform: "linux",
      stateDir: "/tmp/nemoclaw-gateway-network-authority",
      getDockerSupervisorImage: () => "supervisor:test",
      resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
    });

    expect(env.OPENSHELL_DOCKER_NETWORK_NAME).toBe("openshell-portable-proof");
    vi.unstubAllEnvs();
  });

  it("sets Docker-driver gateway networking from NemoClaw configuration", () => {
    const env = buildDockerDriverGatewayEnv({
      platform: "linux",
      stateDir: "/tmp/nemoclaw-gateway",
      getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
    });

    expect(env).toMatchObject({
      OPENSHELL_DRIVERS: "docker",
      OPENSHELL_BIND_ADDRESS: "127.0.0.1",
      OPENSHELL_SERVER_PORT: "8080",
      OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/nemoclaw-gateway/tls",
      OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
      OPENSHELL_SSH_GATEWAY_PORT: "8080",
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      OPENSHELL_DOCKER_SUPERVISOR_BIN: "/usr/bin/openshell-sandbox",
      OPENSHELL_GATEWAY_CONFIG: "/tmp/nemoclaw-gateway/openshell-gateway.toml",
    });
    expect(env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
  });

  it("uses the Docker driver on macOS without VM helper state", () => {
    const env = buildDockerDriverGatewayEnv({
      platform: "darwin",
      architecture: "arm64",
      stateDir: "/tmp/nemoclaw-gateway",
      getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      resolveSandboxBin: () => "/usr/local/bin/openshell-sandbox",
    });

    expect(env).toMatchObject({
      OPENSHELL_DRIVERS: "docker",
      OPENSHELL_BIND_ADDRESS: "127.0.0.1",
      OPENSHELL_SERVER_PORT: "8080",
      OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
      OPENSHELL_LOCAL_TLS_DIR: "/tmp/nemoclaw-gateway/tls",
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.37",
      OPENSHELL_GATEWAY_CONFIG: "/tmp/nemoclaw-gateway/openshell-gateway.toml",
    });
    expect(env.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBeUndefined();
    expect(env.OPENSHELL_VM_DRIVER_STATE_DIR).toBeUndefined();
    expect(env.OPENSHELL_DRIVER_DIR).toBeUndefined();
  });

  it("admits a prepared v0.0.44 pre-auth database only under installer restore authority", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-v0-0-44-"));
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "1");
    try {
      writeOpenShell0044PreAuthState(stateDir);

      const env = buildDockerDriverGatewayEnv({
        platform: "linux",
        stateDir,
        getDockerSupervisorImage: () => "supervisor:test",
        resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
      });

      expect(fs.existsSync(env.OPENSHELL_GATEWAY_CONFIG)).toBe(true);
      expect(fs.readFileSync(path.join(stateDir, "openshell.db"), "utf-8")).toBe("legacy-database");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a prepared v0.0.44 pre-auth database without installer restore authority", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-denied-"));
    vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "0");
    try {
      writeOpenShell0044PreAuthState(stateDir);

      expect(() =>
        buildDockerDriverGatewayEnv({
          platform: "linux",
          stateDir,
          getDockerSupervisorImage: () => "supervisor:test",
          resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
        }),
      ).toThrow(/durable gateway state exists without a config/);
      expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("builds the exact rootless gateway network contract for the portable profile", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker");
    vi.stubEnv("CONTAINERS_CONF", "/tmp/nemoclaw-portable/containers.conf");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-gateway-"));
    try {
      const env = buildDockerDriverGatewayEnv({
        platform: "linux",
        stateDir,
        podmanSocketPath: "/run/user/1001/podman/podman.sock",
        getDockerSupervisorImage: () => "supervisor:test",
        resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
      });
      expect(env).toMatchObject({
        OPENSHELL_DRIVERS: "podman",
        CONTAINERS_CONF: "/tmp/nemoclaw-portable/containers.conf",
        OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        OPENSHELL_GRPC_ENDPOINT: `https://${PORTABLE_HOST_GATEWAY_IP}:8080`,
        NETAVARK_FW: "iptables",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      });
      const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      expect(toml).toContain('compute_drivers = ["podman"]');
      expect(toml).toContain("[openshell.drivers.podman]");
      expect(toml).toContain(`host_gateway_ip = "${PORTABLE_HOST_GATEWAY_IP}"`);
      expect(toml).toContain('socket_path = "/run/user/1001/podman/podman.sock"');
      expect(toml).not.toContain("supervisor_bin");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("selects the native Podman gateway without changing portable-only environment", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    vi.stubEnv("CONTAINERS_CONF", "/tmp/nemoclaw-portable/containers.conf");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-podman-gateway-"));
    try {
      const env = buildDockerDriverGatewayEnv({
        platform: "linux",
        stateDir,
        getDockerSupervisorImage: () => "supervisor:test",
        resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
      });
      expect(env).toMatchObject({
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        OPENSHELL_GRPC_ENDPOINT: `https://${PORTABLE_HOST_GATEWAY_IP}:8080`,
      });
      expect(path.isAbsolute(env.OPENSHELL_PODMAN_SOCKET)).toBe(true);
      expect(env.OPENSHELL_PODMAN_SOCKET).toMatch(/\/podman\/podman\.sock$/u);
      expect(env.CONTAINERS_CONF).toBeUndefined();
      expect(env.NETAVARK_FW).toBeUndefined();
      const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      expect(toml).toContain('compute_drivers = ["podman"]');
      expect(toml).toContain(`socket_path = "${env.OPENSHELL_PODMAN_SOCKET}"`);
      expect(toml).not.toContain("supervisor_bin");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["a relative path", "run/user/1001/podman/podman.sock"],
    ["trailing whitespace", "/run/user/1001/podman/podman.sock "],
    ["an embedded newline", "/run/user/1001/podman/podman.sock\nOPENSHELL_DISABLE_TLS=true"],
    ["a parent-directory segment", "/run/user/1001/../1002/podman/podman.sock"],
    ["an empty value", ""],
  ])("rejects a Podman socket path with %s", (_label, podmanSocketPath) => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-gateway-invalid-"));
    try {
      expect(() =>
        buildDockerDriverGatewayEnv({
          platform: "linux",
          stateDir,
          podmanSocketPath,
          getDockerSupervisorImage: () => "supervisor:test",
          resolveSandboxBin: () => "/usr/bin/openshell-sandbox",
        }),
      ).toThrow("OpenShell Podman gateway socket must be a safe normalized absolute path");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("writeDockerGatewayDebEnvOverride", () => {
  it("rejects an env file swapped to a symlink after opening without writing its target", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envDir = path.join(tempHome, ".config", "openshell");
    const envFile = path.join(envDir, "gateway.env");
    const targetFile = path.join(tempHome, "foreign.env");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(envFile, "KEEP_ME=1\n");
    fs.writeFileSync(targetFile, "FOREIGN=1\n");

    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation(
        (candidate) => candidate === "/usr/lib/systemd/user/openshell-gateway.service",
      );
    const openSync = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementationOnce(((...args) => {
      expect(args[0]).toBe(envFile);
      const descriptor = openSync(...(args as Parameters<typeof fs.openSync>));
      fs.unlinkSync(envFile);
      fs.symlinkSync(targetFile, envFile);
      return descriptor;
    }) as typeof fs.openSync);

    try {
      expect(() =>
        writeDockerGatewayDebEnvOverride(
          () => ({
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          }),
          trustedPackageServiceOptions(tempHome),
        ),
      ).toThrow("regular file changed during validation");

      expect(fs.lstatSync(envFile).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetFile, "utf-8")).toBe("FOREIGN=1\n");
    } finally {
      openSpy.mockRestore();
      existsSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("uses the provided HOME as the config root fallback when XDG_CONFIG_HOME is unset", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-home-"));
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation(
        (candidate) => candidate === "/usr/lib/systemd/user/openshell-gateway.service",
      );

    try {
      const wrote = writeDockerGatewayDebEnvOverride(
        () => ({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
        }),
        trustedPackageServiceOptions(tempHome),
      );

      expect(wrote).toBe(true);
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1\n");
    } finally {
      existsSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("writes the service env only when package-managed startup prepares the service", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const gatewayEnv = buildDockerDriverGatewayEnv({
      platform: "darwin",
      architecture: "arm64",
      stateDir: path.join(tempHome, "state"),
      getDockerSupervisorImage: () => "ghcr.io/nvidia/openshell/supervisor:0.0.72",
      resolveSandboxBin: () => null,
    });
    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation(
        (candidate) => candidate === "/usr/lib/systemd/user/openshell-gateway.service",
      );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: homeEnv(tempHome),
          exitOnFailure: false,
          gatewayEnv,
          gatewayName: "nemoclaw",
          hasOpenShellGatewayUserService: () => true,
          isDockerDriverGatewayReady: async () => true,
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: (args) =>
            args[0] === "status"
              ? "Gateway: nemoclaw\nConnected"
              : "Gateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080/",
          skipSandboxBridgeReachability: false,
          startOpenShellGatewayUserService: (opts) => {
            opts?.prepareServiceEnv?.();
            return { attempted: true, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1\n");
      expect(fs.readFileSync(envFile, "utf-8")).toContain(
        `OPENSHELL_GATEWAY_CONFIG=${gatewayEnv.OPENSHELL_GATEWAY_CONFIG}\n`,
      );
    } finally {
      existsSpy.mockRestore();
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
