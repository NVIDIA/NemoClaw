// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import {
  cleanupNativeGpuAttemptForFallback,
  executeSandboxGpuCreatePlan,
  isNativeGpuCreatePreBuildRejection,
  isNativeGpuCreateRoutingFailure,
  isNativeGpuReadinessRoutingFailure,
  type NativeGpuFallbackCleanupResult,
  type SandboxGpuCreateAttemptFailure,
  type SandboxGpuCreateFailureStage,
} from "./sandbox-gpu-create-attempt";

const SAFE_CLEANUP: NativeGpuFallbackCleanupResult = {
  safe: true,
  reason: null,
  deleteStatus: 0,
  sandboxPresent: false,
  containerIds: [],
};

describe("native GPU create failure classification", () => {
  it("accepts an argument rejection without treating unrelated build failures as routing", () => {
    const rejection = "error: unexpected argument '--gpu' found";
    expect(isNativeGpuCreatePreBuildRejection(rejection)).toBe(true);
    expect(isNativeGpuCreateRoutingFailure(rejection)).toBe(true);
    expect(
      isNativeGpuCreateRoutingFailure(
        "Docker build failed while compiling a GPU Python package for --gpu support",
      ),
    ).toBe(false);
    expect(isNativeGpuCreateRoutingFailure("x509: certificate signed by unknown authority")).toBe(
      false,
    );
  });

  it("requires GPU-specific evidence before treating readiness as a routing failure", () => {
    expect(isNativeGpuReadinessRoutingFailure("alpha Failed: policy denied startup exec")).toBe(
      false,
    );
    expect(
      isNativeGpuReadinessRoutingFailure(
        "alpha Error: NVIDIA GPU device initialization failed during sandbox startup",
      ),
    ).toBe(true);
  });
});

