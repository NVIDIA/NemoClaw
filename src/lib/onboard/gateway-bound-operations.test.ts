// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPortAvailable: vi.fn(async () => ({ available: true, reason: "available" })),
  dockerContainerInspectFormat: vi.fn(() => "running healthy\n"),
  dockerExecArgv: vi.fn((container: string, args: string[]) => ["docker", container, ...args]),
  getDockerDriverGatewayEndpoint: vi.fn((port: number) => `docker://${String(port)}`),
  getGatewayClusterImageDrift: vi.fn(() => null),
  getGatewayHttpEndpoint: vi.fn((port: number) => `http://gateway:${String(port)}`),
  getGatewayHttpsEndpoint: vi.fn((port: number) => `https://gateway:${String(port)}`),
  getGatewayPortCheckOptions: vi.fn(() => ({ allowDockerGateway: true })),
  isDockerDriverGatewayHttpReady: vi.fn(async () => true),
  isGatewayHttpReady: vi.fn(async () => true),
  isGatewayTcpReady: vi.fn(async () => true),
  waitForGatewayHttpReady: vi.fn(async () => true),
}));

vi.mock("../adapters/docker", () => ({
  dockerContainerInspectFormat: mocks.dockerContainerInspectFormat,
  dockerExecArgv: mocks.dockerExecArgv,
}));
vi.mock("../adapters/openshell/gateway-drift", () => ({
  getGatewayClusterImageDrift: mocks.getGatewayClusterImageDrift,
}));
vi.mock("../core/gateway-address", () => ({
  getGatewayHttpEndpoint: mocks.getGatewayHttpEndpoint,
  getGatewayHttpsEndpoint: mocks.getGatewayHttpsEndpoint,
}));
vi.mock("./docker-driver-gateway-env", () => ({
  getDockerDriverGatewayEndpoint: mocks.getDockerDriverGatewayEndpoint,
  getGatewayHttpsEndpoint: mocks.getGatewayHttpsEndpoint,
  getGatewayPortCheckOptions: mocks.getGatewayPortCheckOptions,
}));
vi.mock("./gateway-http-readiness", () => ({
  isDockerDriverGatewayHttpReady: mocks.isDockerDriverGatewayHttpReady,
  isGatewayHttpReady: mocks.isGatewayHttpReady,
  waitForGatewayHttpReady: mocks.waitForGatewayHttpReady,
}));
vi.mock("./gateway-tcp-readiness", () => ({
  isGatewayTcpReady: mocks.isGatewayTcpReady,
}));
vi.mock("./preflight", () => ({ checkPortAvailable: mocks.checkPortAvailable }));

import { createGatewayBoundOperations } from "./gateway-bound-operations";

describe("gateway-bound operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves every operation from the current non-default gateway binding (#6195)", async () => {
    let binding = { name: "nemoclaw-19080", port: 19080 };
    const operations = createGatewayBoundOperations(() => binding);

    expect(operations.getDockerDriverGatewayEndpoint()).toBe("docker://19080");
    expect(operations.getGatewayClusterImageDrift()).toBeNull();
    expect(operations.getGatewayClusterContainerState()).toBe("running healthy");
    expect(operations.buildGatewayClusterExecArgv("true")).toEqual([
      "docker",
      "openshell-cluster-nemoclaw-19080",
      "sh",
      "-lc",
      "true",
    ]);
    await expect(operations.checkGatewayPortAvailable()).resolves.toMatchObject({
      available: true,
    });
    expect(operations.getGatewayLocalEndpoint()).toBe("https://gateway:19080");
    await expect(operations.isGatewayHttpReady()).resolves.toBe(true);
    await expect(operations.isDockerDriverGatewayHttpReady()).resolves.toBe(true);
    await expect(operations.isGatewayTcpReady()).resolves.toBe(true);
    await expect(operations.waitForGatewayHttpReady()).resolves.toBe(true);

    expect(mocks.getGatewayClusterImageDrift).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-19080",
    });
    expect(mocks.checkPortAvailable).toHaveBeenCalledWith(19080, {
      allowDockerGateway: true,
    });
    expect(mocks.isGatewayHttpReady).toHaveBeenCalledWith(
      undefined,
      "http://gateway:19080/",
      undefined,
    );
    expect(mocks.isDockerDriverGatewayHttpReady).toHaveBeenCalledWith(
      undefined,
      "https://gateway:19080/openshell.v1.OpenShell/Health",
    );
    expect(mocks.isGatewayTcpReady).toHaveBeenCalledWith(19080, undefined);

    binding = { name: "nemoclaw-19181", port: 19181 };
    expect(operations.getDockerDriverGatewayEndpoint()).toBe("docker://19181");
    expect(operations.getGatewayClusterContainerState()).toBe("running healthy");
    expect(mocks.dockerContainerInspectFormat).toHaveBeenLastCalledWith(
      expect.any(String),
      "openshell-cluster-nemoclaw-19181",
      { ignoreError: true },
    );
  });
});
