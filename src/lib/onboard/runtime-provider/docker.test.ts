// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createDockerRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "./docker";
import * as dockerCommands from "../../adapters/docker/run";
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
  it("rereads registry authority after deferred requalification before recovery (#11479)", async () => {
    const input = lifecycleInput();
    let row = input.sandbox;
    let resolvePolicy!: () => void;
    let notifyEntered!: () => void;
    const policy = new Promise<void>((resolve) => {
      resolvePolicy = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const recoverPortableSandbox = vi.fn(poison);
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => false,
      requalifyPortableSandbox: async (name, deps) => {
        expect(deps.readRegistry?.(name)).toBe(input.sandbox);
        notifyEntered();
        await policy;
        expect(deps.readRegistry?.(name)).toBe(row);
        throw new Error("registry authority disagrees with the active receipt");
      },
      recoverPortableSandbox,
      withLifecycleLock: async (_name, operation) => operation(),
    });
    const started = supportedLifecycle(provider).start({ ...input, readRegistry: () => row });
    await entered;
    row = { ...row, lifecycleGeneration: "generation-2" };
    resolvePolicy();

    expect(await started).toEqual({
      exitCode: 1,
      message: "registry authority disagrees with the active receipt",
    });
    expect(recoverPortableSandbox).not.toHaveBeenCalled();
  });

  it("routes active Hermes start before every Docker dependency (#9203)", async () => {
    const requalifyPortableSandbox = vi.fn(async () => ({ kind: "not-hermes" as const }));
    const recoverPortableSandbox = vi.fn(async () => ({ kind: "already-running" as const }));
    const withLifecycleLock: DockerRuntimeProviderDependencies["withLifecycleLock"] = vi.fn(
      (_sandboxName, operation) => operation(),
    );
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => true,
      requalifyPortableSandbox,
      recoverPortableSandbox,
      findLabeledSandboxContainers: poison,
      recoverSandbox: poison,
      unpauseContainer: poison,
      withLifecycleLock,
    });
    const lifecycle = supportedLifecycle(provider);

    expect(
      await lifecycle.start(
        lifecycleInput({ HOME: "/portable-home", NEMOCLAW_GATEWAY_PORT: "18080" }),
      ),
    ).toEqual({
      exitCode: 0,
      hermesPortableVerified: true,
    });
    expect(withLifecycleLock).toHaveBeenCalledWith("alpha", expect.any(Function), {
      stateDir: "/portable-home/.nemoclaw/state",
    });
    expect(requalifyPortableSandbox).toHaveBeenCalledOnce();
    expect(recoverPortableSandbox).toHaveBeenCalledOnce();
    expect(requalifyPortableSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      recoverPortableSandbox.mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed before recovery when Hermes requalification fails (#11248)", async () => {
    const recoverPortableSandbox = vi.fn(poison);
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => false,
      requalifyPortableSandbox: () => {
        throw new Error("startup authority changed");
      },
      recoverPortableSandbox,
      withLifecycleLock: async (_sandboxName, operation) => operation(),
    });

    expect(await supportedLifecycle(provider).start(lifecycleInput())).toEqual({
      exitCode: 1,
      message: "startup authority changed",
    });
    expect(recoverPortableSandbox).not.toHaveBeenCalled();
  });

  it("routes active Hermes stop before Docker capture or mutation (#9203)", async () => {
    const stopPortableSandbox = vi.fn(async () => ({
      kind: "stopped" as const,
      portableAgent: "hermes" as const,
    }));
    const withLifecycleLock: DockerRuntimeProviderDependencies["withLifecycleLock"] = vi.fn(
      (_sandboxName, operation) => operation(),
    );
    const provider = createDockerRuntimeProviderBundle({
      hasPortableLifecycleReceipt: () => true,
      stopPortableSandbox,
      findLabeledSandboxContainers: poison,
      stopContainer: poison,
      withLifecycleLock,
    });
    const lifecycle = supportedLifecycle(provider);

    expect(
      await lifecycle.stop(
        lifecycleInput({ HOME: "/portable-home", NEMOCLAW_GATEWAY_PORT: "18080" }),
        {
          beforeStop: poison,
        },
      ),
    ).toEqual({
      exitCode: 0,
      state: "stopped",
      hermesPortableVerified: true,
    });
    expect(withLifecycleLock).toHaveBeenCalledWith("alpha", expect.any(Function), {
      stateDir: "/portable-home/.nemoclaw/state",
    });
    expect(stopPortableSandbox).toHaveBeenCalledOnce();
  });
});

