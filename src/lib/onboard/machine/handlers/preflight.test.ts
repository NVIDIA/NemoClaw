// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { GpuDetection } from "../../../inference/nim";
import { createSession, type Session } from "../../../state/onboard-session";
import { resolveSandboxGpuConfig } from "../../sandbox-gpu-mode";
import { handlePreflightState, type PreflightStateOptions } from "./preflight";

type Gpu = GpuDetection | null;
type SandboxEntry = { sandboxGpuEnabled?: boolean };
type Host = { cdiNvidiaGpuSpecMissing?: boolean };

function createDeps(
  overrides: Partial<
    PreflightStateOptions<
      Gpu,
      SandboxEntry,
      Host,
      { sandboxGpuEnabled: boolean; mode: string; sandboxGpuDevice?: string | null }
    >["deps"]
  > = {},
) {
  let session = createSession();
  return {
    calls: {
      start: vi.fn(),
      complete: vi.fn(),
      skipped: vi.fn(),
      detectGpu: vi.fn(() => ({ type: "nvidia" }) as Gpu),
      runPreflight: vi.fn(async () => ({ type: "nvidia" }) as Gpu),
      validate: vi.fn(),
      cdi: vi.fn(),
      updateSession: vi.fn(),
      getSandbox: vi.fn(() => ({ sandboxGpuEnabled: true })),
      getOverrides: vi.fn(() => ({ flag: "enable" as const, device: "0" })),
    },
    deps: {
      getSandbox: (name: string) => {
        const value = { sandboxGpuEnabled: true } satisfies SandboxEntry;
        return overrides.getSandbox ? overrides.getSandbox(name) : value;
      },
      getResumeSandboxGpuOverrides: (
        sandbox: SandboxEntry | null,
        sessionGpuPassthrough: boolean | null | undefined,
      ) => {
        if (overrides.getResumeSandboxGpuOverrides) {
          return overrides.getResumeSandboxGpuOverrides(sandbox, sessionGpuPassthrough);
        }
        return { flag: "enable" as const, device: "0" };
      },
      detectGpuForReadiness: () => ({ type: "nvidia" }) as Gpu,
      detectGpu: () => ({ type: "nvidia" }) as Gpu,
      runPreflight: async () => ({ type: "nvidia" }) as Gpu,
      assessHost: () => ({ cdiNvidiaGpuSpecMissing: false }),
      assertOnboardHostReadiness: vi.fn(),
      assertGatewayReadiness: vi.fn(async () => undefined),
      resolveSandboxGpuConfig: (
        _gpu: Gpu,
        opts: { flag: "enable" | "disable" | null; device: string | null | undefined },
      ) => ({
        sandboxGpuEnabled: opts.flag === "enable",
        mode: opts.flag === "enable" ? "1" : opts.flag === "disable" ? "0" : "auto",
        sandboxGpuDevice: opts.device,
      }),
      validateSandboxGpuPreflight: vi.fn(),
      skippedStepMessage: vi.fn(),
      recordStateSkipped: vi.fn(async () => session),
      startRecordedStep: vi.fn(async () => undefined),
      recordStepComplete: vi.fn(async () => session),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        session = mutator(session) ?? session;
        return session;
      }),
      ...overrides,
    },
    getSession: () => session,
  };
}

function baseOptions(
  deps: PreflightStateOptions<
    Gpu,
    SandboxEntry,
    Host,
    { sandboxGpuEnabled: boolean; mode: string; sandboxGpuDevice?: string | null }
  >["deps"],
  session: Session | null = createSession(),
): PreflightStateOptions<
  Gpu,
  SandboxEntry,
  Host,
  { sandboxGpuEnabled: boolean; mode: string; sandboxGpuDevice?: string | null }
> {
  return {
    resume: false,
    session,
    recordedSandboxName: null,
    requestedSandboxName: "my-assistant",
    explicitSandboxGpuFlag: null,
    sandboxGpuDevice: null,
    gpuRequested: false,
    noGpu: false,
    env: {},
    deps,
  };
}

