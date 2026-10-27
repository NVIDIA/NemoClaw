// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import { startSandbox, type SandboxStartDeps } from "./start";

const nativeNvidiaEntry = {
  agent: "openclaw" as const,
  stopped: true,
  provider: "nvidia-prod",
  model: "nvidia/nemotron-3-super-120b-a12b",
  nativeNvidiaProviderAttachment: {
    schemaVersion: 1 as const,
    profileId: "nemoclaw-nvidia-inference-v1" as const,
    providerName: "nemoclaw-nvidia-prod-v1" as const,
    providerId: "provider-123",
  },
};

describe("start through the default gateway verifier", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
  });

  function startDeps(harness: ReturnType<typeof createConnectHarness>): SandboxStartDeps {
    return {
      getSandbox: () => harness.registryEntries[0] ?? null,
      updateSandbox: (_name, updates) => {
        Object.assign(harness.registryEntries[0]!, updates);
        return true;
      },
      runtimeProviders: createRuntimeProviderBundleRegistry([
        ["docker", createDockerRuntimeProviderBundle()],
      ]),
      openShellLifecycle: {
        startSandbox: async () => ({ kind: "accepted" }),
        stopSandbox: async () => ({ kind: "accepted" }),
      },
      recoverPortableSandbox: async () => ({ kind: "not-installed" }),
      qualifyLegacyPortableProfile: () => false,
      requalifyPortableSandbox: async () => ({ kind: "not-hermes" }),
      observer: {
        listSandboxes: async () => ({
          ok: true,
          value: { sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }] },
        }),
      },
      probeGatewayProcess: async () => true,
      withLifecycleLock: async (_name, operation) => operation(),
      log: vi.fn(),
    } as SandboxStartDeps;
  }

  it.each([
    { label: "HTTP 429", httpStatus: 429, timedOut: false },
    { label: "HTTP 500", httpStatus: 500, timedOut: false },
    { label: "confirmed timeout", httpStatus: null, timedOut: true },
  ])("reports degraded startup after a native NVIDIA $label", async (failure) => {
    const harness = createConnectHarness({ registryEntry: nativeNvidiaEntry });
    harness.nativeInferenceInvocationSpy.mockResolvedValue({
      ok: false,
      httpStatus: failure.httpStatus,
      ...(failure.timedOut ? { timedOut: true as const } : {}),
      detail: failure.label,
    });
    const deps = {
      ...startDeps(harness),
      probeInferenceInvocation: vi.fn(async () => ({
        ok: false as const,
        httpStatus: failure.httpStatus,
        ...(failure.timedOut ? { timedOut: true as const } : {}),
        detail: failure.label,
      })),
    };

    await expect(startSandbox("alpha", deps)).resolves.toEqual({ exitCode: 0 });
    expect(harness.verifyNativeNvidiaProviderAttachmentSpy).toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(deps.probeInferenceInvocation).toHaveBeenCalledOnce();
    expect(harness.registryEntries[0]?.stopped).toBe(false);
  });

  it("keeps native NVIDIA HTTP 401 terminal before startup is reported ready", async () => {
    const harness = createConnectHarness({ registryEntry: nativeNvidiaEntry });
    harness.nativeInferenceInvocationSpy.mockResolvedValue({
      ok: false,
      httpStatus: 401,
      detail: "HTTP 401",
    });
    const deps = { ...startDeps(harness), probeInferenceInvocation: vi.fn() };

    await expect(startSandbox("alpha", deps)).rejects.toThrow("process.exit(1)");
    expect(deps.probeInferenceInvocation).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });
});
