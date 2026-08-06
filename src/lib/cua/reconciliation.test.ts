// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CuaTargetAttachment } from "./contract";
import {
  beginCuaSideEffectReconciliation,
  type CuaReconciliationCarrier,
  createCuaReconciliationState,
  cuaReconciliationAllowsOperation,
  cuaTaskCancelCompletesReconciliation,
  markCuaSideEffectReconciliationRequired,
  observeCuaReconciliation,
  parseCuaReconciliationState,
  quarantineCuaAuthority,
  recordCuaReconciliationObservation,
  requireCuaReconciliation,
} from "./reconciliation";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

function target(activeTask: CuaTargetAttachment["activeTask"] = null): CuaTargetAttachment {
  return {
    schemaVersion: "1.1.0",
    kind: "target-attachment",
    status: "attached",
    runtimeReadinessDigest: digest("a"),
    target: {
      identityDigest: digest("b"),
      platform: "fixture-linux-amd64",
      image: { name: "image", version: "1", digest: digest("c"), owner: "fixture" },
      serviceBundle: {
        name: "services",
        version: "1",
        digest: digest("d"),
        owner: "fixture",
      },
      capabilities: [
        { id: "browser", protocolVersion: "1", health: "healthy" },
        { id: "computer", protocolVersion: "1", health: "healthy" },
        { id: "terminal", protocolVersion: "1", health: "healthy" },
      ],
    },
    activeTask,
  };
}

describe("CUA lifecycle reconciliation", () => {
  it("turns a crashed side-effect journal into a durable required gate", () => {
    const pending = createCuaReconciliationState({
      phase: "pending",
      attemptId: "11111111-1111-4111-8111-111111111111",
      trigger: "target.attach",
      operation: "target.attach",
      runtimeReadinessDigest: digest("a"),
    });

    expect(requireCuaReconciliation(pending)).toEqual({
      ...pending,
      phase: "required",
    });
    expect(cuaReconciliationAllowsOperation(pending, "target.attach")).toBe(false);
    expect(cuaReconciliationAllowsOperation(pending, "target.health")).toBe(true);
  });

  it("journals a side effect before invocation and retains it after uncertain failure", () => {
    const entry: CuaReconciliationCarrier = { cuaTarget: target() };
    const pending = beginCuaSideEffectReconciliation(
      entry,
      "target.detach",
      null,
      "66666666-6666-4666-8666-666666666666",
    );

    expect(entry.cuaReconciliation).toEqual(pending);
    expect(pending.phase).toBe("pending");
    expect(markCuaSideEffectReconciliationRequired(entry, pending.attemptId)).toBe(true);
    expect(entry.cuaReconciliation).toMatchObject({ phase: "required" });
    expect(
      markCuaSideEffectReconciliationRequired(entry, "77777777-7777-4777-8777-777777777777"),
    ).toBe(false);
  });

  it("requires independent status before cleanup and preserves an unknown active task", () => {
    const required = createCuaReconciliationState({
      attemptId: "22222222-2222-4222-8222-222222222222",
      trigger: "unexpected-active-task",
      taskId: "task-live",
      runtimeReadinessDigest: digest("a"),
      targetIdentityDigest: digest("b"),
    });
    const observed = observeCuaReconciliation(
      required,
      "target.health",
      target({
        taskId: "task-live",
        status: "running",
        appliedPolicy: { revision: 1, digest: digest("e") },
      }),
    );

    expect(observed).toMatchObject({
      phase: "observed",
      observation: {
        via: "target.health",
        activeTask: { taskId: "task-live", status: "running" },
      },
    });
    expect(cuaReconciliationAllowsOperation(observed, "target.destroy")).toBe(false);
    expect(cuaReconciliationAllowsOperation(observed, "task.cancel", "other-task")).toBe(false);
    expect(cuaReconciliationAllowsOperation(observed, "task.cancel", "task-live")).toBe(true);
    expect(cuaTaskCancelCompletesReconciliation(observed)).toBe(true);
  });

  it("allows target cleanup only after an observation proves no active task", () => {
    const required = createCuaReconciliationState({
      attemptId: "33333333-3333-4333-8333-333333333333",
      trigger: "policy-change",
      runtimeReadinessDigest: digest("a"),
      targetIdentityDigest: digest("b"),
    });

    const observed = observeCuaReconciliation(required, "target.health", target());
    expect(cuaReconciliationAllowsOperation(observed, "target.destroy")).toBe(true);
    expect(cuaTaskCancelCompletesReconciliation(observed)).toBe(false);
  });

  it("quarantines authority drift and records the adapter's full active-task observation", () => {
    const active = target({
      taskId: "task-live",
      status: "running",
      appliedPolicy: { revision: 1, digest: digest("e") },
    });
    const entry: CuaReconciliationCarrier = {
      cuaRuntimeReadiness: { kind: "runtime-readiness" } as never,
      cuaTarget: active,
      cuaSecurityAttestation: { kind: "security-attestation" } as never,
      cuaTaskResults: [{ kind: "task-result" }] as never,
    };

    expect(
      quarantineCuaAuthority(entry, "policy-change", "88888888-8888-4888-8888-888888888888"),
    ).toBe(true);
    expect(entry.cuaTarget?.activeTask?.taskId).toBe("task-live");
    expect(entry.cuaSecurityAttestation).toBeUndefined();
    expect(entry.cuaTaskResults).toBeUndefined();
    const observed = target({
      taskId: "task-unexpected",
      status: "input-required",
      appliedPolicy: { revision: 2, digest: digest("f") },
    });
    recordCuaReconciliationObservation(entry, "target.health", observed);
    expect(entry.cuaTarget?.activeTask).toEqual(observed.activeTask);
    expect(entry.cuaReconciliation).toMatchObject({
      phase: "observed",
      observation: {
        activeTask: { taskId: "task-unexpected", status: "input-required" },
      },
    });
  });

  it("rejects extra fields and credential-shaped task identities", () => {
    const state = createCuaReconciliationState({
      attemptId: "44444444-4444-4444-8444-444444444444",
      trigger: "task.start",
      operation: "task.start",
      taskId: "task-safe",
    });

    expect(() =>
      parseCuaReconciliationState({ ...state, endpoint: "https://host.invalid" }),
    ).toThrow("unsupported fields");
    expect(() => parseCuaReconciliationState({ ...state, taskId: "sk-private" })).toThrow(
      "invalid task identity",
    );
    expect(JSON.stringify(state)).not.toMatch(/credential|password|secret|token|endpoint|url/i);
  });
});
