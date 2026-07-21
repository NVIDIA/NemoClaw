// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { writeSafeGatewayAuthConfig } from "../../../test/support/docker-driver-gateway-env-test-support";
import { startPackageManagedDockerDriverGatewayWithEnvOverride } from "./docker-driver-gateway-env";

function homeEnv(home: string, xdgConfigHome = ""): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv;
}

describe("package-managed Docker-driver gateway env service", () => {
  it("writes the service env only when package-managed startup prepares the service", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const dockerHost = `unix://${path.join(tempHome, ".colima", "default", "docker.sock")}`;
    const env = { ...homeEnv(tempHome), DOCKER_HOST: dockerHost };
    const gatewayBin = path.join(tempHome, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env,
          exitOnFailure: false,
          gatewayBin,
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
            OPENSHELL_SERVER_PORT: "8080",
          },
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
            return { attempted: true, fallbackAllowed: false, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1\n");
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_SERVER_PORT=8080\n");
      expect(fs.readFileSync(envFile, "utf-8")).toContain(`DOCKER_HOST='${dockerHost}'\n`);
    } finally {
      existsSpy.mockRestore();
      homedirSpy.mockRestore();
      platformSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([
    "tcp://attacker.example:2375",
    "ssh://docker.example",
    "unix://relative/docker.sock",
    "unix:///tmp/docker's.sock",
  ])("rejects unsafe package-service Docker endpoint %s", async (dockerHost) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const startService = vi.fn((opts?: { prepareServiceEnv?: () => void }) => {
      opts?.prepareServiceEnv?.();
      return { attempted: true, fallbackAllowed: false, started: true };
    });

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: { ...homeEnv(tempHome), DOCKER_HOST: dockerHost },
          exitOnFailure: false,
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
          },
          gatewayName: "nemoclaw",
          hasOpenShellGatewayUserService: () => true,
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: () => "",
          skipSandboxBridgeReachability: false,
          startOpenShellGatewayUserService: startService,
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).rejects.toThrow(/only safely serializable absolute unix:\/\/ Docker sockets are supported/);

      expect(startService).toHaveBeenCalledOnce();
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked package-service environment file", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envDir = path.join(tempHome, ".config", "openshell");
    const envFile = path.join(envDir, "gateway.env");
    const targetFile = path.join(tempHome, "foreign.env");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(targetFile, "KEEP_ME=1\n");
    fs.symlinkSync(targetFile, envFile);

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: homeEnv(tempHome),
          exitOnFailure: false,
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
            OPENSHELL_SERVER_PORT: "8080",
          },
          gatewayName: "nemoclaw",
          hasOpenShellGatewayUserService: () => true,
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: () => "",
          skipSandboxBridgeReachability: false,
          startOpenShellGatewayUserService: (opts) => {
            opts?.prepareServiceEnv?.();
            return { attempted: true, fallbackAllowed: false, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).rejects.toThrow("Refusing to write symlinked OpenShell gateway env file");

      expect(fs.readFileSync(targetFile, "utf-8")).toBe("KEEP_ME=1\n");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("leaves remote Docker endpoints to standalone fallback when no package service exists", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const startService = vi.fn();

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: { ...homeEnv(tempHome), DOCKER_HOST: "ssh://docker.example" },
          exitOnFailure: false,
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
          },
          gatewayName: "nemoclaw",
          hasOpenShellGatewayUserService: () => false,
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: () => "",
          skipSandboxBridgeReachability: false,
          startOpenShellGatewayUserService: startService,
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(false);

      expect(startService).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("leaves custom gateway ports on standalone lifecycle ownership", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const servicePath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const startService = vi.fn();

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: homeEnv(tempHome),
          exitOnFailure: false,
          gatewayBin: path.join(tempHome, ".local", "bin", "openshell-gateway"),
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
            OPENSHELL_SERVER_PORT: "18080",
          },
          gatewayName: "nemoclaw-18080",
          hasOpenShellGatewayUserService: () => true,
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: () => "",
          skipSandboxBridgeReachability: false,
          startOpenShellGatewayUserService: startService,
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(false);

      expect(startService).not.toHaveBeenCalled();
      expect(fs.existsSync(servicePath)).toBe(false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fails when the default Linux service cannot be staged from a trusted binary", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    try {
      expect(() =>
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: homeEnv(tempHome),
          exitOnFailure: false,
          gatewayBin: "/opt/foreign/openshell-gateway",
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
            OPENSHELL_SERVER_PORT: "8080",
          },
          gatewayName: "nemoclaw",
          registerDockerDriverGatewayEndpoint: () => true,
          runCaptureOpenshell: () => "",
          skipSandboxBridgeReachability: false,
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).toThrow(/could not be staged.*not in a trusted install path/);
    } finally {
      platformSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("uses one XDG config root for the service unit and gateway env", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const configHome = path.join(tempHome, "xdg-config");
    const env = homeEnv(tempHome, configHome);
    const gatewayBin = path.join(tempHome, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      configHome,
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const envFile = path.join(configHome, "openshell", "gateway.env");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env,
          exitOnFailure: false,
          gatewayBin,
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "127.0.0.1",
            OPENSHELL_GATEWAY_CONFIG: writeSafeGatewayAuthConfig(tempHome),
            OPENSHELL_SERVER_PORT: "8080",
          },
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
            return { attempted: true, fallbackAllowed: false, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_SERVER_PORT=8080\n");
      expect(fs.existsSync(path.join(tempHome, ".config", "openshell", "gateway.env"))).toBe(false);
    } finally {
      existsSpy.mockRestore();
      homedirSpy.mockRestore();
      platformSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects package-managed wildcard binds before writing the service env", () => {
    expect(() =>
      startPackageManagedDockerDriverGatewayWithEnvOverride({
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        exitOnFailure: false,
        gatewayEnv: {
          OPENSHELL_BIND_ADDRESS: "0.0.0.0",
          OPENSHELL_GATEWAY_CONFIG: "/tmp/openshell-gateway.toml",
        },
        gatewayName: "nemoclaw",
        hasOpenShellGatewayUserService: () => true,
        registerDockerDriverGatewayEndpoint: () => true,
        runCaptureOpenshell: () => "",
        skipSandboxBridgeReachability: false,
        verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
      }),
    ).toThrow(/not supported for the OpenShell Docker-driver gateway/);
  });

  it("rejects incomplete gateway JWT config before writing env or starting the service", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const startService = vi.fn();
    const env = homeEnv(tempHome);
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    try {
      for (const key of [
        "signing_key_path",
        "public_key_path",
        "kid_path",
        "gateway_id",
        "ttl_secs",
      ]) {
        const configPath = writeSafeGatewayAuthConfig(tempHome);
        fs.writeFileSync(
          configPath,
          fs.readFileSync(configPath, "utf-8").replace(new RegExp(`^${key} = .+\\n`, "m"), ""),
        );

        expect(() =>
          startPackageManagedDockerDriverGatewayWithEnvOverride({
            clearDockerDriverGatewayRuntimeFiles: vi.fn(),
            env,
            exitOnFailure: false,
            gatewayEnv: {
              OPENSHELL_BIND_ADDRESS: "127.0.0.1",
              OPENSHELL_GATEWAY_CONFIG: configPath,
            },
            gatewayName: "nemoclaw",
            hasOpenShellGatewayUserService: () => true,
            registerDockerDriverGatewayEndpoint: () => true,
            runCaptureOpenshell: () => "",
            skipSandboxBridgeReachability: false,
            startOpenShellGatewayUserService: startService,
            verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
          }),
        ).toThrow(new RegExp(`gateway_jwt\\.${key}`));
      }

      expect(startService).not.toHaveBeenCalled();
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
