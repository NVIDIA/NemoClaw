// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyGatewayFailure,
  getLayerHeader,
  type GatewayFailureRunners,
  isDockerRuntimeDown,
  printDockerRuntimeDownGuidance,
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

describe("isDockerRuntimeDown", () => {
  const dockerSandbox = () => ({ openshellDriver: "docker" });

  it("returns true when docker info fails for a Docker-driver sandbox", () => {
    expect(
      isDockerRuntimeDown("alpha", {
        runners: { dockerInfo: () => false },
        getSandbox: dockerSandbox,
      }),
    ).toBe(true);
  });

  it("returns false when docker info succeeds", () => {
    expect(
      isDockerRuntimeDown("alpha", {
        runners: { dockerInfo: () => true },
        getSandbox: dockerSandbox,
      }),
    ).toBe(false);
  });

  it("returns false for the vm driver even when docker info fails", () => {
    // A vm sandbox runs in a real VM with no local Docker daemon, so a failing
    // `docker info` must not be misclassified as a runtime outage.
    let probed = false;
    const result = isDockerRuntimeDown("alpha", {
      runners: {
        dockerInfo: () => {
          probed = true;
          return false;
        },
      },
      getSandbox: () => ({ openshellDriver: "vm" }),
    });
    expect(result).toBe(false);
    // The docker probe should be short-circuited by the driver gate.
    expect(probed).toBe(false);
  });

  it("treats the kubernetes driver as Docker-backed (gateway runs in local Docker)", () => {
    // The k3s/Docker-Desktop gateway still lives in the local Docker daemon, so
    // a Docker outage must be classified for kubernetes-driver sandboxes too.
    expect(
      isDockerRuntimeDown("alpha", {
        runners: { dockerInfo: () => false },
        getSandbox: () => ({ openshellDriver: "kubernetes" }),
      }),
    ).toBe(true);
  });

  it("treats legacy/recovered entries without driver metadata as Docker-backed", () => {
    // Sandboxes registered before `openshellDriver` existed (or recovered from
    // gateway state) omit the field; they must still get the outage guard
    // rather than falling back to the broken Provisioning/rebuild path (#4428).
    for (const entry of [{}, { openshellDriver: null }, () => null] as const) {
      const getSandbox = typeof entry === "function" ? entry : () => entry;
      expect(
        isDockerRuntimeDown("alpha", {
          runners: { dockerInfo: () => false },
          getSandbox,
        }),
      ).toBe(true);
    }
  });
});

describe("printDockerRuntimeDownGuidance", () => {
  function capture(fn: (writer: (m: string) => void) => void): string {
    const lines: string[] = [];
    fn((m) => lines.push(m));
    return lines.join("\n");
  }

  it("names the docker_unreachable layer and steers away from rebuild/destroy/onboard", () => {
    const out = capture((writer) => printDockerRuntimeDownGuidance("my-sandbox", { writer }));
    expect(out).toContain("docker_unreachable");
    expect(out).toContain("Docker daemon is not reachable");
    expect(out).toContain("docker info");
    // The only mention of rebuild/destroy/onboard must be the explicit advice
    // NOT to do them — never a `rebuild --yes`-style call to action (#4428).
    expect(out).toContain("do not rebuild, destroy, or re-onboard");
    expect(out).not.toMatch(/rebuild --yes|Run `[^`]*rebuild/i);
  });

  it("uses the supplied retry command in the retry hint", () => {
    const out = capture((writer) =>
      printDockerRuntimeDownGuidance("my-sandbox", { writer, retryCommand: "connect" }),
    );
    expect(out).toContain("my-sandbox connect");
  });

  it("defaults the retry hint to status", () => {
    const out = capture((writer) => printDockerRuntimeDownGuidance("my-sandbox", { writer }));
    expect(out).toContain("my-sandbox status");
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