describe("Docker provider OpenShell lifecycle dispatch", () => {
  it("starts a stopped OpenShell sandbox through the gateway instead of Docker (#11251)", async () => {
    const captureSandboxLifecycle = vi.fn(() => ({ status: 0, output: "started" }));
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: false, status: "Exited (0) 1 second ago" },
      ],
      recoverPortableSandbox: async () => ({ kind: "not-installed" }),
      recoverSandbox: poison,
      withLifecycleLock: async (_sandboxName, operation) => operation(),
    });

    expect(
      await supportedLifecycle(provider).start(openClawLifecycleInput({ HOME: "/test-home" })),
    ).toEqual({ exitCode: 0 });
    expect(captureSandboxLifecycle).toHaveBeenCalledWith("start", "alpha", "nemoclaw", {
      HOME: "/test-home",
    });
  });

  it("stops a running OpenShell sandbox through the gateway instead of Docker (#11251)", async () => {
    const beforeStop = vi.fn();
    const captureSandboxLifecycle = vi.fn(() => ({ status: 0, output: "stopped" }));
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: true, status: "Up 1 minute" },
      ],
      stopContainer: poison,
      stopPortableSandbox: async () => ({ kind: "not-installed" }),
      withLifecycleLock: async (_sandboxName, operation) => operation(),
    });

    expect(
      await supportedLifecycle(provider).stop(openClawLifecycleInput({ HOME: "/test-home" }), {
        beforeStop,
      }),
    ).toEqual({ exitCode: 0, state: "stopped" });
    expect(beforeStop).toHaveBeenCalledOnce();
    expect(captureSandboxLifecycle).toHaveBeenCalledWith("stop", "alpha", "nemoclaw", {
      HOME: "/test-home",
    });
  });

  it("fails closed when OpenShell cannot start the stopped sandbox (#11251)", async () => {
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle: () => ({ status: 1, output: "sandbox phase is Error" }),
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: false, status: "Exited (0) 1 second ago" },
      ],
      recoverPortableSandbox: async () => ({ kind: "not-installed" }),
      recoverSandbox: poison,
      withLifecycleLock: async (_sandboxName, operation) => operation(),
    });

    expect(await supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 1,
      message: "  OpenShell could not start sandbox 'alpha' (exit 1): sandbox phase is Error.",
    });
  });

  it("fails closed when OpenShell cannot stop the running sandbox (#11251)", async () => {
    const beforeStop = vi.fn();
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle: () => ({ status: 1, output: "gateway unavailable" }),
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: true, status: "Up 1 minute" },
      ],
      stopContainer: poison,
      stopPortableSandbox: async () => ({ kind: "not-installed" }),
      withLifecycleLock: async (_sandboxName, operation) => operation(),
    });

    expect(
      await supportedLifecycle(provider).stop(openClawLifecycleInput(), { beforeStop }),
    ).toEqual({
      exitCode: 1,
      message: "  OpenShell could not stop sandbox 'alpha' (exit 1): gateway unavailable.",
    });
    expect(beforeStop).toHaveBeenCalledOnce();
  });

  it("keeps an already-stopped sandbox idempotent without calling OpenShell (#11251)", async () => {
    const captureSandboxLifecycle = vi.fn(poison);
    const beforeStop = vi.fn(poison);
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      findLabeledSandboxContainers: () => [
        { name: "openshell-default--alpha-id", running: false, status: "Exited (0) 1 second ago" },
      ],
      stopPortableSandbox: async () => ({ kind: "not-installed" }),
      withLifecycleLock: async (_sandboxName, operation) => operation(),
    });

    expect(
      await supportedLifecycle(provider).stop(openClawLifecycleInput(), { beforeStop }),
    ).toEqual({
      exitCode: 0,
      state: "already-stopped",
    });
    expect(captureSandboxLifecycle).not.toHaveBeenCalled();
    expect(beforeStop).not.toHaveBeenCalled();
  });
});

