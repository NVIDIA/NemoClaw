// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  renderCompatibilityFallbackCreateArgs,
  type SelectedDockerGpuRoute,
} from "./docker-gpu-route";
import {
  executeSandboxGpuCreatePlan,
  type NativeGpuFallbackCleanupResult,
  type SandboxGpuCreateAttemptFailure,
  type SandboxGpuCreateFailureStage,
  type SandboxGpuCreatePlanDeps,
} from "./sandbox-gpu-create-attempt";

const SAFE_CLEANUP: NativeGpuFallbackCleanupResult = {
  safe: true,
  reason: null,
  deleteStatus: 0,
  sandboxPresent: false,
  containerIds: [],
};

function nativeFailure(stage: SandboxGpuCreateFailureStage): SandboxGpuCreateAttemptFailure {
  return {
    ok: false,
    route: "native",
    stage,
    error: new Error(`native ${stage} failed`),
    fallbackEligible: true,
  };
}

function planDeps<T>(
  runAttempt: SandboxGpuCreatePlanDeps<T>["runAttempt"],
  overrides: Partial<Omit<SandboxGpuCreatePlanDeps<T>, "runAttempt">> = {},
): SandboxGpuCreatePlanDeps<T> {
  return {
    runAttempt,
    cleanupNativeFailure: vi.fn(async () => SAFE_CLEANUP),
    prepareCompatibilityAttempt: vi.fn(),
    activateCompatibilityAttempt: vi.fn(),
    ...overrides,
  };
}

function execute<T>(
  deps: SandboxGpuCreatePlanDeps<T>,
  plan: Parameters<typeof executeSandboxGpuCreatePlan>[0] = "native-with-fallback",
) {
  return executeSandboxGpuCreatePlan(plan, deps);
}

const attemptedRoutes = (runAttempt: ReturnType<typeof vi.fn>) =>
  runAttempt.mock.calls.map(([route]) => route);

function record<T>(order: string[], event: string, result?: T) {
  order.push(event);
  return result as T;
}

