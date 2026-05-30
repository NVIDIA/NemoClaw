// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyGatewayFailure,
  classifySandboxContainerFailure,
  getLayerHeader,
  type GatewayFailureRunners,
  type SandboxContainerFailureRunners,
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
    expect(getLayerHeader("sandbox_container_stopped")).toContain(
      "sandbox_container_stopped",
    );
    expect(getLayerHeader("sandbox_dashboard_port_conflict")).toContain(
      "sandbox_dashboard_port_conflict",
    );
  });
});

function makeSandboxRunners(
  overrides: Partial<SandboxContainerFailureRunners> = {},
): SandboxContainerFailureRunners {
  return {
    listAllContainerNames: () => "",
    listRunningContainerNames: () => "",
    portProbe: async () => false,
    ...overrides,
  };
}

describe("classifySandboxContainerFailure", () => {
  it("returns null when the sandbox container is running", async () => {
    const result = await classifySandboxContainerFailure("my-assistant", {
      runners: makeSandboxRunners({
        listRunningContainerNames: () =>
          "openshell-my-assistant-7616dcb1\nopenshell-cluster-nemoclaw",
        listAllContainerNames: () =>
          "openshell-my-assistant-7616dcb1\nopenshell-cluster-nemoclaw",
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null when the sandbox container is not present anywhere", async () => {
    const result = await classifySandboxContainerFailure("my-assistant", {
      runners: makeSandboxRunners({
        listAllContainerNames: () => "openshell-cluster-nemoclaw\n",
      }),
    });
    expect(result).toBeNull();
  });

  it("returns sandbox_container_stopped when the container exists but is not running and no port is recorded", async () => {
    const result = await classifySandboxContainerFailure("my-assistant", {
      runners: makeSandboxRunners({
        listAllContainerNames: () =>
          "openshell-my-assistant-7616dcb1\nopenshell-cluster-nemoclaw",
      }),
    });
    expect(result?.layer).toBe("sandbox_container_stopped");
    expect(result?.detail).toContain("openshell-my-assistant-7616dcb1");
  });

  it("returns sandbox_container_stopped when the container exists, is stopped, and the dashboard port is free", async () => {
    let probedPort: number | null = null;
    const result = await classifySandboxContainerFailure("my-assistant", {
      dashboardPort: 18789,
      runners: makeSandboxRunners({
        listAllContainerNames: () => "openshell-my-assistant-7616dcb1\n",
        portProbe: async (port) => {
          probedPort = port;
          return false;
        },
      }),
    });
    expect(result?.layer).toBe("sandbox_container_stopped");
    expect(probedPort).toBe(18789);
  });

  it("returns sandbox_dashboard_port_conflict when the container exists, is stopped, and the dashboard port is held", async () => {
    const result = await classifySandboxContainerFailure("my-assistant", {
      dashboardPort: 18789,
      runners: makeSandboxRunners({
        listAllContainerNames: () => "openshell-my-assistant-7616dcb1\n",
        portProbe: async () => true,
      }),
    });
    expect(result?.layer).toBe("sandbox_dashboard_port_conflict");
    expect(result?.detail).toContain("18789");
    expect(result?.detail).toContain("openshell-my-assistant-7616dcb1");
  });

  it("does not probe the port when the container is running", async () => {
    let portProbeCalled = false;
    await classifySandboxContainerFailure("my-assistant", {
      dashboardPort: 18789,
      runners: makeSandboxRunners({
        listRunningContainerNames: () => "openshell-my-assistant-7616dcb1",
        listAllContainerNames: () => "openshell-my-assistant-7616dcb1",
        portProbe: async () => {
          portProbeCalled = true;
          return true;
        },
      }),
    });
    expect(portProbeCalled).toBe(false);
  });

  it("does not probe the port when the container is not present at all", async () => {
    let portProbeCalled = false;
    await classifySandboxContainerFailure("my-assistant", {
      dashboardPort: 18789,
      runners: makeSandboxRunners({
        listAllContainerNames: () => "openshell-cluster-nemoclaw\n",
        portProbe: async () => {
          portProbeCalled = true;
          return true;
        },
      }),
    });
    expect(portProbeCalled).toBe(false);
  });

  it("matches the exact prefix and the uuid-suffixed shape but not unrelated containers", async () => {
    const exactResult = await classifySandboxContainerFailure("my-assistant", {
      runners: makeSandboxRunners({
        listAllContainerNames: () => "openshell-my-assistant\n",
      }),
    });
    expect(exactResult?.layer).toBe("sandbox_container_stopped");
    expect(exactResult?.detail).toContain("openshell-my-assistant");

    const otherSandbox = await classifySandboxContainerFailure("my-assistant", {
      runners: makeSandboxRunners({
        listAllContainerNames: () =>
          "openshell-my-assistant-evil\nopenshell-different-sandbox-abc",
      }),
    });
    expect(otherSandbox?.layer).toBe("sandbox_container_stopped");
    expect(otherSandbox?.detail).toContain("openshell-my-assistant-evil");

    const unrelated = await classifySandboxContainerFailure("my-assistant", {
      runners: makeSandboxRunners({
        listAllContainerNames: () =>
          "openshell-cluster-nemoclaw\nopenshell-my-assistantextra\n",
      }),
    });
    expect(unrelated).toBeNull();
  });
});
