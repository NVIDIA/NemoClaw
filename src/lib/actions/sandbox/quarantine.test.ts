// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { RuntimeProviderBundle } from "../../onboard/runtime-provider/contract";
import type { SandboxQuarantineReceipt } from "../../state/registry/quarantine-receipt";
import type { SandboxEntry, SandboxQuarantineFence } from "../../state/registry/types";
import {
  quarantineSandbox,
  releaseSandboxQuarantine,
  type QuarantineSandboxDeps,
} from "./quarantine/index";

const LIVE_ID = "a".repeat(64);
const PROVIDER_HANDLE = "b".repeat(64);
const RUNTIME_HANDLE = "c".repeat(64);
const FENCE_ID = "00000000-0000-4000-8000-000000000001";

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    openshellDriver: "docker",
    lifecycleGeneration: "registry-generation-1",
    lifecycleLiveIdentityFingerprint: LIVE_ID,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...overrides,
  };
}

function harness(
  options: { serviceAccessFails?: boolean; workloadFails?: boolean; initial?: SandboxEntry } = {},
) {
  const order: string[] = [];
  let current = options.initial ?? sandbox();
  let runtimeState: "running" | "stopped" = "running";
  let accessState: "ready" | "not_ready" = "ready";
  let receipt: SandboxQuarantineReceipt | null = null;
  const providerBase = createDockerRuntimeProviderBundle();
  assert.equal(providerBase.lifecycle.supported, true);
  assert.equal(providerBase.snapshot.supported, true);
  const stop = vi.fn(() => {
    order.push("workload-stop");
    runtimeState = "stopped";
    accessState = "not_ready";
    return options.workloadFails
      ? { exitCode: 1, message: "provider timed out after token=secret-value" }
      : { exitCode: 0, state: "stopped" as const };
  });
  const provider: RuntimeProviderBundle = {
    ...providerBase,
    preflightDoctor: {
      ...providerBase.preflightDoctor,
      preflightLifecycle: () => null,
    },
    lifecycle: {
      ...providerBase.lifecycle,
      stop,
    },
    snapshot: {
      ...providerBase.snapshot,
      preflight: (operation, entry) => ({
        schemaVersion: 1,
        providerId: "docker",
        operation,
        sandboxName: entry.name,
        providerHandle: PROVIDER_HANDLE,
        lifecycleState: runtimeState,
        lifecycleGeneration: `provider-${runtimeState}`,
      }),
      capture: () => ({
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: RUNTIME_HANDLE },
        acceleration: { kind: "none" },
      }),
    },
  };
  const runtimeProviders = createRuntimeProviderBundleRegistry([["docker", provider]]);
  const beginFence = vi.fn((_name: string, fence: SandboxQuarantineFence) => {
    order.push("fence-persisted");
    current = { ...current, quarantine: fence };
    return { status: "started" as const, fence };
  });
  const updateFence = vi.fn((_name: string, fence: SandboxQuarantineFence) => {
    current = { ...current, quarantine: fence };
    return true;
  });
  const writeReceipt = vi.fn((_path: string, value: SandboxQuarantineReceipt) => {
    order.push("receipt-written");
    receipt = value;
  });
  const deps: QuarantineSandboxDeps = {
    beginFence,
    getSandbox: () => current,
    now: () => new Date("2026-08-25T04:00:00.000Z"),
    observeSandbox: () => ({ state: accessState, liveIdentityFingerprint: LIVE_ID }),
    randomId: () => FENCE_ID,
    readReceipt: () => receipt,
    runtimeProviders,
    stopMessaging: () => {
      order.push("messaging-stop");
      return true;
    },
    stopServiceAccess: () => {
      order.push("service-access-stop");
      return !options.serviceAccessFails;
    },
    teardownDashboard: () => {
      order.push("dashboard-stop");
      return true;
    },
    updateFence,
    withLifecycleLock: (_name, operation) => operation(),
    writeReceipt,
    log: vi.fn(),
  };
  return {
    beginFence,
    current: () => current,
    deps,
    order,
    stop,
    updateFence,
    writeReceipt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("sandbox quarantine", () => {
  it("persists the restart fence before stopping any isolation surface (#10140)", () => {
    const test = harness();

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("quarantined");
    expect(result.exitCode).toBe(0);
    expect(test.order.indexOf("fence-persisted")).toBeLessThan(
      test.order.indexOf("messaging-stop"),
    );
    expect(test.order).toEqual(
      expect.arrayContaining([
        "fence-persisted",
        "messaging-stop",
        "dashboard-stop",
        "service-access-stop",
        "workload-stop",
      ]),
    );
    expect(test.current().quarantine?.phase).toBe("quarantined");
    expect(JSON.stringify(result.receipt)).not.toContain("incident-42");
  });

  it("does not stop anything when restart-fence persistence fails (#10140)", () => {
    const test = harness();
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      beginFence: vi.fn(() => {
        throw new Error("disk unavailable");
      }),
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("failed");
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.order).not.toContain("messaging-stop");
    expect(test.order).not.toContain("dashboard-stop");
  });

  it("observes a timed-out stop and leaves a partial fence without rollback (#10140)", () => {
    const test = harness({ workloadFails: true });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("partial");
    expect(result.exitCode).toBe(2);
    expect(test.current().quarantine?.phase).toBe("partial");
    expect(test.current().quarantine?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "workload-stop", outcome: "failed" }),
        expect.objectContaining({ operation: "execution-observation", outcome: "succeeded" }),
        expect.objectContaining({
          operation: "sandbox-access-observation",
          outcome: "succeeded",
        }),
      ]),
    );
    expect(JSON.stringify(result.receipt)).not.toContain("secret-value");
  });

  it("continues to the workload stop when one service access path cannot stop (#10140)", () => {
    const test = harness({ serviceAccessFails: true });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("partial");
    expect(result.exitCode).toBe(2);
    expect(test.stop).toHaveBeenCalledOnce();
    expect(test.current().quarantine?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "service-access-stop", outcome: "failed" }),
        expect.objectContaining({ operation: "workload-stop", outcome: "succeeded" }),
      ]),
    );
  });

  it("keeps stopping after receipt persistence fails behind the active fence (#10140)", () => {
    const test = harness();
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      writeReceipt: vi.fn(() => {
        throw new Error("disk full token=receipt-secret");
      }),
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("partial");
    expect(result.exitCode).toBe(2);
    expect(test.current().quarantine?.phase).toBe("partial");
    expect(test.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(test.current().quarantine)).not.toContain("receipt-secret");
  });

  it("rejects a replaced OpenShell identity before publishing the fence (#10140)", () => {
    const test = harness();
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      observeSandbox: () => ({ state: "ready", liveIdentityFingerprint: "e".repeat(64) }),
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("failed");
    expect(test.beginFence).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("keeps the fence active when post-stop access observation is inconclusive (#10140)", () => {
    const test = harness();
    const observeSandbox = vi
      .fn()
      .mockReturnValueOnce({ state: "ready", liveIdentityFingerprint: LIVE_ID })
      .mockImplementationOnce(() => {
        throw new Error("gateway observation timed out");
      });
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      observeSandbox,
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("partial");
    expect(result.exitCode).toBe(2);
    expect(test.current().quarantine?.phase).toBe("partial");
    expect(test.current().quarantine?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "sandbox-access-observation",
          outcome: "inconclusive",
        }),
      ]),
    );
  });

  it("rejects an unsupported runtime provider before publishing the fence (#10140)", () => {
    const test = harness();
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      runtimeProviders: createRuntimeProviderBundleRegistry([]),
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("failed");
    expect(test.beginFence).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("redacts and bounds the operator reason before persistence (#10140)", () => {
    const test = harness();

    quarantineSandbox(
      "alpha",
      {
        reason: `unexpected activity token=reason-secret ${"x".repeat(400)}`,
        idempotencyKey: "incident-42",
      },
      test.deps,
    );

    const persistedReason = test.current().quarantine?.reason ?? "";
    expect(persistedReason).not.toContain("reason-secret");
    expect(Buffer.byteLength(persistedReason, "utf8")).toBeLessThanOrEqual(240);
  });

  it("reconciles the same idempotency key against the same fence (#10140)", () => {
    const test = harness();
    const request = { reason: "incident investigation", idempotencyKey: "incident-42" };
    const first = quarantineSandbox("alpha", request, test.deps);

    const second = quarantineSandbox("alpha", request, test.deps);

    expect(first.fenceId).toBe(FENCE_ID);
    expect(second.fenceId).toBe(FENCE_ID);
    expect(second.status).toBe("quarantined");
    expect(test.beginFence).toHaveBeenCalledTimes(1);
    expect(test.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a different request while preserving the active fence (#10140)", () => {
    const test = harness();
    quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );
    test.stop.mockClear();

    const conflict = quarantineSandbox(
      "alpha",
      { reason: "another request", idempotencyKey: "incident-43" },
      test.deps,
    );

    expect(conflict.status).toBe("conflict");
    expect(test.stop).not.toHaveBeenCalled();
    expect(test.current().quarantine?.fenceId).toBe(FENCE_ID);
  });

  it("re-fences and reconciles an active prior receipt after a registry-loss crash (#10140)", () => {
    const test = harness();
    const priorFence: SandboxQuarantineFence = {
      schemaVersion: 1,
      fenceId: FENCE_ID,
      requestIdentity: "183735306a2ca5b4b9561a94a3139906211125523c8a7ef8c4311022991fd714",
      reason: "incident investigation",
      createdAt: "2026-08-25T04:00:00.000Z",
      updatedAt: "2026-08-25T04:00:00.000Z",
      phase: "fenced",
      target: {
        sandboxName: "alpha",
        providerId: "docker",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "registry-generation-1",
        liveIdentityFingerprint: LIVE_ID,
        providerHandle: PROVIDER_HANDLE,
        providerLifecycleGeneration: "provider-running",
        runtime: { kind: "docker-container", handle: RUNTIME_HANDLE },
      },
      attempts: [],
    };
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      readReceipt: () => ({
        schemaVersion: 1,
        kind: "sandbox-quarantine-receipt",
        status: "active",
        fence: priorFence,
        completedAt: null,
        releasedAt: null,
      }),
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("quarantined");
    expect(result.exitCode).toBe(0);
    expect(result.fenceId).toBe(FENCE_ID);
    expect(test.beginFence).toHaveBeenCalledOnce();
    expect(test.stop).toHaveBeenCalledOnce();
  });

  it("preserves the receipt before release and never starts the sandbox (#10140)", () => {
    const test = harness();
    quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );
    const releaseOrder: string[] = [];
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      writeReceipt: vi.fn(() => {
        releaseOrder.push("receipt");
      }),
      clearFence: vi.fn(() => {
        releaseOrder.push("release");
        return true;
      }),
    };

    const result = releaseSandboxQuarantine("alpha", FENCE_ID, deps);

    expect(result.status).toBe("released");
    expect(releaseOrder.slice(0, 2)).toEqual(["receipt", "release"]);
    expect(test.stop).toHaveBeenCalledTimes(1);
  });
});