describe("executeSandboxGpuCreatePlan", () => {
  it("accepts native success without cleanup or compatibility work and emits a trace event", async () => {
    const runAttempt = vi.fn(async (route: SelectedDockerGpuRoute) => ({
      ok: true as const,
      route,
      value: "native-ready",
    }));
    const captureNativeFailure = vi.fn();
    const cleanupNativeFailure = vi.fn(async () => SAFE_CLEANUP);
    const prepareCompatibilityAttempt = vi.fn();
    const activateCompatibilityAttempt = vi.fn();
    const traceEvent = vi.fn();

    await expect(
      execute(
        planDeps(runAttempt, {
          captureNativeFailure,
          cleanupNativeFailure,
          prepareCompatibilityAttempt,
          activateCompatibilityAttempt,
          traceEvent,
        }),
      ),
    ).resolves.toEqual({ ok: true, route: "native", value: "native-ready" });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(runAttempt).toHaveBeenCalledWith("native");
    expect(captureNativeFailure).not.toHaveBeenCalled();
    expect(cleanupNativeFailure).not.toHaveBeenCalled();
    expect(prepareCompatibilityAttempt).not.toHaveBeenCalled();
    expect(activateCompatibilityAttempt).not.toHaveBeenCalled();
    expect(traceEvent).toHaveBeenCalledWith("gpu_native_success", { route: "native" });
  });

  it.each([
    "create",
    "readiness",
    "gpu-proof",
  ] as const)("falls back once after a native %s failure and preserves diagnostics/cleanup ordering", async (stage) => {
    const order: string[] = [];
    const runAttempt = vi.fn(async (route: SelectedDockerGpuRoute) => {
      order.push(`attempt:${route}`);
      return route === "native"
        ? nativeFailure(stage)
        : { ok: true as const, route, value: "compatibility-ready" };
    });
    const traceEvent = vi.fn((name: string) => order.push(`trace:${name}`));

    const result = await execute({
      runAttempt,
      captureNativeFailure: () => record(order, "diagnostics"),
      cleanupNativeFailure: async () => record(order, "cleanup", SAFE_CLEANUP),
      prepareCompatibilityAttempt: async () => record(order, "prepare-compatibility"),
      activateCompatibilityAttempt: async () => record(order, "activate-compatibility"),
      traceEvent,
    });

    expect(result).toEqual({
      ok: true,
      route: "compatibility",
      value: "compatibility-ready",
    });
    expect(attemptedRoutes(runAttempt)).toEqual(["native", "compatibility"]);
    expect(order).toEqual([
      "attempt:native",
      "diagnostics",
      "prepare-compatibility",
      "cleanup",
      "activate-compatibility",
      "trace:gpu_compatibility_fallback",
      "attempt:compatibility",
    ]);
    expect(traceEvent).toHaveBeenCalledWith("gpu_compatibility_fallback", {
      from_route: "native",
      to_route: "compatibility",
      failure_stage: stage,
    });
  });

  it("prepares and renders the built image before the single compatibility retry", async () => {
    const imageRef = `sha256:${"a".repeat(64)}`;
    let compatibilityArgs: string[] | null = null;
    const runAttempt = vi.fn(async (route: SelectedDockerGpuRoute) =>
      route === "native"
        ? nativeFailure("create")
        : { ok: true as const, route, value: compatibilityArgs },
    );

    await expect(
      execute(
        planDeps(runAttempt, {
          prepareCompatibilityAttempt: () => {
            compatibilityArgs = renderCompatibilityFallbackCreateArgs(
              ["--from", "/tmp/build/Dockerfile", "--policy", "/tmp/native.yaml", "--gpu"],
              {
                imageRef,
                compatibilityPolicyPath: "/tmp/compatibility.yaml",
              },
            );
          },
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      route: "compatibility",
      value: ["--from", imageRef, "--policy", "/tmp/compatibility.yaml"],
    });
    expect(attemptedRoutes(runAttempt)).toEqual(["native", "compatibility"]);
  });

  it("refuses fallback when native cleanup cannot be proven safe", async () => {
    const runAttempt = vi.fn(async () => nativeFailure("readiness"));
    const prepareCompatibilityAttempt = vi.fn();
    const activateCompatibilityAttempt = vi.fn();
    const traceEvent = vi.fn();

    const result = await execute(
      planDeps(runAttempt, {
        cleanupNativeFailure: async () => ({
          safe: false,
          reason: "labeled Docker containers remain: deadbeef",
          deleteStatus: 0,
          sandboxPresent: false,
          containerIds: ["deadbeef"],
        }),
        prepareCompatibilityAttempt,
        activateCompatibilityAttempt,
        traceEvent,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      cleanupRefused: expect.stringContaining("labeled Docker containers remain"),
    });
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(prepareCompatibilityAttempt).toHaveBeenCalledOnce();
    expect(activateCompatibilityAttempt).not.toHaveBeenCalled();
    expect(traceEvent).not.toHaveBeenCalledWith("gpu_compatibility_fallback", expect.anything());
  });

  it("keeps the failed native sandbox when compatibility retry preparation fails", async () => {
    const cleanupNativeFailure = vi.fn(async () => SAFE_CLEANUP);
    const activateCompatibilityAttempt = vi.fn();
    const result = await execute(
      planDeps(
        vi.fn(async () => nativeFailure("readiness")),
        {
          prepareCompatibilityAttempt: vi.fn(() => {
            throw new Error("no reusable image");
          }),
          activateCompatibilityAttempt,
          cleanupNativeFailure,
        },
      ),
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, preparationRefused: "no reusable image" });
    expect(cleanupNativeFailure).not.toHaveBeenCalled();
    expect(activateCompatibilityAttempt).not.toHaveBeenCalled();
  });

  it("returns a compatibility failure without attempting a third route", async () => {
    const compatibilityFailure: SandboxGpuCreateAttemptFailure = {
      ok: false,
      route: "compatibility",
      stage: "readiness",
      error: new Error("compatibility failed"),
      fallbackEligible: false,
    };
    const runAttempt = vi.fn(async (route: SelectedDockerGpuRoute) =>
      route === "native" ? nativeFailure("create") : compatibilityFailure,
    );

    const result = await execute(planDeps(runAttempt));

    expect(result).toBe(compatibilityFailure);
    expect(attemptedRoutes(runAttempt)).toEqual(["native", "compatibility"]);
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["does not fallback when the native failure is ineligible", "native-with-fallback", false],
    ["does not fallback when the route plan is native-only", "native-only", true],
  ] as const)("%s (fallback gating)", async (_title, plan, fallbackEligible) => {
    const failure = { ...nativeFailure("create"), fallbackEligible };
    const runAttempt = vi.fn(async () => failure);
    const cleanupNativeFailure = vi.fn(async () => SAFE_CLEANUP);

    await expect(execute(planDeps(runAttempt, { cleanupNativeFailure }), plan)).resolves.toBe(
      failure,
    );
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(cleanupNativeFailure).not.toHaveBeenCalled();
  });

  it("isolates cleanup verification across concurrent native fallback plans (#6110)", async () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    }
    const firstCleanupEntered = deferred();
    const secondCleanupEntered = deferred();
    const firstRoutes: SelectedDockerGpuRoute[] = [];
    const secondRoutes: SelectedDockerGpuRoute[] = [];

    const runPlan = (
      routes: SelectedDockerGpuRoute[],
      cleanupNativeFailure: () => Promise<NativeGpuFallbackCleanupResult>,
    ) =>
      execute(
        planDeps(
          vi.fn(async (route: SelectedDockerGpuRoute) => {
            routes.push(route);
            return route === "native"
              ? nativeFailure("create")
              : { ok: true as const, route, value: "compatibility-ready" };
          }),
          { cleanupNativeFailure },
        ),
      );

    const first = runPlan(firstRoutes, async () => {
      firstCleanupEntered.resolve();
      await secondCleanupEntered.promise;
      return SAFE_CLEANUP;
    });
    const second = runPlan(secondRoutes, async () => {
      secondCleanupEntered.resolve();
      await firstCleanupEntered.promise;
      return SAFE_CLEANUP;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, route: "compatibility", value: "compatibility-ready" },
      { ok: true, route: "compatibility", value: "compatibility-ready" },
    ]);
    expect(firstRoutes).toEqual(["native", "compatibility"]);
    expect(secondRoutes).toEqual(["native", "compatibility"]);
  });
});
