// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import { handlePreflightState, type PreflightStateOptions } from "./preflight";

type Gpu = { type: string } | null;
type SandboxEntry = { sandboxGpuEnabled?: boolean };
type Host = { cdiNvidiaGpuSpecMissing?: boolean };

function createDeps(overrides: Partial<PreflightStateOptions<Gpu, SandboxEntry, Host, { sandboxGpuEnabled: boolean; mode: string; sandboxGpuDevice?: string | null }>["deps"]> = {}) {
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
        const value = ({ sandboxGpuEnabled: true } satisfies SandboxEntry);
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
      detectGpu: () => ({ type: "nvidia" }) as Gpu,
      runPreflight: async () => ({ type: "nvidia" }) as Gpu,
      assessHost: () => ({ cdiNvidiaGpuSpecMissing: false }),
      assertCdiNvidiaGpuSpecPresent: vi.fn(),
      resolveSandboxGpuConfig: (_gpu: Gpu, opts: { flag: "enable" | "disable" | null; device: string | null | undefined }) => ({
        sandboxGpuEnabled: opts.flag === "enable",
        mode: opts.flag === "enable" ? "1" : "0",
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
  deps: PreflightStateOptions<Gpu, SandboxEntry, Host, { sandboxGpuEnabled: boolean; mode: string; sandboxGpuDevice?: string | null }>["deps"],
  session: Session | null = createSession(),
): PreflightStateOptions<Gpu, SandboxEntry, Host, { sandboxGpuEnabled: boolean; mode: string; sandboxGpuDevice?: string | null }> {
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
  });

  it("skips full preflight on resume but re-detects GPU and revalidates CDI/sandbox GPU", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    session.gpuPassthrough = false;
    const harness = createDeps({
      detectGpu: vi.fn(() => ({ type: "nvidia" }) as Gpu),
      assertCdiNvidiaGpuSpecPresent: vi.fn(),
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
      validation: "gpu-cdi",
    });
    expect(harness.deps.detectGpu).toHaveBeenCalledOnce();
    expect(harness.deps.runPreflight).not.toHaveBeenCalled();
    expect(harness.deps.startRecordedStep).not.toHaveBeenCalled();
    expect(harness.deps.assertCdiNvidiaGpuSpecPresent).toHaveBeenCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      true,
      undefined,
    );
    expect(harness.deps.validateSandboxGpuPreflight).toHaveBeenCalledOnce();
    expect(result.resumePreflight).toBe(true);
  });

  it("passes host GPU platform into the resumed CDI guard", async () => {
    const session = createSession();
    session.steps.preflight.status = "complete";
    const assertCdiNvidiaGpuSpecPresent = vi.fn();
    const harness = createDeps({
      assertCdiNvidiaGpuSpecPresent,
      resolveSandboxGpuConfig: vi.fn(
        (_gpu: Gpu, opts: { flag: "enable" | "disable" | null; device: string | null | undefined }) => ({
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

    expect(assertCdiNvidiaGpuSpecPresent).toHaveBeenCalledWith(
      { cdiNvidiaGpuSpecMissing: false },
      true,
      "jetson",
    );
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
    expect(getResumeSandboxGpuOverrides).toHaveBeenCalledWith(
      { sandboxGpuEnabled: true },
      true,
    );
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
