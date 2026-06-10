// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_PORT } from "../../../dist/lib/core/ports";
import { buildDockerDriverGatewayLaunch } from "../../../dist/lib/onboard/docker-driver-gateway-launch";
import {
  getDockerDriverGatewayRuntimeMarkerDriftForStateDir,
  getDockerDriverGatewayRuntimeMarkerPath,
  readDockerDriverGatewayRuntimeMarker,
  writeDockerDriverGatewayRuntimeMarkerForStateDir,
} from "../../../dist/lib/onboard/docker-driver-gateway-runtime-marker";
import {
  BASE_GATEWAY_COMPAT_CONTAINER_NAME,
  BASE_GATEWAY_NAME,
  BASE_GATEWAY_STATE_DIR_NAME,
  resolveGatewayCompatContainerName,
  resolveGatewayName,
  resolveGatewayStateDirName,
} from "../../../dist/lib/onboard/gateway-binding";

describe("gateway-binding resolver (#4422)", () => {
  it("keeps the bare nemoclaw names for the default gateway port", () => {
    expect(resolveGatewayName(DEFAULT_GATEWAY_PORT)).toBe(BASE_GATEWAY_NAME);
    expect(resolveGatewayStateDirName(DEFAULT_GATEWAY_PORT)).toBe(BASE_GATEWAY_STATE_DIR_NAME);
    expect(resolveGatewayCompatContainerName(DEFAULT_GATEWAY_PORT)).toBe(
      BASE_GATEWAY_COMPAT_CONTAINER_NAME,
    );
  });

  it("suffixes the name, state dir, and compat container for a non-default port", () => {
    expect(resolveGatewayName(8081)).toBe("nemoclaw-8081");
    expect(resolveGatewayStateDirName(8081)).toBe("openshell-docker-gateway-8081");
    expect(resolveGatewayCompatContainerName(8081)).toBe("nemoclaw-openshell-gateway-8081");
  });

  it("derives distinct bindings for two different gateway ports", () => {
    const a = 8080;
    const b = 8081;
    expect(resolveGatewayName(a)).not.toBe(resolveGatewayName(b));
    expect(resolveGatewayStateDirName(a)).not.toBe(resolveGatewayStateDirName(b));
    expect(resolveGatewayCompatContainerName(a)).not.toBe(resolveGatewayCompatContainerName(b));
  });
});

describe("docker-driver compat container is gateway-port scoped (#4422)", () => {
  function withTempState<T>(
    fn: (paths: { gatewayBin: string; sandboxBin: string; stateDir: string }) => T,
  ): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-binding-"));
    const gatewayBin = path.join(dir, "openshell-gateway");
    const sandboxBin = path.join(dir, "openshell-sandbox");
    const stateDir = path.join(dir, "state");
    try {
      fs.writeFileSync(gatewayBin, "GLIBC_2.39\n", { mode: 0o755 });
      fs.writeFileSync(sandboxBin, "#!/bin/sh\n", { mode: 0o755 });
      fs.mkdirSync(stateDir);
      return fn({ gatewayBin, sandboxBin, stateDir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("names the compat container per gateway port so a second sandbox does not target the first container", () => {
    withTempState(({ gatewayBin, sandboxBin, stateDir }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
        compatContainerName: resolveGatewayCompatContainerName(8081),
      });

      expect(launch.mode).toBe("container");
      expect(launch.containerName).toBe("nemoclaw-openshell-gateway-8081");
      const nameIdx = launch.args.indexOf("--name");
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(launch.args[nameIdx + 1]).toBe("nemoclaw-openshell-gateway-8081");
    });
  });

  it("lets the per-port name win over a process-wide env override", () => {
    withTempState(({ gatewayBin, sandboxBin, stateDir }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME: "custom-gw",
        },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
        compatContainerName: resolveGatewayCompatContainerName(8081),
      });

      // The per-port name must win so the env var cannot collapse isolation (#4422).
      expect(launch.containerName).toBe("nemoclaw-openshell-gateway-8081");
    });
  });

  it("honors the env container name override when no per-port name is supplied", () => {
    withTempState(({ gatewayBin, sandboxBin, stateDir }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME: "custom-gw",
        },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(launch.containerName).toBe("custom-gw");
    });
  });
});

describe("per-port gateway runtime markers stay isolated (#4422)", () => {
  // Regression for the singleton state dir teardown: two sandboxes onboarded
  // on distinct NEMOCLAW_GATEWAY_PORT values resolve to distinct state dirs, so
  // creating the second neither overwrites nor invalidates the first sandbox's
  // runtime marker.
  function markerInput(port: number, pid: number) {
    return {
      pid,
      desiredEnv: { OPENSHELL_GATEWAY_PORT: String(port) },
      endpoint: `http://127.0.0.1:${port}`,
      gatewayBin: "/usr/bin/openshell-gateway",
      openshellVersion: "0.0.44",
      dockerHost: null,
    };
  }

  it("preserves the first sandbox gateway marker when a second sandbox onboards on another port", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-marker-"));
    try {
      const firstPort = 8080;
      const secondPort = 8081;
      const firstDir = path.join(root, resolveGatewayStateDirName(firstPort));
      const secondDir = path.join(root, resolveGatewayStateDirName(secondPort));

      // First sandbox writes its gateway marker (port 8080, pid 1111).
      writeDockerDriverGatewayRuntimeMarkerForStateDir(firstDir, markerInput(firstPort, 1111));

      // Second sandbox onboards on port 8081 — it writes to its own state dir.
      writeDockerDriverGatewayRuntimeMarkerForStateDir(secondDir, markerInput(secondPort, 2222));

      // The two markers live in distinct files.
      expect(getDockerDriverGatewayRuntimeMarkerPath(firstDir)).not.toBe(
        getDockerDriverGatewayRuntimeMarkerPath(secondDir),
      );

      // The first sandbox's marker is untouched: still port 8080, pid 1111.
      const firstMarker = readDockerDriverGatewayRuntimeMarker(
        getDockerDriverGatewayRuntimeMarkerPath(firstDir),
      );
      expect(firstMarker?.endpoint).toBe("http://127.0.0.1:8080");
      expect(firstMarker?.pid).toBe(1111);

      // And it still validates against what the first sandbox expects — no drift,
      // i.e. the second onboard did not tear down or retarget the first gateway.
      expect(
        getDockerDriverGatewayRuntimeMarkerDriftForStateDir(firstDir, markerInput(firstPort, 1111)),
      ).toBeNull();

      // The second sandbox's marker reflects its own port/pid independently.
      const secondMarker = readDockerDriverGatewayRuntimeMarker(
        getDockerDriverGatewayRuntimeMarkerPath(secondDir),
      );
      expect(secondMarker?.endpoint).toBe("http://127.0.0.1:8081");
      expect(secondMarker?.pid).toBe(2222);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
