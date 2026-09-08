// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDockerRuntimeProviderBundle } from "./docker";
import type { RuntimeProviderLifecycleInput } from "./contract";

const GPU_PROOF_RESOURCE = {
  name: "nemoclaw-gpu-proof-1234",
  ownership: { label: "com.nvidia.nemoclaw.gpu-proof", value: "true" },
} as const;

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

function supportedContainerEngine(provider: ReturnType<typeof createDockerRuntimeProviderBundle>) {
  expect(provider.containerEngine.supported).toBe(true);
  return provider.containerEngine as Extract<typeof provider.containerEngine, { supported: true }>;
}

function nvidiaContainer(provider: ReturnType<typeof createDockerRuntimeProviderBundle>) {
  const capability = supportedContainerEngine(provider).nvidiaContainer;
  expect(capability).toBeDefined();
  return capability!;
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

describe("Docker runtime provider NVIDIA container capture", () => {
  it("maps one provider-neutral NVIDIA run to Docker GPU arguments", () => {
    const captureHostCommand = vi.fn(() => ({ status: 0, stdout: "proof", stderr: "" }));
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    const capability = nvidiaContainer(provider);

    expect(
      capability.capture(
        "host-local-inference",
        {
          image: "registry.example/proof@sha256:" + "a".repeat(64),
          entrypoint: "/bin/sh",
          command: ["-c", "proof"],
          resource: GPU_PROOF_RESOURCE,
        },
        12_000,
      ),
    ).toMatchObject({ status: 0, stdout: "proof" });
    expect(captureHostCommand).toHaveBeenCalledWith(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        GPU_PROOF_RESOURCE.name,
        "--label",
        "com.nvidia.nemoclaw.gpu-proof=true",
        "--gpus",
        "all",
        "--entrypoint",
        "/bin/sh",
        "registry.example/proof@sha256:" + "a".repeat(64),
        "-c",
        "proof",
      ],
      12_000,
    );
  });

  it("removes only the exact owned proof container after timeout", () => {
    const containerId = "a".repeat(64);
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${containerId}\t${GPU_PROOF_RESOURCE.name}\n`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: containerId, stderr: "" });
    const capability = nvidiaContainer(createDockerRuntimeProviderBundle({ captureHostCommand }));

    expect(
      capability.cleanup("host-local-inference", GPU_PROOF_RESOURCE, {
        timeoutMs: 15_000,
        observation: "until-deadline",
      }),
    ).toEqual({ status: "removed" });
    expect(captureHostCommand).toHaveBeenNthCalledWith(
      1,
      "docker",
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${GPU_PROOF_RESOURCE.name}$`,
        "--filter",
        "label=com.nvidia.nemoclaw.gpu-proof=true",
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      expect.any(Number),
    );
    expect(captureHostCommand).toHaveBeenNthCalledWith(
      2,
      "docker",
      expect.arrayContaining([
        "ps",
        "--filter",
        `name=^/${GPU_PROOF_RESOURCE.name}$`,
        "--filter",
        "label=com.nvidia.nemoclaw.gpu-proof=true",
      ]),
      expect.any(Number),
    );
    expect(captureHostCommand).toHaveBeenNthCalledWith(
      3,
      "docker",
      ["rm", "-f", containerId],
      expect.any(Number),
    );
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
