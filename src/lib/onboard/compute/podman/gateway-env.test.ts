// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPersistedPodmanDriverGatewayEnv,
  buildPodmanDriverGatewayEnv,
  PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS,
} from "./gateway-env";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Podman-driver gateway environment", () => {
  it("renders an authenticated native Podman config without Docker authority", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-gateway-"));
    dirs.push(stateDir);
    const env = buildPodmanDriverGatewayEnv({
      gatewayPort: 8080,
      stateDir,
      podmanSocketPath: "/run/user/1000/podman/podman.sock",
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:abc",
    });
    const toml = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");

    expect(env).toMatchObject({
      OPENSHELL_DRIVERS: "podman",
      OPENSHELL_BIND_ADDRESS: "0.0.0.0",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
    });
    expect(env).not.toHaveProperty("DOCKER_HOST");
    expect(env.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(toml).toContain('compute_drivers = ["podman"]');
    expect(toml).toContain("[openshell.drivers.podman]");
    expect(toml).toContain('socket_path = "/run/user/1000/podman/podman.sock"');
    expect(toml).toContain('network_name = "openshell"');
    expect(toml).toContain('supervisor_image = "ghcr.io/nvidia/openshell/supervisor@sha256:abc"');
    expect(toml).not.toContain("[openshell.drivers.docker]");
    expect(PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS).not.toContain("DOCKER_HOST");
    expect(PODMAN_DRIVER_GATEWAY_RUNTIME_ENV_KEYS).toContain(
      "NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256",
    );
  });

  it("changes runtime identity when the configured Podman network changes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-gateway-network-"));
    dirs.push(stateDir);
    const common = {
      gatewayPort: 8080,
      podmanSocketPath: "/run/user/1000/podman/podman.sock",
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:abc",
    };

    const first = buildPodmanDriverGatewayEnv({
      ...common,
      stateDir,
      podmanNetworkName: "openshell-a",
    });
    const firstFingerprint = first.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256;
    const second = buildPodmanDriverGatewayEnv({
      ...common,
      stateDir,
      podmanNetworkName: "openshell-b",
    });

    expect(firstFingerprint).not.toBe(second.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256);
  });

  it("reconstructs persisted runtime identity without rewriting gateway config", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-recovery-"));
    dirs.push(stateDir);
    const configPath = path.join(stateDir, "openshell-gateway.toml");
    const initial = buildPodmanDriverGatewayEnv({
      gatewayPort: 8443,
      podmanSocketPath: "/run/user/1001/podman/podman.sock",
      stateDir,
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
    });
    const initialConfig = fs.readFileSync(configPath);
    const initialConfigStat = fs.statSync(configPath);
    const env = buildPersistedPodmanDriverGatewayEnv({
      configSha256: initial.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256,
      gatewayPort: 8443,
      podmanSocketPath: "/run/user/1001/podman/podman.sock",
      stateDir,
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
    });

    expect(env).toMatchObject({
      NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256: initial.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256,
      OPENSHELL_GATEWAY_CONFIG: configPath,
      OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      OPENSHELL_SERVER_PORT: "8443",
      OPENSHELL_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
    });
    expect(fs.readFileSync(configPath)).toEqual(initialConfig);
    expect(fs.statSync(configPath).mtimeMs).toBe(initialConfigStat.mtimeMs);
  });

  it("rejects persisted config whose content no longer matches the protected binding", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-tamper-"));
    dirs.push(stateDir);
    const initial = buildPodmanDriverGatewayEnv({
      gatewayPort: 8443,
      podmanSocketPath: "/run/user/1001/podman/podman.sock",
      stateDir,
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
    });
    fs.appendFileSync(path.join(stateDir, "openshell-gateway.toml"), "\n# tampered\n");

    expect(() =>
      buildPersistedPodmanDriverGatewayEnv({
        configSha256: initial.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256,
        gatewayPort: 8443,
        podmanSocketPath: "/run/user/1001/podman/podman.sock",
        stateDir,
        supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
      }),
    ).toThrow("does not match its protected fingerprint");
  });

  it("rejects a symlinked persisted gateway config before reading it", () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-source-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-symlink-"));
    dirs.push(sourceDir, stateDir);
    const initial = buildPodmanDriverGatewayEnv({
      gatewayPort: 8443,
      podmanSocketPath: "/run/user/1001/podman/podman.sock",
      stateDir: sourceDir,
      supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
    });
    fs.symlinkSync(
      path.join(sourceDir, "openshell-gateway.toml"),
      path.join(stateDir, "openshell-gateway.toml"),
    );

    expect(() =>
      buildPersistedPodmanDriverGatewayEnv({
        configSha256: initial.NEMOCLAW_MANAGED_GATEWAY_CONFIG_SHA256,
        gatewayPort: 8443,
        podmanSocketPath: "/run/user/1001/podman/podman.sock",
        stateDir,
        supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:def",
      }),
    ).toThrow("unavailable or unsafe");
  });
});
