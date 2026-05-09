// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyGatewayFailure,
  getLayerHeader,
  type GatewayFailureRunners,
} from "../dist/lib/actions/sandbox/gateway-failure-classifier.js";

function makeRunners(overrides: Partial<GatewayFailureRunners> = {}): GatewayFailureRunners {
  return {
    dockerInfo: () => true,
    dockerIsRunning: () => true,
    portProbe: async () => false,
    ...overrides,
  };
}

describe("classifyGatewayFailure", () => {
  it("returns docker_unreachable when docker info fails", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({ dockerInfo: () => false }),
    });
    expect(result.layer).toBe("docker_unreachable");
    expect(result.detail).toContain("Docker daemon");
  });

  it("returns container_exited_port_conflict when container is stopped and port is in use", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerIsRunning: () => false,
        portProbe: async () => true,
      }),
    });
    expect(result.layer).toBe("container_exited_port_conflict");
    expect(result.detail).toContain("port");
    expect(result.detail).toContain("another process");
  });

  it("returns container_exited when container is stopped and port is free", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerIsRunning: () => false,
        portProbe: async () => false,
      }),
    });
    expect(result.layer).toBe("container_exited");
    expect(result.detail).toContain("not running");
  });

  it("returns gateway_unreachable when container is running but gateway unresponsive", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners(),
    });
    expect(result.layer).toBe("gateway_unreachable");
    expect(result.detail).toContain("not responding");
  });

  it("does not call dockerIsRunning or portProbe when docker info fails", async () => {
    let dockerIsRunningCalled = false;
    let portProbeCalled = false;
    await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerInfo: () => false,
        dockerIsRunning: () => {
          dockerIsRunningCalled = true;
          return false;
        },
        portProbe: async () => {
          portProbeCalled = true;
          return false;
        },
      }),
    });
    expect(dockerIsRunningCalled).toBe(false);
    expect(portProbeCalled).toBe(false);
  });
});

describe("getLayerHeader", () => {
  it("returns a header containing the layer name", () => {
    expect(getLayerHeader("docker_unreachable")).toContain("docker_unreachable");
    expect(getLayerHeader("container_exited_port_conflict")).toContain("container_exited_port_conflict");
    expect(getLayerHeader("container_exited")).toContain("container_exited");
    expect(getLayerHeader("gateway_unreachable")).toContain("gateway_unreachable");
  });
});
