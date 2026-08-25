// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { RuntimeProviderBundle } from "../../onboard/runtime-provider/contract";
import type { SandboxQuarantineReceipt } from "../../state/registry/quarantine-receipt";
import type {
  SandboxEntry,
  SandboxQuarantineAttempt,
  SandboxQuarantineFence,
  SandboxQuarantinePhase,
} from "../../state/registry/types";
import {
  quarantineSandbox,
  releaseSandboxQuarantine,
  type QuarantineSandboxDeps,
} from "./quarantine/index";
import { makeMessagingPlan } from "../../../../test/helpers/messaging-plan-fixtures";

const LIVE_ID = "a".repeat(64);
const PROVIDER_HANDLE = "b".repeat(64);
const RUNTIME_HANDLE = "c".repeat(64);
const FENCE_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_IDENTITY = "183735306a2ca5b4b9561a94a3139906211125523c8a7ef8c4311022991fd714";
const REASON_DIGEST = "6b7bcde27ba06979ec8bbae17241ad1f25d4b3709600c073e72c15f52b87fce0";
const REQUIRED_RECONCILED_OPERATIONS = [
  "receipt-persistence",
  "messaging-stop",
  "dashboard-stop",
  "service-access-stop",
  "workload-stop",
  "execution-observation",
  "sandbox-access-observation",
] as const satisfies readonly SandboxQuarantineAttempt["operation"][];

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    lifecycleGeneration: "registry-generation-1",
    lifecycleLiveIdentityFingerprint: LIVE_ID,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...overrides,
  };
}

function crashBoundaryFence(
  phase: SandboxQuarantinePhase,
  operations: readonly SandboxQuarantineAttempt["operation"][],
): SandboxQuarantineFence {
  return {
    schemaVersion: 1,
    fenceId: FENCE_ID,
    requestIdentity: REQUEST_IDENTITY,
    reasonDigest: REASON_DIGEST,
    createdAt: "2026-08-25T04:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    phase,
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
    attempts: operations.map((operation) => ({
      operation,
      attemptedAt: "2026-08-25T04:00:00.000Z",
      outcome: "succeeded",
    })),
  };
}

