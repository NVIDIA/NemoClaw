// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSandboxMock = vi.fn();
const dockerRunMock = vi.fn((_args: readonly string[], _options?: Record<string, unknown>) => ({
  status: 0,
  stderr: "",
  stdout: '{"ServerVersion":"29.0.0"}',
}));

vi.mock("../../adapters/docker/run", () => ({
  dockerCapture: vi.fn(() => ""),
  dockerRun: (args: readonly string[], options?: Record<string, unknown>) =>
    dockerRunMock(args, options),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: (...args: unknown[]) => getSandboxMock(...args),
  listSandboxes: vi.fn(() => ({ sandboxes: [] })),
}));

vi.mock("../../state/registry/cross-port", () => ({
  findSandboxAcrossGatewayRoots: (...args: unknown[]) => {
    const entry = getSandboxMock(...args);
    return entry
      ? { entry, gatewayPort: entry.gatewayPort ?? null, registryFile: "/test/sandboxes.json" }
      : null;
  },
}));

import {
  classifyGatewayFailure,
  classifyObservedSandboxContainerFailure,
  type GatewayFailureRunners,
  isDockerDaemonReachable,
  isDockerRuntimeDown,
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

  it("short-circuits on an unreachable Docker daemon before resolving the gateway container", async () => {
    const result = await classifyGatewayFailure("sb-1", {
      runners: runners({ dockerInfo: () => false }),
    });

    expect(result.layer).toBe("docker_unreachable");
    expect(getSandboxMock).toHaveBeenCalledWith("sb-1");
  });

  it("classifies native Podman gateway failure without invoking Docker", async () => {
    getSandboxMock.mockReturnValue({ name: "sb-1", openshellDriver: " PODMAN " });
    const dockerInfo = vi.fn(() => false);
    const dockerIsRunning = vi.fn(() => false);
    const dockerExists = vi.fn(() => false);
    const portProbe = vi.fn(async () => false);

    await expect(
      classifyGatewayFailure("sb-1", {
        runners: { dockerInfo, dockerIsRunning, dockerExists, portProbe },
      }),
    ).resolves.toEqual({
      layer: "gateway_unreachable",
      detail: "The OpenShell gateway for sandbox 'sb-1' is unreachable.",
    });
    expect(dockerInfo).not.toHaveBeenCalled();
    expect(dockerIsRunning).not.toHaveBeenCalled();
    expect(dockerExists).not.toHaveBeenCalled();
    expect(portProbe).not.toHaveBeenCalled();
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

describe("isDockerRuntimeDown", () => {
  beforeEach(() => {
    getSandboxMock.mockReset();
    dockerRunMock.mockReset();
    dockerRunMock.mockReturnValue({
      status: 0,
      stderr: "",
      stdout: '{"ServerVersion":"29.0.0"}',
    });
  });

  it("rejects Docker client output when the daemon request fails (#11715)", () => {
    dockerRunMock.mockReturnValue({
      status: 1,
      stderr: "Cannot connect to the Docker daemon",
      stdout: "Client: Docker Engine - Community",
    });

    expect(isDockerDaemonReachable()).toBe(false);
    getSandboxMock.mockReturnValue({ openshellDriver: "docker" });
    expect(isDockerRuntimeDown("alpha")).toBe(true);
  });

  it("treats absent Docker stdout as an unreachable daemon (#11715)", () => {
    dockerRunMock.mockReturnValue({
      status: 1,
      stderr: "Cannot start Docker",
      stdout: null as unknown as string,
    });

    expect(isDockerDaemonReachable()).toBe(false);
    getSandboxMock.mockReturnValue({ openshellDriver: "docker" });
    expect(isDockerRuntimeDown("alpha")).toBe(true);
  });

  it("accepts Docker info only when the daemon request succeeds (#11715)", () => {
    expect(isDockerDaemonReachable()).toBe(true);
    getSandboxMock.mockReturnValue({ openshellDriver: "docker" });
    expect(isDockerRuntimeDown("alpha")).toBe(false);
    expect(dockerRunMock).toHaveBeenCalledWith(["info", "--format", "{{json .}}"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: 3000,
    });
  });

  it("rejects a successful Docker info response without server evidence (#11715)", () => {
    dockerRunMock.mockReturnValue({
      status: 0,
      stderr: "",
      stdout: '{"ServerVersion":"","ServerErrors":["daemon unavailable"]}',
    });

    expect(isDockerDaemonReachable()).toBe(false);
    getSandboxMock.mockReturnValue({ openshellDriver: "docker" });
    expect(isDockerRuntimeDown("alpha")).toBe(true);
  });

  it("rejects malformed output from the JSON-formatted Docker info request (#11715)", () => {
    dockerRunMock.mockReturnValue({
      status: 0,
      stderr: "",
      stdout: "unexpected",
    });

    expect(isDockerDaemonReachable()).toBe(false);
    getSandboxMock.mockReturnValue({ openshellDriver: "docker" });
    expect(isDockerRuntimeDown("alpha")).toBe(true);
  });

  it("does not invoke Docker for a native Podman sandbox", () => {
    getSandboxMock.mockReturnValue({ openshellDriver: " PODMAN " });
    const dockerInfo = vi.fn(() => false);

    expect(isDockerRuntimeDown("alpha", { runners: { dockerInfo } })).toBe(false);
    expect(dockerInfo).not.toHaveBeenCalled();
  });
});