describe("Docker provider start with a running container", () => {
  const runningContainer = {
    name: "openshell-default--alpha-id",
    running: true,
    status: "Up 10 minutes (healthy)",
  };

  function startWithPhase(
    phase: string | null,
    overrides: Partial<DockerRuntimeProviderDependencies> = {},
  ) {
    const captureSandboxLifecycle = vi.fn(() => ({ status: 0, output: "started" }));
    const sandboxNeedsLifecycleStart = vi.fn(() => phase === "Stopped");
    const provider = createDockerRuntimeProviderBundle({
      captureSandboxLifecycle,
      sandboxNeedsLifecycleStart,
      findLabeledSandboxContainers: () => [runningContainer],
      recoverPortableSandbox: async () => ({ kind: "not-installed" }),
      recoverSandbox: () => ({ recovered: true, via: "started-running-original" }),
      withLifecycleLock: async (_sandboxName, operation) => operation(),
      ...overrides,
    } as Partial<DockerRuntimeProviderDependencies>);
    return { captureSandboxLifecycle, provider, sandboxNeedsLifecycleStart };
  }

  it("starts a sandbox still reported Stopped while its container runs (#11790)", async () => {
    const { captureSandboxLifecycle, provider } = startWithPhase("Stopped");
    const input = openClawLifecycleInput({ HOME: "/test-home" });

    expect(await supportedLifecycle(provider).start(input)).toEqual({ exitCode: 0 });
    // Without this the container keeps running, the phase never leaves Stopped,
    // and the readiness wait in `start` times out on every later attempt.
    expect(captureSandboxLifecycle).toHaveBeenCalledWith("start", "alpha", "nemoclaw", {
      HOME: "/test-home",
    });
  });

  it("still reports a Ready sandbox as already running (#11790)", async () => {
    const { captureSandboxLifecycle, provider, sandboxNeedsLifecycleStart } =
      startWithPhase("Ready");

    expect(await supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 0,
    });
    expect(sandboxNeedsLifecycleStart).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw",
      expect.any(Object),
    );
    expect(captureSandboxLifecycle).not.toHaveBeenCalled();
  });

  it("does not start the sandbox when the phase cannot be observed", async () => {
    const { captureSandboxLifecycle, provider } = startWithPhase(null);

    expect(await supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 0,
    });
    expect(captureSandboxLifecycle).not.toHaveBeenCalled();
  });

  it("starts a running Stopped sandbox even when a GPU backup sibling exists", async () => {
    const { captureSandboxLifecycle, provider } = startWithPhase("Stopped", {
      findLabeledSandboxContainers: () => [
        runningContainer,
        { name: "alpha-nemoclaw-gpu-backup-1234", running: true, status: "Up 10 minutes" },
      ],
    } as Partial<DockerRuntimeProviderDependencies>);

    expect(await supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 0,
    });
    expect(captureSandboxLifecycle).toHaveBeenCalledWith(
      "start",
      "alpha",
      "nemoclaw",
      expect.any(Object),
    );
  });

  it("fails closed when OpenShell cannot start the Stopped sandbox", async () => {
    const { provider } = startWithPhase("Stopped", {
      captureSandboxLifecycle: () => ({ status: 1, output: "sandbox phase is Error" }),
    } as Partial<DockerRuntimeProviderDependencies>);

    expect(await supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 1,
      message: "  OpenShell could not start sandbox 'alpha' (exit 1): sandbox phase is Error.",
    });
  });

  it("does not probe the phase when a container is already at rest", async () => {
    const { captureSandboxLifecycle, provider, sandboxNeedsLifecycleStart } = startWithPhase(
      "Stopped",
      {
        findLabeledSandboxContainers: () => [
          {
            name: "openshell-default--alpha-id",
            running: false,
            status: "Exited (0) 1 second ago",
          },
        ],
        recoverSandbox: poison,
      } as Partial<DockerRuntimeProviderDependencies>,
    );

    expect(await supportedLifecycle(provider).start(openClawLifecycleInput())).toEqual({
      exitCode: 0,
    });
    expect(captureSandboxLifecycle).toHaveBeenCalledOnce();
    expect(sandboxNeedsLifecycleStart).not.toHaveBeenCalled();
  });
});

describe("Docker network command bounds", () => {
  it("uses the selected socket, output limit, and forced timeout for provisioning (#11606)", () => {
    const dockerRun = vi.spyOn(dockerCommands, "dockerRun").mockReturnValue({
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }),
      pid: 1,
      output: [],
    });
    const gateway = createDockerRuntimeProviderBundle().gateway as Extract<
      ReturnType<typeof createDockerRuntimeProviderBundle>["gateway"],
      { supported: true }
    >;
    const runtime = gateway.observeHostRuntime({ environment: {}, platform: "linux" });
    const args = ["network", "create", "--driver", "bridge", "--attachable", "generic-network"];
    const result = runtime.network.run(args, 30_000, {
      maxOutputBytes: 16 * 1024,
      environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
    });
    expect(dockerRun).toHaveBeenCalledWith(args, {
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      killSignal: "SIGKILL",
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
      ignoreError: true,
      suppressOutput: true,
    });
    expect(result).toMatchObject({
      status: null,
      signal: "SIGKILL",
      timedOut: true,
      errorCode: "ETIMEDOUT",
    });
  });
});
