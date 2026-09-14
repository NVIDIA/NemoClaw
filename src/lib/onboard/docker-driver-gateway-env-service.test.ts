// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { writeSafeGatewayAuthConfig } from "../../../test/support/docker-driver-gateway-env-test-support";
import { startPackageManagedDockerDriverGatewayWithEnvOverride } from "./docker-driver-gateway-env";
import type { OpenShellGatewayUserServiceOptions } from "./docker-driver-gateway-service";

function homeEnv(home: string, xdgConfigHome = ""): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv;
}

describe("package-managed Docker-driver gateway env service", () => {
  it("passes the selected OpenShell env to package service startup (#10514)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_DISABLE_TLS", "1");
    vi.stubEnv("OPENSHELL_DISABLE_GATEWAY_AUTH", "1");
    const selectedEnv: NodeJS.ProcessEnv = {
      HOME: tempHome,
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "nemoclaw",
      OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      OPENSHELL_WORKSPACE: "default",
    };
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const startService = vi.fn((options) => {
      const serviceOptions = options as OpenShellGatewayUserServiceOptions;
      observedEnv = serviceOptions.env;
      serviceOptions.prepareServiceEnv?.();
      return { attempted: true, started: true };
    });

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: selectedEnv,
          exitOnFailure: false,
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
          startOpenShellGatewayUserService: startService,
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(observedEnv).toEqual(selectedEnv);
      expect(observedEnv).toEqual(
        expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw",
          OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
          OPENSHELL_WORKSPACE: "default",
        }),
      );
      expect(observedEnv?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
      expect(observedEnv?.OPENSHELL_TOKEN).toBeUndefined();
      expect(observedEnv?.OPENSHELL_DISABLE_TLS).toBeUndefined();
      expect(observedEnv?.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("stages the service and writes its env under one XDG config root (#6903)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const configHome = path.join(tempHome, "xdg-config");
    const dockerHost = `unix://${path.join(tempHome, ".colima", "default", "docker.sock")}`;
    const env = { ...homeEnv(tempHome, configHome), DOCKER_HOST: dockerHost };
    const envFile = path.join(configHome, "openshell", "gateway.env");

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env,
          exitOnFailure: false,
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
            return { attempted: true, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).resolves.toBe(true);

      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1\n");
      expect(fs.readFileSync(envFile, "utf-8")).toContain("OPENSHELL_SERVER_PORT=8080\n");
      expect(fs.readFileSync(envFile, "utf-8")).toContain(`DOCKER_HOST='${dockerHost}'\n`);
      expect(fs.existsSync(path.join(tempHome, ".config", "openshell", "gateway.env"))).toBe(false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([
    ["a TCP Docker endpoint", "tcp://attacker.example:2375"],
    ["an SSH Docker endpoint", "ssh://docker.example"],
    ["a relative Unix socket", "unix://relative/docker.sock"],
    ["a Unix socket with a single quote", "unix:///tmp/docker's.sock"],
    ["a Unix socket with a trailing newline", "unix:///tmp/docker.sock\n"],
  ])("rejects %s for a package service (#6903)", async (_case, dockerHost) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
    const startService = vi.fn((opts?: { prepareServiceEnv?: () => void }) => {
      opts?.prepareServiceEnv?.();
      return { attempted: true, started: true };
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

  it("rejects a symlinked package-service environment file (#6903)", async () => {
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
            return { attempted: true, started: true };
          },
          verifySandboxBridgeGatewayReachableOrExit: async () => undefined,
        }),
      ).rejects.toMatchObject({
        name: "OpenShellGatewayServiceEnvironmentError",
        cause: expect.objectContaining({
          message: expect.stringContaining(
            "Refusing to write symlinked OpenShell gateway env file",
          ),
        }),
      });

      expect(fs.readFileSync(targetFile, "utf-8")).toBe("KEEP_ME=1\n");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("leaves custom gateway ports on standalone lifecycle ownership (#6903)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const startService = vi.fn();

    try {
      await expect(
        startPackageManagedDockerDriverGatewayWithEnvOverride({
          clearDockerDriverGatewayRuntimeFiles: vi.fn(),
          env: homeEnv(tempHome),
          exitOnFailure: false,
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
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("rejects package-managed wildcard binds before writing the service env (#6903)", () => {
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

  it.each(["signing_key_path", "public_key_path", "kid_path", "gateway_id", "ttl_secs"])(
    "rejects incomplete gateway JWT config before writing env or starting the service [%s] (#6903)",
    (key) => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
      const envFile = path.join(tempHome, ".config", "openshell", "gateway.env");
      const startService = vi.fn();
      const env = homeEnv(tempHome);
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
      try {
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

        expect(startService).not.toHaveBeenCalled();
        expect(fs.existsSync(envFile)).toBe(false);
      } finally {
        homedirSpy.mockRestore();
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    },
  );
});
