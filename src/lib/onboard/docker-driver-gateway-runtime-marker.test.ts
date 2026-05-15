// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDockerDriverGatewayRuntimeMarker,
  getDockerDriverGatewayRuntimeMarkerDrift,
  readDockerDriverGatewayRuntimeMarker,
  writeDockerDriverGatewayRuntimeMarker,
} from "./docker-driver-gateway-runtime-marker";

const expected = {
  pid: 1234,
  desiredEnv: {
    OPENSHELL_DRIVERS: "docker",
    OPENSHELL_GRPC_ENDPOINT: "http://127.0.0.1:8080",
  },
  endpoint: "http://127.0.0.1:8080",
  gatewayBin: "/usr/local/bin/openshell-gateway",
  openshellVersion: "0.0.39",
  dockerHost: "unix:///Users/me/.colima/default/docker.sock",
  platform: "darwin" as NodeJS.Platform,
  arch: "arm64" as NodeJS.Architecture,
  createdAt: "2026-05-14T00:00:00.000Z",
};

describe("docker-driver gateway runtime marker", () => {
  it("accepts a marker that matches the desired Docker-driver runtime", () => {
    const marker = buildDockerDriverGatewayRuntimeMarker(expected);

    expect(getDockerDriverGatewayRuntimeMarkerDrift(marker, expected)).toBeNull();
  });

  it("forces recreation when the marker is missing or stale", () => {
    expect(getDockerDriverGatewayRuntimeMarkerDrift(null, expected)?.reason).toContain(
      "missing Docker-driver runtime marker",
    );

    const marker = buildDockerDriverGatewayRuntimeMarker(expected);
    expect(
      getDockerDriverGatewayRuntimeMarkerDrift(marker, {
        ...expected,
        desiredEnv: { ...expected.desiredEnv, OPENSHELL_GRPC_ENDPOINT: "http://127.0.0.1:9000" },
      })?.reason,
    ).toContain("env hash");

    expect(
      getDockerDriverGatewayRuntimeMarkerDrift(marker, {
        ...expected,
        dockerHost: "unix:///Users/me/.docker/run/docker.sock",
      })?.reason,
    ).toContain("DOCKER_HOST");
  });

  it("round-trips the marker with owner-only file permissions", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-marker-"));
    const markerPath = path.join(tempDir, "runtime.json");
    try {
      const marker = buildDockerDriverGatewayRuntimeMarker(expected);
      writeDockerDriverGatewayRuntimeMarker(markerPath, marker);

      expect(readDockerDriverGatewayRuntimeMarker(markerPath)).toEqual(marker);
      expect(fs.statSync(markerPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
