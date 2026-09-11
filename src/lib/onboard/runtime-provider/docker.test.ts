// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createDockerRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "./docker";
import type { RuntimeProviderLifecycleInput } from "./contract";

const GPU_PROOF_RESOURCE = {
  name: "nemoclaw-gpu-proof-1234",
  ownership: { label: "com.nvidia.nemoclaw.gpu-proof", value: "true" },
} as const;

function lifecycleInput(environment: NodeJS.ProcessEnv = {}): RuntimeProviderLifecycleInput {
  return {
    environment,
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

function openClawLifecycleInput(
  environment: NodeJS.ProcessEnv = {},
): RuntimeProviderLifecycleInput {
  const input = lifecycleInput(environment);
  return {
    ...input,
    sandbox: { ...input.sandbox, agent: "openclaw" },
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
    const requalifyPortableSandbox = vi.fn(() => ({ kind: "not-hermes" as const }));
    const recoverPortableSandbox = vi.fn(() => ({ kind: "already-running" as const }));
    const withLifecycleLockSync: DockerRuntimeProviderDependencies["withLifecycleLockSync"] = vi.fn(
      (_sandboxName, operation) => operation(),
    );
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => true,
      requalifyPortableSandbox,
      recoverPortableSandbox,
      findLabeledSandboxContainers: poison,
      recoverSandbox: poison,
      unpauseContainer: poison,
      withLifecycleLockSync,
    });
    const lifecycle = supportedLifecycle(provider);

    expect(
      lifecycle.start(lifecycleInput({ HOME: "/portable-home", NEMOCLAW_GATEWAY_PORT: "18080" })),
    ).toEqual({
      exitCode: 0,
      hermesPortableVerified: true,
    });
    expect(withLifecycleLockSync).toHaveBeenCalledWith("alpha", expect.any(Function), {
      stateDir: "/portable-home/.nemoclaw/state",
    });
    expect(requalifyPortableSandbox).toHaveBeenCalledOnce();
    expect(recoverPortableSandbox).toHaveBeenCalledOnce();
    expect(requalifyPortableSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      recoverPortableSandbox.mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed before recovery when Hermes requalification fails (#11248)", () => {
    const recoverPortableSandbox = vi.fn(poison);
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => false,
      requalifyPortableSandbox: () => {
        throw new Error("startup authority changed");
      },
      recoverPortableSandbox,
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });

    expect(supportedLifecycle(provider).start(lifecycleInput())).toEqual({
      exitCode: 1,
      message: "startup authority changed",
    });
    expect(recoverPortableSandbox).not.toHaveBeenCalled();
  });

  it("routes active Hermes stop before Docker capture or mutation (#9203)", () => {
    const stopPortableSandbox = vi.fn(() => ({
      kind: "stopped" as const,
      portableAgent: "hermes" as const,
    }));
    const withLifecycleLockSync: DockerRuntimeProviderDependencies["withLifecycleLockSync"] = vi.fn(
      (_sandboxName, operation) => operation(),
    );
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => true,
      stopPortableSandbox,
      findLabeledSandboxContainers: poison,
      stopContainer: poison,
      withLifecycleLockSync,
    });
    const lifecycle = supportedLifecycle(provider);

    expect(
      lifecycle.stop(lifecycleInput({ HOME: "/portable-home", NEMOCLAW_GATEWAY_PORT: "18080" }), {
        beforeStop: poison,
      }),
    ).toEqual({
      exitCode: 0,
      state: "stopped",
      hermesPortableVerified: true,
    });
    expect(withLifecycleLockSync).toHaveBeenCalledWith("alpha", expect.any(Function), {
      stateDir: "/portable-home/.nemoclaw/state",
    });
    expect(stopPortableSandbox).toHaveBeenCalledOnce();
  });
});

describe("Docker provider OpenShell lifecycle dispatch", () => {
  it("starts a stopped OpenShell sandbox through the gateway instead of Docker (#11251)", () => {
    const captureSandboxLifecycle = vi.fn(() => ({ status: 0, output: "started" }));
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: false, status: "Exited (0) 1 second ago" },
      ],
      recoverPortableSandbox: () => ({ kind: "not-installed" }),
      recoverSandbox: poison,
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });

    expect(
      supportedLifecycle(provider).start(openClawLifecycleInput({ HOME: "/test-home" })),
    ).toEqual({ exitCode: 0 });
    expect(captureSandboxLifecycle).toHaveBeenCalledWith("start", "alpha", "nemoclaw", {
      HOME: "/test-home",
    });
  });

  it("stops a running OpenShell sandbox through the gateway instead of Docker (#11251)", () => {
    const beforeStop = vi.fn();
    const captureSandboxLifecycle = vi.fn(() => ({ status: 0, output: "stopped" }));
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: true, status: "Up 1 minute" },
      ],
      stopContainer: poison,
      stopPortableSandbox: () => ({ kind: "not-installed" }),
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });

    expect(
      supportedLifecycle(provider).stop(openClawLifecycleInput({ HOME: "/test-home" }), {
        beforeStop,
      }),
    ).toEqual({ exitCode: 0, state: "stopped" });
    expect(beforeStop).toHaveBeenCalledOnce();
    expect(captureSandboxLifecycle).toHaveBeenCalledWith("stop", "alpha", "nemoclaw", {
      HOME: "/test-home",
    });
  });

  it("fails closed when OpenShell cannot start the stopped sandbox (#11251)", () => {
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle: () => ({ status: 1, output: "sandbox phase is Error" }),
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: false, status: "Exited (0) 1 second ago" },
      ],
      recoverPortableSandbox: () => ({ kind: "not-installed" }),
      recoverSandbox: poison,
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });

    expect(supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 1,
      message: "  OpenShell could not start sandbox 'alpha' (exit 1): sandbox phase is Error.",
    });
  });

  it("fails closed when OpenShell cannot stop the running sandbox (#11251)", () => {
    const beforeStop = vi.fn();
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle: () => ({ status: 1, output: "gateway unavailable" }),
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: true, status: "Up 1 minute" },
      ],
      stopContainer: poison,
      stopPortableSandbox: () => ({ kind: "not-installed" }),
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });

    expect(supportedLifecycle(provider).stop(openClawLifecycleInput(), { beforeStop })).toEqual({
      exitCode: 1,
      message: "  OpenShell could not stop sandbox 'alpha' (exit 1): gateway unavailable.",
    });
    expect(beforeStop).toHaveBeenCalledOnce();
  });

  it("keeps an already-stopped sandbox idempotent without calling OpenShell (#11251)", () => {
    const captureSandboxLifecycle = vi.fn(poison);
    const beforeStop = vi.fn(poison);
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: false, status: "Exited (0) 1 second ago" },
      ],
      stopPortableSandbox: () => ({ kind: "not-installed" }),
      withLifecycleLockSync: (_sandboxName, operation) => operation(),
    });

    expect(supportedLifecycle(provider).stop(openClawLifecycleInput(), { beforeStop })).toEqual({
      exitCode: 0,
      state: "already-stopped",
    });
    expect(captureSandboxLifecycle).not.toHaveBeenCalled();
    expect(beforeStop).not.toHaveBeenCalled();
  });
});