describe("handlePreflightState", () => {
  it("runs full preflight through recorded step boundaries", async () => {
    const harness = createDeps({
      startRecordedStep: vi.fn(async () => undefined),
      runPreflight: vi.fn(async () => ({ type: "nvidia" }) as Gpu),
      recordStepComplete: vi.fn(async () => createSession()),
    });

    const result = await handlePreflightState({
      ...baseOptions(harness.deps),
      explicitSandboxGpuFlag: "enable",
      sandboxGpuDevice: "GPU-0",
    });

    expect(harness.deps.startRecordedStep).toHaveBeenCalledWith("preflight");
    expect(harness.deps.runPreflight).toHaveBeenCalledWith({ optedOutGpuPassthrough: false });
    expect(harness.deps.recordStepComplete).toHaveBeenCalledWith("preflight");
    expect(result.sandboxGpuConfig).toMatchObject({
      sandboxGpuEnabled: true,
      mode: "1",
      sandboxGpuDevice: "GPU-0",
    });
    expect(result.gpuPassthrough).toBe(true);
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "gateway",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "preflight", gpuPassthrough: true },
    });
  });

  it("keeps sandbox GPU disabled when N1X spoof detection yields no NVIDIA GPU", async () => {
    const harness = createDeps({
      runPreflight: vi.fn(async () => null),
      resolveSandboxGpuConfig,
    });

    const result = await handlePreflightState({
      ...baseOptions(harness.deps),
    });

    expect(harness.deps.runPreflight).toHaveBeenCalledWith({ optedOutGpuPassthrough: false });
    expect(result.gpu).toBeNull();
    expect(result.sandboxGpuConfig).toMatchObject({
      mode: "auto",
      hostGpuDetected: false,
      sandboxGpuEnabled: false,
    });
    expect(result.gpuPassthrough).toBe(false);
  });

  it("skips recorded preflight on resume but re-runs live host readiness (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    session.gpuPassthrough = false;
    const harness = createDeps({
      detectGpu: vi.fn(() => ({ type: "nvidia" }) as Gpu),
      assertOnboardHostReadiness: vi.fn(),
      validateSandboxGpuPreflight: vi.fn(),
      skippedStepMessage: vi.fn(),
      startRecordedStep: vi.fn(async () => undefined),
      runPreflight: vi.fn(async () => ({ type: "should-not-run" }) as Gpu),
    });

    const result = await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      gpuRequested: false,
    });

    expect(harness.deps.skippedStepMessage).toHaveBeenCalledWith("preflight", "cached");
    expect(harness.deps.recordStateSkipped).toHaveBeenCalledWith("preflight", {
      reason: "resume",
      validation: "host-readiness",
    });
    expect(harness.deps.detectGpu).toHaveBeenCalledOnce();
    expect(harness.deps.runPreflight).not.toHaveBeenCalled();
    expect(harness.deps.startRecordedStep).not.toHaveBeenCalled();
    expect(harness.deps.assertOnboardHostReadiness).toHaveBeenCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      { type: "nvidia" },
      expect.objectContaining({ explicitlyOptedOutGpuPassthrough: false, resuming: true }),
    );
    expect(harness.deps.validateSandboxGpuPreflight).toHaveBeenCalledOnce();
    expect(result.resumePreflight).toBe(true);
  });

  it("carries verified N1x intent through cached resume readiness (#9292)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const assertOnboardHostReadiness = vi.fn();
    const harness = createDeps({ assertOnboardHostReadiness });

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      allowDeferredN1xManagedVllm: true,
    });

    expect(assertOnboardHostReadiness).toHaveBeenCalledTimes(2);
    expect(assertOnboardHostReadiness).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
    expect(assertOnboardHostReadiness).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ allowDeferredN1xManagedVllm: true }),
    );
  });

  it("rejects changed gateway ownership before cached resume probe effects (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const assertRuntimeProviderHealthy = vi.fn();
    const detectGpu = vi.fn(() => ({ type: "nvidia" }) as Gpu);
    const harness = createDeps({
      assertGatewayReadiness: vi.fn(async () => {
        throw new Error("gateway ownership changed");
      }),
      detectGpu,
      assertRuntimeProviderHealthy,
    });

    await expect(
      handlePreflightState({
        ...baseOptions(harness.deps, session),
        resume: true,
      }),
    ).rejects.toThrow("gateway ownership changed");
    expect(detectGpu).not.toHaveBeenCalled();
    expect(assertRuntimeProviderHealthy).not.toHaveBeenCalled();
  });

  it("admits live host and gateway facts and presents advisories before a cached resume GPU proof (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const calls: string[] = [];
    const harness = createDeps({
      assessHost: () => {
        calls.push("host-observation");
        return { cdiNvidiaGpuSpecMissing: false };
      },
      detectGpuForReadiness: () => {
        calls.push("gpu-observation");
        return null;
      },
      assertOnboardHostReadiness: (_host, _gpu, options) => {
        calls.push("host-admission");
        calls.push(
          options.presentAdvisories === false ? "host-advisories-suppressed" : "host-advisories",
        );
      },
      assertGatewayReadiness: async () => {
        calls.push("gateway-admission");
      },
      detectGpu: () => {
        calls.push("gpu-runtime-proof");
        return { type: "nvidia" } as Gpu;
      },
      assertRuntimeProviderHealthy: () => {
        calls.push("gpu-validation");
        calls.push("bridge-dns");
      },
    });

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
    });

    expect(calls).toEqual([
      "host-observation",
      "gpu-observation",
      "gateway-admission",
      "host-admission",
      "host-advisories",
      "gpu-runtime-proof",
      "host-observation",
      "gateway-admission",
      "host-admission",
      "host-advisories-suppressed",
      "gpu-validation",
      "bridge-dns",
    ]);
  });

  it("passes the fresh host and GPU observations into resumed readiness (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const assertOnboardHostReadiness = vi.fn();
    const harness = createDeps({
      assertOnboardHostReadiness,
      resolveSandboxGpuConfig: vi.fn(
        (
          _gpu: Gpu,
          opts: { flag: "enable" | "disable" | null; device: string | null | undefined },
        ) => ({
          sandboxGpuEnabled: opts.flag === "enable",
          mode: opts.flag === "enable" ? "1" : "0",
          sandboxGpuDevice: opts.device,
          hostGpuPlatform: "jetson",
        }),
      ),
    });

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      explicitSandboxGpuFlag: "enable",
    });

    expect(assertOnboardHostReadiness).toHaveBeenCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      { type: "nvidia" },
      expect.objectContaining({ explicitlyOptedOutGpuPassthrough: false, resuming: true }),
    );
  });

  it("preserves a failed resumed WSL GPU proof for canonical readiness (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const assertOnboardHostReadiness = vi.fn();
    const harness = createDeps({
      detectGpuForReadiness: () => null,
      detectGpu: () => null,
      assertOnboardHostReadiness,
      resolveSandboxGpuConfig,
    });

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      explicitSandboxGpuFlag: "enable",
    });

    expect(assertOnboardHostReadiness).toHaveBeenLastCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      null,
      expect.objectContaining({
        explicitlyOptedOutGpuPassthrough: false,
        wslDockerDesktopGpuProofPassed: false,
        resuming: true,
      }),
    );
  });

  it("reuses environment CPU-only intent when validating a cached preflight (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const assertOnboardHostReadiness = vi.fn();
    const harness = createDeps({
      assertOnboardHostReadiness,
      resolveSandboxGpuConfig,
    });

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      env: { NEMOCLAW_SANDBOX_GPU: "0" },
    });

    expect(assertOnboardHostReadiness).toHaveBeenCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      { type: "nvidia" },
      expect.objectContaining({ explicitlyOptedOutGpuPassthrough: true, resuming: true }),
    );
  });

  it("does not treat an old auto-disabled session outcome as explicit CPU-only intent (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    session.gpuPassthrough = false;
    const assertOnboardHostReadiness = vi.fn();
    const harness = createDeps({
      assertOnboardHostReadiness,
      getResumeSandboxGpuOverrides: () => ({ flag: null, device: null }),
      resolveSandboxGpuConfig,
    });

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      env: {},
    });

    expect(assertOnboardHostReadiness).toHaveBeenCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      { type: "nvidia" },
      expect.objectContaining({ explicitlyOptedOutGpuPassthrough: false, resuming: true }),
    );
  });

  it("rejects a cached resume when host collection exceeds the freshness window (#7411)", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    let currentTime = Date.parse("2026-08-07T12:00:00.000Z");
    const detectGpu = vi.fn(() => ({ type: "nvidia" }) as Gpu);
    const bridge = vi.fn();
    const harness = createDeps({
      now: () => new Date(currentTime),
      assessHost: () => {
        currentTime += 30_001;
        return { cdiNvidiaGpuSpecMissing: false };
      },
      assertOnboardHostReadiness: (_host, _gpu, options) => {
        expect(options.observedAt).toBe("2026-08-07T12:00:00.000Z");
        const age = currentTime - Date.parse(options.observedAt as string);
        expect(age).toBeGreaterThan(30_000);
        throw new Error("host observations are stale");
      },
      detectGpu,
      assertRuntimeProviderHealthy: bridge,
    });

    await expect(
      handlePreflightState({ ...baseOptions(harness.deps, session), resume: true }),
    ).rejects.toThrow("host observations are stale");
    expect(detectGpu).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("restores saved sandbox GPU intent only when resume has no explicit override", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    session.gpuPassthrough = true;
    const getResumeSandboxGpuOverrides = vi.fn(() => ({ flag: "enable" as const, device: "1" }));
    const getSandbox = vi.fn(() => ({ sandboxGpuEnabled: true }));
    const harness = createDeps({ getResumeSandboxGpuOverrides, getSandbox });

    const result = await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      recordedSandboxName: "saved",
    });

    expect(getSandbox).toHaveBeenCalledWith("saved");
    expect(getResumeSandboxGpuOverrides).toHaveBeenCalledWith({ sandboxGpuEnabled: true }, true);
    expect(result.resumeHasResolvedGpuIntent).toBe(true);
    expect(result.effectiveSandboxGpuFlag).toBe("enable");
    expect(result.effectiveSandboxGpuDevice).toBe("1");

    await handlePreflightState({
      ...baseOptions(harness.deps, session),
      resume: true,
      explicitSandboxGpuFlag: "disable",
    });
    expect(getResumeSandboxGpuOverrides).toHaveBeenCalledTimes(1);
  });

  it("persists effective GPU passthrough intent for later resume", async () => {
    const session = createSession();
    session.gpuPassthrough = false;
    const harness = createDeps();

    const result = await handlePreflightState({
      ...baseOptions(harness.deps, session),
      explicitSandboxGpuFlag: "enable",
    });

    expect(result.session?.gpuPassthrough).toBe(true);
    expect(harness.deps.updateSession).toHaveBeenCalledOnce();
  });
});
