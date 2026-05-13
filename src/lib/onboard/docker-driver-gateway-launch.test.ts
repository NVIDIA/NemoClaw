// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDockerDriverGatewayLaunch,
  parseGlibcVersionsFromBinaryText,
  shouldUseContainerizedGateway,
} from "../../../dist/lib/onboard/docker-driver-gateway-launch";

function withTempBinaries<T>(fn: (paths: { dir: string; gatewayBin: string; sandboxBin: string }) => T): T {
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

  it("selects the containerized gateway only for affected Linux hosts or explicit force", () => {
    expect(
      shouldUseContainerizedGateway({
        gatewayBin: "/tmp/openshell-gateway",
        platform: "linux",
        env: {},
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

  it("builds a Docker-hosted gateway launch that preserves Docker-driver env", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir);
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        gatewayEnv: {
          OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
          OPENSHELL_DRIVERS: "docker",
        },
      });

      expect(launch.mode).toBe("container");
      expect(launch.command).toBe("docker");
      expect(launch.processGatewayBin).toBeNull();
      expect(launch.args).toEqual(
        expect.arrayContaining([
          "run",
          "--rm",
          "--name",
          "nemoclaw-openshell-gateway",
          "--network",
          "host",
          "--volume",
          `${gatewayBin}:/opt/nemoclaw/openshell-gateway:ro`,
          "--volume",
          `${stateDir}:${stateDir}:rw`,
          "--volume",
          `${dir}:${dir}:ro`,
          "--env",
          "OPENSHELL_DRIVERS",
          "--env",
          "OPENSHELL_DOCKER_SUPERVISOR_BIN",
          "ubuntu:24.04",
          "/opt/nemoclaw/openshell-gateway",
        ]),
      );
      expect(launch.env.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBe(sandboxBin);
      expect(launch.env.OPENSHELL_BIND_ADDRESS).toBe("0.0.0.0");
    });
  });

  it("allows the compatibility gateway bind address to be forced back to loopback", () => {
    withTempBinaries(({ dir, gatewayBin, sandboxBin }) => {
      const stateDir = path.join(dir, "state");
      fs.mkdirSync(stateDir);
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_BIND_ADDRESS: "127.0.0.1",
        },
        gatewayEnv: {
          OPENSHELL_BIND_ADDRESS: "127.0.0.1",
          OPENSHELL_DRIVERS: "docker",
        },
      });

      expect(launch.mode).toBe("container");
      expect(launch.env.OPENSHELL_BIND_ADDRESS).toBe("127.0.0.1");
    });
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
});