function nativeFailure(stage: SandboxGpuCreateFailureStage): SandboxGpuCreateAttemptFailure {
  return {
    ok: false,
    route: "native",
    stage,
    error: new Error(`native ${stage} failed`),
    fallbackEligible: true,
  };
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
      executeSandboxGpuCreatePlan("native-with-fallback", {
        runAttempt,
        captureNativeFailure,
        cleanupNativeFailure,
        prepareCompatibilityAttempt,
        activateCompatibilityAttempt,
        traceEvent,
      }),
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

    const result = await executeSandboxGpuCreatePlan("native-with-fallback", {
      runAttempt,
      captureNativeFailure: () => {
        order.push("diagnostics");
      },
      cleanupNativeFailure: async () => {
        order.push("cleanup");
        return SAFE_CLEANUP;
      },
      prepareCompatibilityAttempt: async () => {
        order.push("prepare-compatibility");
      },
      activateCompatibilityAttempt: async () => {
        order.push("activate-compatibility");
      },
      traceEvent,
    });

    expect(result).toEqual({
      ok: true,
      route: "compatibility",
      value: "compatibility-ready",
    });
    expect(runAttempt.mock.calls.map(([route]) => route)).toEqual(["native", "compatibility"]);
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

  it("refuses fallback when native cleanup cannot be proven safe", async () => {
    const runAttempt = vi.fn(async () => nativeFailure("readiness"));
    const prepareCompatibilityAttempt = vi.fn();
    const activateCompatibilityAttempt = vi.fn();
    const traceEvent = vi.fn();

    const result = await executeSandboxGpuCreatePlan("native-with-fallback", {
      runAttempt,
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
    });

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
    const result = await executeSandboxGpuCreatePlan("native-with-fallback", {
      runAttempt: vi.fn(async () => nativeFailure("readiness")),
      prepareCompatibilityAttempt: vi.fn(() => {
        throw new Error("no reusable image");
      }),
      cleanupNativeFailure,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, preparationRefused: "no reusable image" });
    expect(cleanupNativeFailure).not.toHaveBeenCalled();
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

    const result = await executeSandboxGpuCreatePlan("native-with-fallback", {
      runAttempt,
      cleanupNativeFailure: async () => SAFE_CLEANUP,
    });

    expect(result).toBe(compatibilityFailure);
    expect(runAttempt.mock.calls.map(([route]) => route)).toEqual(["native", "compatibility"]);
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not fallback when the native failure is ineligible", async () => {
    const ineligibleFailure = {
      ...nativeFailure("create"),
      fallbackEligible: false,
    };
    const runAttempt = vi.fn(async () => ineligibleFailure);
    const cleanupNativeFailure = vi.fn(async () => SAFE_CLEANUP);

    await expect(
      executeSandboxGpuCreatePlan("native-with-fallback", { runAttempt, cleanupNativeFailure }),
    ).resolves.toBe(ineligibleFailure);
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(cleanupNativeFailure).not.toHaveBeenCalled();
  });

  it("does not fallback when the route plan is native-only", async () => {
    const failure = nativeFailure("create");
    const runAttempt = vi.fn(async () => failure);
    const cleanupNativeFailure = vi.fn(async () => SAFE_CLEANUP);

    await expect(
      executeSandboxGpuCreatePlan("native-only", { runAttempt, cleanupNativeFailure }),
    ).resolves.toBe(failure);
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(cleanupNativeFailure).not.toHaveBeenCalled();
  });

  it("isolates cleanup verification across concurrent native fallback plans (#6110)", async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    };
    const firstCleanupEntered = deferred();
    const secondCleanupEntered = deferred();
    const firstRoutes: SelectedDockerGpuRoute[] = [];
    const secondRoutes: SelectedDockerGpuRoute[] = [];

    const runPlan = (
      routes: SelectedDockerGpuRoute[],
      cleanupNativeFailure: () => Promise<NativeGpuFallbackCleanupResult>,
    ) =>
      executeSandboxGpuCreatePlan("native-with-fallback", {
        runAttempt: vi.fn(async (route: SelectedDockerGpuRoute) => {
          routes.push(route);
          return route === "native"
            ? nativeFailure("create")
            : { ok: true as const, route, value: "compatibility-ready" };
        }),
        cleanupNativeFailure,
      });

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

describe("cleanupNativeGpuAttemptForFallback", () => {
  function openshellWithList(
    listResult: { status: number; stdout?: string; stderr?: string },
    deleteResult: { status: number; stdout?: string; stderr?: string } = { status: 0 },
  ) {
    return vi.fn((args: string[]) => (args[1] === "delete" ? deleteResult : listResult));
  }

  it("requires two stable sandbox and labeled-container absence checks", () => {
    const runOpenshell = openshellWithList({ status: 0, stdout: "" });
    const queryContainers = vi.fn(() => ({ ok: true as const, ids: [] }));

    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      { runOpenshell, queryContainers, sleep: vi.fn() },
      { maxAttempts: 3, stableAbsenceChecks: 2 },
    );

    expect(result).toEqual(SAFE_CLEANUP);
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell.mock.calls.filter(([args]) => args[1] === "list")).toHaveLength(2);
    expect(queryContainers).toHaveBeenCalledTimes(2);
  });

  it("permits fallback after a nonzero delete only when two checks prove complete absence", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList(
          { status: 0, stdout: "" },
          { status: 1, stderr: "delete denied" },
        ),
        queryContainers: () => ({ ok: true, ids: [] }),
      },
      { maxAttempts: 2, stableAbsenceChecks: 2 },
    );

    expect(result.safe).toBe(true);
    expect(result.deleteStatus).toBe(1);
    expect(result.reason).toBeNull();
  });

  it("refuses fallback when the OpenShell sandbox query fails", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList({ status: 1, stderr: "gateway unavailable" }),
        queryContainers: () => ({ ok: true, ids: [] }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.sandboxPresent).toBeNull();
    expect(result.reason).toContain("gateway unavailable");
  });

  it("refuses fallback when the labeled-container query fails", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList({ status: 0, stdout: "" }),
        queryContainers: () => ({ ok: false, ids: [], error: "docker daemon unavailable" }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.containerIds).toBeNull();
    expect(result.reason).toContain("docker daemon unavailable");
  });

  it("refuses fallback while any labeled container remains", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList(
          { status: 0, stdout: "" },
          { status: 1, stderr: "sandbox was never created" },
        ),
        queryContainers: () => ({ ok: true, ids: ["container-a", "container-b"] }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.deleteStatus).toBe(1);
    expect(result.containerIds).toEqual(["container-a", "container-b"]);
    expect(result.reason).toContain("container-a, container-b");
  });

  it("treats an exact sandbox row with no parseable status as present", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList({ status: 0, stdout: "alpha" }),
        queryContainers: () => ({ ok: true, ids: [] }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.sandboxPresent).toBe(true);
    expect(result.reason).toContain("still present");
  });
});
