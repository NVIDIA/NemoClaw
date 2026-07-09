// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "../sandbox/create-stream";
import {
  dockerEnv,
  FakeChild,
  makePollingOptions,
  vmEnv,
} from "../sandbox/create-stream-test-fixtures";
import {
  runSandboxCreateStep,
  type SandboxCreateStepContext,
  type SandboxCreateStepDeps,
} from "./sandbox-create-step";

function makeLaunch(overrides: Record<string, unknown> = {}) {
  return {
    createCommand: "openshell sandbox create alpha",
    effectiveDashboardPort: "18789",
    envArgs: [],
    sandboxEnv: { FOO: "bar" },
    sandboxStartupCommand: ["run", "alpha"],
    prebuild: { imageRef: "img:tag", createArgs: ["sandbox", "create", "alpha"] },
    ...overrides,
  };
}

function makePatch() {
  return {
    maybeApplyDuringCreate: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    ensureApplied: vi.fn(),
  };
}

function makeContext(overrides: Partial<SandboxCreateStepContext> = {}): SandboxCreateStepContext {
  // Cast once at the boundary: hermesDashboardState / openshellShellCommand /
  // prebuild are structural seams this orchestration test does not exercise.
  const base = {
    agent: null,
    observabilityEnabled: false,
    chatUiUrl: "",
    createArgs: ["sandbox", "create", "alpha"],
    sandboxName: "alpha",
    env: {},
    extraPlaceholderKeys: [],
    getDashboardForwardPort: () => "18789",
    hermesDashboardState: null,
    manageDashboard: false,
    openshellShellCommand: null,
    prebuild: { buildCtx: "/tmp/ctx", buildId: "b1", dockerDriverGateway: null, origin: "local" },
    useDockerGpuPatch: false,
    gpuDevice: null,
    gpuBackend: "generic" as const,
    timeoutSecs: 300,
  };
  return { ...base, ...overrides } as unknown as SandboxCreateStepContext;
}

function makeDeps(
  launch: ReturnType<typeof makeLaunch>,
  patch: ReturnType<typeof makePatch>,
  createResult: { status: number; output: string },
  overrides: Partial<SandboxCreateStepDeps> = {},
): SandboxCreateStepDeps {
  return {
    prepareCreateLaunch: vi.fn(async () => launch),
    createDockerGpuPatch: vi.fn(() => patch),
    streamCreate: vi.fn(async () => createResult),
    isSandboxReady: vi.fn(() => false),
    isTerminalAgent: vi.fn(() => false),
    addTraceEvent: vi.fn(),
    runOpenshell: vi.fn(() => ({ status: 0, output: "" })),
    runCaptureOpenshell: vi.fn(() => "sandbox-list"),
    sleepSeconds: vi.fn(),
    ...overrides,
  } as unknown as SandboxCreateStepDeps;
}

