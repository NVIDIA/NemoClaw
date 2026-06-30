// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGatewayDebEnvFile,
  writeDockerGatewayDebEnvOverride,
} from "./docker-driver-gateway-env";

describe("buildDockerGatewayDebEnvFile", () => {
  it("replaces all managed gateway env keys and preserves unrelated values", () => {
    const next = buildDockerGatewayDebEnvFile(
      [
        "KEEP_ME=1",
        "OPENSHELL_BIND_ADDRESS=127.0.0.1",
        "OPENSHELL_SERVER_PORT=8080",
        "OPENSHELL_DOCKER_SUPERVISOR_IMAGE=old",
      ].join("\n"),
      {
        OPENSHELL_DRIVERS: "docker",
        OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        OPENSHELL_SERVER_PORT: "8990",
        OPENSHELL_DISABLE_TLS: "true",
        OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
        OPENSHELL_DB_URL: "sqlite:/tmp/openshell.db",
        OPENSHELL_GRPC_ENDPOINT: "http://127.0.0.1:8990",
        OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
        OPENSHELL_SSH_GATEWAY_PORT: "8990",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "new",
        OPENSHELL_GATEWAY_CONFIG: "/tmp/openshell-gateway.toml",
        OPENSHELL_VM_DRIVER_STATE_DIR: "/tmp/old-vm-driver",
      },
    );

    expect(next).toContain("KEEP_ME=1\n");
    expect(next).toContain("OPENSHELL_BIND_ADDRESS=0.0.0.0\n");
    expect(next).toContain("OPENSHELL_SERVER_PORT=8990\n");
    expect(next).toContain("OPENSHELL_DOCKER_SUPERVISOR_IMAGE=new\n");
    expect(next).toContain("OPENSHELL_GATEWAY_CONFIG=/tmp/openshell-gateway.toml\n");
    expect(next).toContain("OPENSHELL_VM_DRIVER_STATE_DIR=/tmp/old-vm-driver\n");
    expect(next).not.toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1");
    expect(next).not.toContain("OPENSHELL_DOCKER_SUPERVISOR_IMAGE=old");
  });

  it("removes stale VM driver env keys when writing a Docker-driver env file", () => {
    const next = buildDockerGatewayDebEnvFile(
      [
        "OPENSHELL_DRIVERS=vm",
        "OPENSHELL_VM_DRIVER_STATE_DIR=/tmp/old-vm-driver",
        "OPENSHELL_DRIVER_DIR=/tmp/old-driver-dir",
      ].join("\n"),
      {
        OPENSHELL_DRIVERS: "docker",
      },
    );

    expect(next).toBe("OPENSHELL_DRIVERS=docker\n");
  });

  it("removes stale auth-disable env so OpenShell 0.0.72 TOML auth policy stays authoritative", () => {
    const next = buildDockerGatewayDebEnvFile(
      [
        "KEEP_ME=1",
        "OPENSHELL_DISABLE_GATEWAY_AUTH=true",
        "OPENSHELL_GATEWAY_CONFIG=/tmp/old-gateway.toml",
      ].join("\n"),
      {
        OPENSHELL_DRIVERS: "docker",
        OPENSHELL_GATEWAY_CONFIG: "/tmp/new-gateway.toml",
      },
    );

    expect(next).toContain("KEEP_ME=1\n");
    expect(next).toContain("OPENSHELL_DRIVERS=docker\n");
    expect(next).toContain("OPENSHELL_GATEWAY_CONFIG=/tmp/new-gateway.toml\n");
    expect(next).not.toContain("OPENSHELL_DISABLE_GATEWAY_AUTH");
    expect(next).not.toContain("OPENSHELL_GATEWAY_CONFIG=/tmp/old-gateway.toml");
  });

  it("rejects multiline managed values", () => {
    expect(() =>
      buildDockerGatewayDebEnvFile("", {
        OPENSHELL_BIND_ADDRESS: "127.0.0.1\nINJECTED=1",
      }),
    ).toThrow("line break");
  });
});

describe("writeDockerGatewayDebEnvOverride", () => {
  it("enforces restrictive permissions on an existing env directory and file", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const envDir = path.join(tempHome, ".config", "openshell");
    const envFile = path.join(envDir, "gateway.env");
    fs.mkdirSync(envDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(envDir, 0o755);
    fs.writeFileSync(envFile, "KEEP_ME=1\n", { mode: 0o644 });
    fs.chmodSync(envFile, 0o644);

    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation(
        (candidate) => candidate === "/usr/lib/systemd/user/openshell-gateway.service",
      );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      const wrote = writeDockerGatewayDebEnvOverride(
        () => ({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
        }),
        { platform: "linux" },
      );

      const envFileContent = fs.readFileSync(envFile, "utf-8");
      expect(wrote).toBe(true);
      expect(fs.statSync(envDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
      expect(envFileContent).toContain("KEEP_ME=1\n");
      expect(envFileContent).toContain("OPENSHELL_BIND_ADDRESS=127.0.0.1\n");
    } finally {
      existsSpy.mockRestore();
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("does not write service env for standalone gateway binaries", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-env-"));
    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((candidate) => candidate === "/usr/bin/openshell-gateway");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    try {
      const wrote = writeDockerGatewayDebEnvOverride(
        () => ({
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
        }),
        { platform: "linux" },
      );

      expect(wrote).toBe(false);
      expect(fs.existsSync(path.join(tempHome, ".config", "openshell", "gateway.env"))).toBe(false);
    } finally {
      existsSpy.mockRestore();
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
