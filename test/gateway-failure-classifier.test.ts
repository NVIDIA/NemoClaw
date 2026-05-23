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
    dockerExists: () => true,
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

  it("returns gateway_unreachable when container is running but API is unresponsive", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners(),
    });
    expect(result.layer).toBe("gateway_unreachable");
    expect(result.detail).toContain("not responding");
  });

  it("returns container_missing when container is not running AND `docker ps -a` does not list it", async () => {
    // This is the gap CodeRabbit flagged on #3309: a removed/never-created
    // container must not be mislabeled as exited.
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerIsRunning: () => false,
        dockerExists: () => false,
      }),
    });
    expect(result.layer).toBe("container_missing");
    expect(result.detail).toContain("not present");
  });

  it("returns container_exited_port_conflict when container exited AND port is held", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerIsRunning: () => false,
        dockerExists: () => true,
        portProbe: async () => true,
      }),
    });
    expect(result.layer).toBe("container_exited_port_conflict");
    expect(result.detail).toContain("port");
    expect(result.detail).toContain("another process");
  });

  it("returns container_exited when container exited AND port is free", async () => {
    const result = await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerIsRunning: () => false,
        dockerExists: () => true,
        portProbe: async () => false,
      }),
    });
    expect(result.layer).toBe("container_exited");
    expect(result.detail).toContain("exited");
  });

  it("does not call dockerIsRunning / dockerExists / portProbe when docker info fails", async () => {
    let dockerIsRunningCalled = false;
    let dockerExistsCalled = false;
    let portProbeCalled = false;
    await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerInfo: () => false,
        dockerIsRunning: () => {
          dockerIsRunningCalled = true;
          return false;
        },
        dockerExists: () => {
          dockerExistsCalled = true;
          return false;
        },
        portProbe: async () => {
          portProbeCalled = true;
          return false;
        },
      }),
    });
    expect(dockerIsRunningCalled).toBe(false);
    expect(dockerExistsCalled).toBe(false);
    expect(portProbeCalled).toBe(false);
  });

  it("does not call portProbe when the container is missing", async () => {
    // Existence check fails fast — we should not probe the port for a
    // non-existent container, since port_conflict isn't a meaningful
    // classification without a container to recover.
    let portProbeCalled = false;
    await classifyGatewayFailure("my-sandbox", {
      runners: makeRunners({
        dockerIsRunning: () => false,
        dockerExists: () => false,
        portProbe: async () => {
          portProbeCalled = true;
          return false;
        },
      }),
    });
    expect(portProbeCalled).toBe(false);
  });
});

describe("getLayerHeader", () => {
  it("returns a header naming each layer", () => {
    expect(getLayerHeader("docker_unreachable")).toContain("docker_unreachable");
    expect(getLayerHeader("container_missing")).toContain("container_missing");
    expect(getLayerHeader("container_exited_port_conflict")).toContain(
      "container_exited_port_conflict",
    );
    expect(getLayerHeader("container_exited")).toContain("container_exited");
    expect(getLayerHeader("gateway_unreachable")).toContain("gateway_unreachable");
  });
});
