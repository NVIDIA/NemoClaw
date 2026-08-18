// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDockerRuntimeProviderBundle } from "./docker";
import type { RuntimeProviderLifecycleInput } from "./contract";

function lifecycleInput(): RuntimeProviderLifecycleInput {
  return {
    environment: {},
    log: vi.fn(),
    sandboxName: "alpha",
    sandbox: {
      name: "alpha",
      agent: "hermes",
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
    } as RuntimeProviderLifecycleInput["sandbox"],
  };
}

function poison(): never {
  throw new Error("Docker dependency must not be called");
}

function supportedLifecycle(provider: ReturnType<typeof createDockerRuntimeProviderBundle>) {
  expect(provider.lifecycle.supported).toBe(true);
  return provider.lifecycle as Extract<typeof provider.lifecycle, { supported: true }>;
}

function inspectDockerHost(stdout: string, status = 0, stderr = "") {
  const captureHostCommand = vi.fn(() => ({ status, stdout, stderr }));
  const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
  expect(provider.preflightDoctor.supported).toBe(true);
  const preflightDoctor = provider.preflightDoctor as Extract<
    typeof provider.preflightDoctor,
    { supported: true }
  >;

  return {
    captureHostCommand,
    check: preflightDoctor.inspectHost(),
  };
}

describe("Docker runtime provider host doctor", () => {
  it("reports the daemon version from the shared reachability observation (#7411)", () => {
    const { captureHostCommand, check } = inspectDockerHost(
      JSON.stringify({ ServerVersion: "29.3.1", OperatingSystem: "Ubuntu 24.04" }),
    );

    expect(captureHostCommand).toHaveBeenCalledWith(
      "docker",
      ["info", "--format", "{{json .}}"],
      8000,
    );
    expect(check).toEqual({
      group: "Host",
      label: "Docker daemon",
      status: "ok",
      detail: "server 29.3.1",
      hint: undefined,
    });
  });

  it.each([
    ["empty output", ""],
    ["zero-value JSON", JSON.stringify({ ServerVersion: "" })],
    [
      "daemon error JSON",
      JSON.stringify({
        ServerVersion: "",
        ServerErrors: ["Cannot connect to the Docker daemon"],
      }),
    ],
  ])("rejects exit-zero %s without positive daemon evidence (#7411)", (_case, stdout) => {
    expect(inspectDockerHost(stdout).check).toEqual({
      group: "Host",
      label: "Docker daemon",
      status: "fail",
      detail: "docker info failed",
      hint: "start Docker and verify your user can access the daemon",
    });
  });

  it("preserves the captured Docker error when the command fails", () => {
    expect(inspectDockerHost("", 1, "Cannot connect to the Docker daemon\n").check).toEqual({
      group: "Host",
      label: "Docker daemon",
      status: "fail",
      detail: "Cannot connect to the Docker daemon",
      hint: "start Docker and verify your user can access the daemon",
    });
  });
});

describe("Docker provider portable lifecycle dispatch", () => {
  it("routes active Hermes start before every Docker dependency (#9203)", () => {
    const recoverPortableSandbox = vi.fn(() => ({ kind: "already-running" as const }));
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => true,
      recoverPortableSandbox,
      findLabeledSandboxContainers: poison,
      recoverSandbox: poison,
      unpauseContainer: poison,
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });
    const lifecycle = supportedLifecycle(provider);

    expect(lifecycle.start(lifecycleInput())).toEqual({
      exitCode: 0,
      hermesPortableVerified: true,
    });
    expect(recoverPortableSandbox).toHaveBeenCalledOnce();
  });

  it("routes active Hermes stop before Docker capture or mutation (#9203)", () => {
    const stopPortableSandbox = vi.fn(() => ({
      kind: "stopped" as const,
      portableAgent: "hermes" as const,
    }));
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => true,
      stopPortableSandbox,
      findLabeledSandboxContainers: poison,
      stopContainer: poison,
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });
    const lifecycle = supportedLifecycle(provider);

    expect(lifecycle.stop(lifecycleInput(), { beforeStop: poison })).toEqual({
      exitCode: 0,
      state: "stopped",
      hermesPortableVerified: true,
    });
    expect(stopPortableSandbox).toHaveBeenCalledOnce();
  });
});