function harness(
  options: {
    serviceAccessFails?: boolean;
    workloadFails?: boolean;
    prepareFails?: boolean;
    observationInconclusive?: boolean;
    initial?: SandboxEntry;
  } = {},
) {
  const order: string[] = [];
  let current = options.initial ?? sandbox();
  let runtimeState: "running" | "stopped" = "running";
  let accessState: "ready" | "not_ready" = "ready";
  let receipt: SandboxQuarantineReceipt | null = null;
  const providerBase = createDockerRuntimeProviderBundle();
  assert.equal(providerBase.lifecycle.supported, true);
  assert.equal(providerBase.quarantine.supported, true);
  const start = vi.fn(providerBase.lifecycle.start);
  const preparedAuthority = {
    schemaVersion: 1 as const,
    providerId: "docker",
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "registry-generation-1",
    liveIdentityFingerprint: LIVE_ID,
    providerHandle: PROVIDER_HANDLE,
    providerLifecycleGeneration: "provider-running",
    runtime: { kind: "docker-container", handle: RUNTIME_HANDLE },
  };
  const prepare = options.prepareFails
    ? vi.fn(() => {
        throw new Error("replaced OpenShell identity");
      })
    : vi.fn(() => preparedAuthority);
  const stop = vi.fn(() => {
    order.push("workload-stop");
    runtimeState = "stopped";
    accessState = "not_ready";
    return options.workloadFails
      ? { outcome: "failed" as const, detail: "provider timed out after token=secret-value" }
      : { outcome: "succeeded" as const };
  });
  const provider: RuntimeProviderBundle = {
    ...providerBase,
    preflightDoctor: {
      ...providerBase.preflightDoctor,
      preflightLifecycle: () => null,
    },
    lifecycle: {
      ...providerBase.lifecycle,
      start,
    },
    quarantine: {
      ...providerBase.quarantine,
      prepare,
      stop,
      observe: () =>
        options.observationInconclusive
          ? {
              execution: { outcome: "succeeded" as const },
              sandboxAccess: {
                outcome: "inconclusive" as const,
                detail: "gateway observation timed out",
              },
            }
          : {
              execution: {
                outcome: runtimeState === "stopped" ? ("succeeded" as const) : ("failed" as const),
              },
              sandboxAccess: {
                outcome: accessState === "not_ready" ? ("succeeded" as const) : ("failed" as const),
              },
            },
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
  const stopMessaging = vi.fn(() => {
    order.push("messaging-stop");
    return true;
  });
  const stopServiceAccess = vi.fn(() => {
    order.push("service-access-stop");
    return !options.serviceAccessFails;
  });
  const teardownDashboard = vi.fn(() => {
    order.push("dashboard-stop");
    return true;
  });
  const deps: QuarantineSandboxDeps = {
    beginFence,
    getSandbox: () => current,
    now: () => new Date("2026-08-25T04:00:00.000Z"),
    randomId: () => FENCE_ID,
    readReceipt: () => receipt,
    runtimeProviders,
    stopMessaging,
    stopServiceAccess,
    teardownDashboard,
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
    prepare,
    start,
    stop,
    stopMessaging,
    stopServiceAccess,
    teardownDashboard,
    updateFence,
    writeReceipt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      test.order.indexOf("service-access-stop"),
    );
    expect(test.order).toEqual(
      expect.arrayContaining(["fence-persisted", "service-access-stop", "workload-stop"]),
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

  it.each([
    {
      boundary: "initial receipt",
      install: (test: ReturnType<typeof harness>, assertFencePublished: () => void) => {
        test.writeReceipt.mockImplementation(() => {
          assertFencePublished();
          throw new Error("simulated interruption after initial receipt write began");
        });
      },
    },
    {
      boundary: "messaging stop",
      install: (test: ReturnType<typeof harness>, assertFencePublished: () => void) => {
        test.stopMessaging.mockImplementationOnce(() => {
          assertFencePublished();
          throw new Error("simulated interruption after messaging stop");
        });
      },
    },
    {
      boundary: "dashboard stop",
      install: (test: ReturnType<typeof harness>, assertFencePublished: () => void) => {
        test.teardownDashboard.mockImplementationOnce(() => {
          assertFencePublished();
          throw new Error("simulated interruption after dashboard stop");
        });
      },
    },
    {
      boundary: "service-access stop",
      install: (test: ReturnType<typeof harness>, assertFencePublished: () => void) => {
        test.stopServiceAccess.mockImplementationOnce(() => {
          assertFencePublished();
          throw new Error("simulated interruption after service-access stop");
        });
      },
    },
    {
      boundary: "workload stop",
      install: (test: ReturnType<typeof harness>, assertFencePublished: () => void) => {
        test.stop.mockImplementationOnce(() => {
          assertFencePublished();
          throw new Error("simulated interruption after workload stop");
        });
      },
    },
    {
      boundary: "final receipt",
      install: (test: ReturnType<typeof harness>, assertFencePublished: () => void) => {
        test.writeReceipt
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            assertFencePublished();
            throw new Error("simulated interruption after final receipt write began");
          });
      },
    },
  ])("keeps the durable fence across the $boundary crash boundary (#10140)", ({ install }) => {
    const test = harness({
      initial: sandbox({
        agent: "hermes",
        messaging: {
          schemaVersion: 1,
          plan: makeMessagingPlan({ sandboxName: "alpha", channels: ["telegram"] }),
        },
      }),
    });
    const assertFencePublished = (): void => {
      expect(test.current().quarantine?.fenceId).toBe(FENCE_ID);
    };
    install(test, assertFencePublished);

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("partial");
    expect(test.current().quarantine?.fenceId).toBe(FENCE_ID);
    expect(test.start).not.toHaveBeenCalled();
  });

  it("rejects a replaced OpenShell identity before publishing the fence (#10140)", () => {
    const test = harness({ prepareFails: true });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("failed");
    expect(test.beginFence).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("keeps the fence active when post-stop access observation is inconclusive (#10140)", () => {
    const test = harness({ observationInconclusive: true });

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

  it("rejects an unqualified agent before provider preparation or fence publication (#10140)", () => {
    const test = harness();
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      getAgent: () => ({ quarantineQualification: null }) as never,
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("failed");
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.beginFence).not.toHaveBeenCalled();
  });

  it("rejects the feature-gated NemoCUA manifest before any mutation until it is qualified (#10140)", () => {
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
    const test = harness({ initial: sandbox({ agent: "nemocua" }) });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.message).toContain("not qualified");
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.beginFence).not.toHaveBeenCalled();
    expect(test.stop).not.toHaveBeenCalled();
  });

  it("records manifest-omitted terminal surfaces as successful no-ops (#10140)", () => {
    const test = harness({ initial: sandbox({ agent: "langchain-deepagents-code" }) });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("quarantined");
    expect(test.stopMessaging).not.toHaveBeenCalled();
    expect(test.teardownDashboard).not.toHaveBeenCalled();
    expect(test.stopServiceAccess).not.toHaveBeenCalled();
    expect(result.receipt?.fence.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "messaging-stop", outcome: "succeeded" }),
        expect.objectContaining({ operation: "dashboard-stop", outcome: "succeeded" }),
        expect.objectContaining({ operation: "service-access-stop", outcome: "succeeded" }),
      ]),
    );
  });

  it("stops every declared forward surface for a multi-forward gateway agent (#10140)", () => {
    const test = harness({ initial: sandbox({ agent: "hermes" }) });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("quarantined");
    expect(test.teardownDashboard).toHaveBeenCalledOnce();
    expect(test.stopServiceAccess).toHaveBeenCalledOnce();
  });

  it("does not invent a dashboard surface for a gateway manifest that omits one (#10140)", () => {
    const test = harness();
    const deps: QuarantineSandboxDeps = {
      ...test.deps,
      getAgent: () =>
        ({
          quarantineQualification: {
            contractVersion: 1,
            liveE2eTarget: "sandbox-quarantine-gateway-without-dashboard",
          },
          runtime: { kind: "gateway", interactiveCommand: "agent" },
          forward_ports: [8081],
          hasDashboard: false,
        }) as never,
    };

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      deps,
    );

    expect(result.status).toBe("quarantined");
    expect(test.teardownDashboard).not.toHaveBeenCalled();
    expect(test.stopServiceAccess).toHaveBeenCalledOnce();
  });

  it("stops messaging only when the registry has configured channels (#10140)", () => {
    const test = harness({
      initial: sandbox({
        messaging: {
          schemaVersion: 1,
          plan: makeMessagingPlan({ sandboxName: "alpha", channels: ["telegram"] }),
        },
      }),
    });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("quarantined");
    expect(test.stopMessaging).toHaveBeenCalledOnce();
  });

  it("persists only a digest of an opaque operator reason (#10140)", () => {
    const test = harness();
    const opaqueReason = `opaque-${"z7Qp".repeat(80)}`;

    const result = quarantineSandbox(
      "alpha",
      {
        reason: opaqueReason,
        idempotencyKey: "incident-42",
      },
      test.deps,
    );

    const persisted = JSON.stringify({ result, sandbox: test.current() });
    expect(persisted).not.toContain(opaqueReason);
    expect(test.current().quarantine?.reasonDigest).toMatch(/^[a-f0-9]{64}$/u);

    const conflict = quarantineSandbox(
      "alpha",
      { reason: `${opaqueReason}-changed`, idempotencyKey: "incident-42" },
      test.deps,
    );
    expect(conflict.status).toBe("conflict");
    expect(JSON.stringify(conflict)).not.toContain(opaqueReason);
  });

  it("keeps a secret canary out of state, receipts, output, errors, and logs (#10140)", () => {
    const canary = "quarantine-secret-canary";
    const test = harness({
      initial: sandbox({
        messaging: {
          schemaVersion: 1,
          plan: makeMessagingPlan({ sandboxName: "alpha", channels: ["telegram"] }),
        },
      }),
    });
    const log = vi.fn();
    const stopMessaging: NonNullable<QuarantineSandboxDeps["stopMessaging"]> = vi.fn(
      (_name, options) => {
        options?.info?.(`channel stopped api_key=${canary}`);
        return true;
      },
    );

    const result = quarantineSandbox(
      "alpha",
      {
        reason: canary,
        idempotencyKey: "incident-42",
      },
      { ...test.deps, log, stopMessaging },
    );
    const rendered = [
      result.message,
      JSON.stringify(result),
      JSON.stringify(result.receipt),
      JSON.stringify(test.current()),
      JSON.stringify(log.mock.calls),
    ].join("\n");

    expect(result.status).toBe("quarantined");
    expect(rendered).not.toContain(canary);
  });

  it("redacts provider errors before returning them to human or JSON output (#10140)", () => {
    const canary = "quarantine-provider-secret";
    const test = harness();
    test.prepare.mockImplementationOnce(() => {
      throw new Error(`provider failed token=${canary}`);
    });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("returns a failed result for an invalid idempotency key (#10140)", () => {
    const test = harness();

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "invalid\nkey" },
      test.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/idempotency key/u);
    expect(test.beginFence).not.toHaveBeenCalled();
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
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      boundary: "durable fence publication",
      phase: "fenced" as const,
      operations: ["fence-persistence"] as const,
    },
    {
      boundary: "initial receipt publication",
      phase: "fenced" as const,
      operations: ["fence-persistence", "receipt-persistence"] as const,
    },
    {
      boundary: "messaging stop",
      phase: "stopping" as const,
      operations: ["fence-persistence", "receipt-persistence", "messaging-stop"] as const,
    },
    {
      boundary: "dashboard stop",
      phase: "stopping" as const,
      operations: [
        "fence-persistence",
        "receipt-persistence",
        "messaging-stop",
        "dashboard-stop",
      ] as const,
    },
    {
      boundary: "service access stop",
      phase: "stopping" as const,
      operations: [
        "fence-persistence",
        "receipt-persistence",
        "messaging-stop",
        "dashboard-stop",
        "service-access-stop",
      ] as const,
    },
    {
      boundary: "workload stop",
      phase: "stopping" as const,
      operations: [
        "fence-persistence",
        "receipt-persistence",
        "messaging-stop",
        "dashboard-stop",
        "service-access-stop",
        "workload-stop",
      ] as const,
    },
    {
      boundary: "execution observation",
      phase: "verifying" as const,
      operations: [
        "fence-persistence",
        "receipt-persistence",
        "messaging-stop",
        "dashboard-stop",
        "service-access-stop",
        "workload-stop",
        "execution-observation",
      ] as const,
    },
    {
      boundary: "sandbox access observation",
      phase: "verifying" as const,
      operations: [
        "fence-persistence",
        "receipt-persistence",
        "messaging-stop",
        "dashboard-stop",
        "service-access-stop",
        "workload-stop",
        "execution-observation",
        "sandbox-access-observation",
      ] as const,
    },
  ])("reconciles a persisted crash boundary after $boundary (#10140)", ({ phase, operations }) => {
    const priorFence = crashBoundaryFence(phase, operations);
    const test = harness({ initial: sandbox({ quarantine: priorFence }) });

    const result = quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );

    expect(result.status).toBe("quarantined");
    expect(result.fenceId).toBe(FENCE_ID);
    expect(test.current().quarantine?.fenceId).toBe(FENCE_ID);
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.beginFence).not.toHaveBeenCalled();
    expect(test.current().quarantine?.attempts).toEqual(
      expect.arrayContaining(
        REQUIRED_RECONCILED_OPERATIONS.map((operation) =>
          expect.objectContaining({ operation, outcome: "succeeded" }),
        ),
      ),
    );
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
      reasonDigest: REASON_DIGEST,
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
      writeReceipt: vi.fn((_path, receipt) => {
        releaseOrder.push(`receipt-${receipt.status}`);
      }),
      clearFence: vi.fn(() => {
        releaseOrder.push("release");
        return true;
      }),
    };

    const result = releaseSandboxQuarantine("alpha", FENCE_ID, deps);

    expect(result.status).toBe("released");
    expect(releaseOrder).toEqual(["receipt-quarantined", "receipt-released", "release"]);
    expect(test.stop).toHaveBeenCalledTimes(1);
    expect(test.start).not.toHaveBeenCalled();
  });

  it("keeps release retryable when the final receipt write fails (#10140)", () => {
    const test = harness();
    quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );
    const persistedStatuses: SandboxQuarantineReceipt["status"][] = [];
    const writeReceipt = vi
      .fn((_path: string, receipt: SandboxQuarantineReceipt) => {
        persistedStatuses.push(receipt.status);
      })
      .mockImplementationOnce((_path, receipt) => {
        persistedStatuses.push(receipt.status);
      })
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    const clearFence = vi.fn(() => true);

    const failedRelease = releaseSandboxQuarantine("alpha", FENCE_ID, {
      ...test.deps,
      clearFence,
      writeReceipt,
    });

    expect(failedRelease).toMatchObject({ exitCode: 2, status: "partial" });
    expect(failedRelease.message).toContain("fence remains active");
    expect(clearFence).not.toHaveBeenCalled();
    expect(test.current().quarantine?.fenceId).toBe(FENCE_ID);

    const retriedRelease = releaseSandboxQuarantine("alpha", FENCE_ID, {
      ...test.deps,
      clearFence,
      writeReceipt,
    });

    expect(retriedRelease).toMatchObject({ exitCode: 0, status: "released" });
    expect(clearFence).toHaveBeenCalledOnce();
    expect(persistedStatuses.filter((status) => status === "released")).toHaveLength(1);
    expect(test.start).not.toHaveBeenCalled();
  });

  it("keeps the fence when the exact runtime authority changed before release (#10140)", () => {
    const test = harness();
    quarantineSandbox(
      "alpha",
      { reason: "incident investigation", idempotencyKey: "incident-42" },
      test.deps,
    );
    test.prepare.mockReturnValueOnce({
      schemaVersion: 1,
      providerId: "docker",
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "registry-generation-1",
      liveIdentityFingerprint: LIVE_ID,
      providerHandle: "d".repeat(64),
      providerLifecycleGeneration: "provider-replaced",
      runtime: { kind: "docker-container", handle: "e".repeat(64) },
    });
    const clearFence = vi.fn(() => true);

    const result = releaseSandboxQuarantine("alpha", FENCE_ID, {
      ...test.deps,
      clearFence,
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("authority changed");
    expect(clearFence).not.toHaveBeenCalled();
    expect(test.current().quarantine?.fenceId).toBe(FENCE_ID);
    expect(test.start).not.toHaveBeenCalled();
  });
});
