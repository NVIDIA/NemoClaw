// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSandboxMock = vi.fn();

vi.mock("../../state/registry", () => ({
  getSandbox: (...args: unknown[]) => getSandboxMock(...args),
  listSandboxes: vi.fn(() => ({ sandboxes: [] })),
}));

import {
  classifyGatewayFailure,
  classifyObservedSandboxContainerFailure,
  type GatewayFailureRunners,
} from "./gateway-failure-classifier";

function runners(overrides: Partial<GatewayFailureRunners> = {}): GatewayFailureRunners {
  return {
    dockerInfo: () => true,
    dockerIsRunning: () => false,
    dockerExists: () => false,
    portProbe: async () => false,
    ...overrides,
  };
}

describe("classifyGatewayFailure (#7348)", () => {
  beforeEach(() => {
    getSandboxMock.mockReset();
  });
  it("classifies an exited per-port gateway container as container_exited, not container_missing", async () => {
    getSandboxMock.mockReturnValue({ name: "sb-1", gatewayPort: 8081 });
    const portProbe = vi.fn(async () => false);

    const result = await classifyGatewayFailure("sb-1", {
      runners: runners({
        dockerExists: (container) => container === "openshell-cluster-nemoclaw-8081",
        portProbe,
      }),
    });

    expect(result.layer).toBe("container_exited");
    expect(result.detail).toContain("openshell-cluster-nemoclaw-8081");
    expect(portProbe).toHaveBeenCalledWith(8081);
  });

  it("reports the per-port gateway port on a port conflict", async () => {
    getSandboxMock.mockReturnValue({ name: "sb-1", gatewayPort: 8081 });

    const result = await classifyGatewayFailure("sb-1", {
      runners: runners({
        dockerExists: (container) => container === "openshell-cluster-nemoclaw-8081",
        portProbe: async (port) => port === 8081,
      }),
    });

    expect(result.layer).toBe("container_exited_port_conflict");
    expect(result.detail).toContain("port 8081");
    expect(result.detail).toContain("openshell-cluster-nemoclaw-8081");
  });

  it("does not attribute a running default gateway container to a per-port sandbox", async () => {
    getSandboxMock.mockReturnValue({ name: "sb-1", gatewayPort: 8081 });

    const result = await classifyGatewayFailure("sb-1", {
      runners: runners({
        dockerIsRunning: (container) => container === "openshell-cluster-nemoclaw",
        dockerExists: (container) => container.startsWith("openshell-cluster-nemoclaw"),
      }),
    });

    expect(result.layer).toBe("container_exited");
    expect(result.detail).toContain("openshell-cluster-nemoclaw-8081");
  });

  it("keeps probing the default gateway container for sandboxes without a registered gateway", async () => {
    getSandboxMock.mockReturnValue(null);

    const result = await classifyGatewayFailure("legacy-sb", {
      runners: runners({
        dockerIsRunning: (container) => container === "openshell-cluster-nemoclaw",
      }),
    });

    expect(result.layer).toBe("gateway_unreachable");
    expect(result.detail).toContain("'openshell-cluster-nemoclaw'");
  });

  it("short-circuits on an unreachable Docker daemon before resolving the gateway", async () => {
    const result = await classifyGatewayFailure("sb-1", {
      runners: runners({ dockerInfo: () => false }),
    });

    expect(result.layer).toBe("docker_unreachable");
    expect(getSandboxMock).not.toHaveBeenCalled();
  });
});

describe("classifyObservedSandboxContainerFailure", () => {
  it("classifies a provider-observed stopped sandbox without naming its runtime", async () => {
    await expect(
      classifyObservedSandboxContainerFailure("alpha", "stopped", 18789, async () => false),
    ).resolves.toMatchObject({ layer: "sandbox_container_stopped" });
  });

  it("does not duplicate running provider observations", async () => {
    await expect(
      classifyObservedSandboxContainerFailure("alpha", "running", 18789),
    ).resolves.toBeNull();
  });
});
