// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDockerDriverGatewayConfigToml,
  buildDockerDriverGatewayLaunch,
  buildDockerDriverGatewayRuntimeIdentity,
  parseGlibcVersionsFromBinaryText,
  resolveDriftGatewayBin,
  shouldUseContainerizedGateway,
} from "./docker-driver-gateway-launch";

function withTempBinaries<T>(
  fn: (paths: { dir: string; gatewayBin: string; sandboxBin: string }) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-launch-"));
  const gatewayBin = path.join(dir, "openshell-gateway");
  const sandboxBin = path.join(dir, "openshell-sandbox");
  try {
    fs.writeFileSync(gatewayBin, "GLIBC_2.39\n", { mode: 0o755 });
    fs.writeFileSync(sandboxBin, "#!/bin/sh\n", { mode: 0o755 });
    return fn({ dir, gatewayBin, sandboxBin });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("docker-driver-gateway-launch", () => {
  it("extracts GLIBC versions from binary text", () => {
    expect(parseGlibcVersionsFromBinaryText("GLIBC_2.35\0GLIBC_2.39\0GLIBC_2.39")).toEqual([
      "2.35",
      "2.39",
    ]);
  });

  it("requires explicit opt-in before selecting the containerized gateway", () => {
    expect(() =>
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.38", "2.39"],
      }),
    ).toThrow(/requires explicit opt-in/);
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.38", "2.39"],
      }),
    ).toMatchObject({ useContainer: true });
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.38", "2.39"],
      }),
    ).toEqual({ useContainer: false });
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "darwin",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.39"],
      }),
    ).toEqual({ useContainer: false });
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "0" },
        hostGlibcVersion: "2.35",
        requiredGlibcVersions: ["2.39"],
      }),
    ).toEqual({ useContainer: false });
  });

  it("writes Docker driver settings in gateway TOML because OpenShell driver config is not env-backed", () => {
    const toml = buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_LOCAL_TLS_DIR: "/tmp/openshell-tls",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor:0.0.44",
      },
      "/home/shadeform/.local/bin/openshell-sandbox",
    );

    expect(toml).toContain('compute_drivers = ["docker"]');
    expect(toml).toContain('grpc_endpoint = "https://127.0.0.1:8080"');
    expect(toml).toContain('network_name = "openshell-docker"');
    expect(toml).toContain('supervisor_image = "ghcr.io/nvidia/openshell/supervisor:0.0.44"');
    expect(toml).toContain('supervisor_bin = "/home/shadeform/.local/bin/openshell-sandbox"');
  });

  it("rejects wildcard binds for direct host gateway launches", () => {
    expect(() => {
      withTempBinaries(({ dir, gatewayBin }) => {
        const stateDir = path.join(dir, "state");
        fs.mkdirSync(stateDir);
        buildDockerDriverGatewayLaunch({
          gatewayBin,
          stateDir,
          platform: "linux",
          env: {},
          hostGlibcVersion: "2.39",
          requiredGlibcVersions: ["2.39"],
          gatewayEnv: {
            OPENSHELL_BIND_ADDRESS: "0.0.0.0",
            OPENSHELL_DRIVERS: "docker",
          },
        });
      });
    }).toThrow(/not supported for the OpenShell Docker-driver gateway/);
  });

  it("uses the host binary as the drift binary outside compatibility mode", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const identity = buildDockerDriverGatewayRuntimeIdentity({
        gatewayBin,
        sandboxBin,
        stateDir: dir,
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(identity.launch?.mode).toBe("host");
      expect(identity.driftGatewayBin).toBe(gatewayBin);
      expect(identity.desiredEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBe(sandboxBin);
      expect(identity.desiredEnv.OPENSHELL_GATEWAY_CONFIG).toBe(
        path.join(dir, "openshell-gateway.toml"),
      );
      expect(resolveDriftGatewayBin(identity, gatewayBin)).toBe(gatewayBin);
    });
  });

  it("falls back to the host binary when no runtime identity is available", () => {
    expect(resolveDriftGatewayBin(null, "/opt/openshell/openshell-gateway")).toBe(
      "/opt/openshell/openshell-gateway",
    );
    expect(resolveDriftGatewayBin(null, null)).toBeNull();
  });

  it("uses the host binary when the gateway ABI is compatible", () => {
    withTempBinaries(({ dir, gatewayBin }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        stateDir: dir,
        platform: "linux",
        env: {},
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(launch).toMatchObject({
        command: gatewayBin,
        args: [],
        mode: "host",
        processGatewayBin: gatewayBin,
      });
    });
  });

  it("scrubs stale auth-disable env from direct host gateway launches", () => {
    withTempBinaries(({ dir, gatewayBin }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        stateDir: dir,
        platform: "linux",
        env: { OPENSHELL_DISABLE_GATEWAY_AUTH: "true" },
        hostGlibcVersion: "2.39",
        requiredGlibcVersions: ["2.39"],
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(launch.mode).toBe("host");
      expect(launch.env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
    });
  });
});