describe("runSandboxCreateStep", () => {
  it("threads the prebuild handoff into launch, GPU patch, and stream, and returns the handles", async () => {
    const launch = makeLaunch();
    const patch = makePatch();
    const createResult = { status: 0, output: "created" };
    const deps = makeDeps(launch, patch, createResult);

    const result = await runSandboxCreateStep(
      makeContext({
        useDockerGpuPatch: true,
        gpuDevice: "nvidia.com/gpu=all",
        gpuBackend: "jetson",
      }),
      deps,
    );

    // prepareCreateLaunch receives the assembled launch input incl. the prebuild handoff.
    expect(deps.prepareCreateLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        prebuild: {
          buildCtx: "/tmp/ctx",
          buildId: "b1",
          dockerDriverGateway: null,
          origin: "local",
        },
      }),
    );
    // GPU patch is created with the startup command from the launch result + backend/device.
    expect(deps.createDockerGpuPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        openshellSandboxCommand: ["run", "alpha"],
        gpuDevice: "nvidia.com/gpu=all",
        backend: "jetson",
      }),
    );
    // stream is fed the launch command + env.
    expect(deps.streamCreate).toHaveBeenCalledWith(
      "openshell sandbox create alpha",
      { FOO: "bar" },
      expect.objectContaining({ traceEvent: deps.addTraceEvent }),
    );
    // Handles returned for downstream consumers.
    expect(result).toEqual({
      createResult,
      prebuild: launch.prebuild,
      effectiveDashboardPort: "18789",
      dockerGpuCreatePatch: patch,
    });
  });

  it("separates readiness detection from GPU patch polling", async () => {
    const launch = makeLaunch();
    const patch = makePatch();
    const deps = makeDeps(
      launch,
      patch,
      { status: 0, output: "" },
      { isSandboxReady: vi.fn(() => true) },
    );

    await runSandboxCreateStep(makeContext(), deps);
    const streamOpts = (deps.streamCreate as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][2] as { readyCheck: () => boolean; onPoll: () => void };

    expect(streamOpts.readyCheck()).toBe(true);
    expect(patch.maybeApplyDuringCreate).not.toHaveBeenCalled();

    (deps.isSandboxReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(streamOpts.readyCheck()).toBe(false);
    expect(patch.maybeApplyDuringCreate).not.toHaveBeenCalled();

    streamOpts.onPoll();
    expect(patch.maybeApplyDuringCreate).toHaveBeenCalledTimes(1);
  });

  it("threads the terminal-agent early-ready gate into stream options", async () => {
    const terminalDeps = makeDeps(
      makeLaunch(),
      makePatch(),
      { status: 0, output: "" },
      {
        isTerminalAgent: vi.fn(() => true),
      },
    );
    await runSandboxCreateStep(makeContext(), terminalDeps);
    expect(
      (terminalDeps.streamCreate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2],
    ).toMatchObject({ readyCheckOutputPatterns: [] });

    const nonTerminalDeps = makeDeps(makeLaunch(), makePatch(), { status: 0, output: "" });
    await runSandboxCreateStep(makeContext(), nonTerminalDeps);
    expect(
      (nonTerminalDeps.streamCreate as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0][2],
    ).toMatchObject({ readyCheckOutputPatterns: undefined });
  });

  it.each([
    ["terminal VM", true, vmEnv, false],
    ["terminal Docker", true, dockerEnv, false],
    ["non-terminal VM", false, vmEnv, true],
    ["non-terminal Docker", false, dockerEnv, false],
  ])("applies driver-aware detach behavior for %s", async (_label, isTerminalAgent, env, shouldWaitForStartupOutput) => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const logLine = vi.fn();
    const streamOptions = makePollingOptions(child, { logLine });
    const deps = makeDeps(
      makeLaunch({ sandboxEnv: env }),
      makePatch(),
      { status: 0, output: "" },
      {
        streamCreate: ((command, sandboxEnv, options) =>
          streamSandboxCreate(command, sandboxEnv, {
            ...options,
            ...streamOptions,
          })) as SandboxCreateStepDeps["streamCreate"],
        isTerminalAgent: vi.fn(() => isTerminalAgent),
      },
    );
    let ready = false;
    deps.isSandboxReady = vi.fn(() => ready);
    deps.addTraceEvent = vi.fn();

    const promise = runSandboxCreateStep(makeContext(), deps);
    child.stdout.emit("data", Buffer.from("Created sandbox: alpha\n"));
    ready = true;
    await vi.advanceTimersByTimeAsync(6);

    const waitMessage =
      "  Sandbox reported Ready; waiting for startup command output before detaching.";
    if (shouldWaitForStartupOutput) {
      expect(child.kill).not.toHaveBeenCalled();
      expect(logLine).toHaveBeenCalledWith(waitMessage);
      child.stderr.emit("data", Buffer.from("Setting up NemoClaw (Hermes)...\n"));
      await vi.advanceTimersByTimeAsync(6);
    } else {
      expect(logLine).not.toHaveBeenCalledWith(waitMessage);
    }

    await expect(promise).resolves.toMatchObject({
      createResult: expect.objectContaining({ status: 0, forcedReady: true }),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });
});
