// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  CuaTaskAdapter,
  CuaTaskAdapterRequest,
  CuaTaskAdapterResult,
  CuaTaskMode,
  CuaTaskOperation,
} from "../adapters/cua-task";
import type { SandboxRegistry } from "../state/registry/types";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_DENIED_DESTINATIONS,
  CUA_FAILURE_FAMILIES,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_TASK_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaComponentIdentity,
  type CuaFailureFamily,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
  type CuaTaskResult,
} from "./contract";
import { type CuaTaskLifecycleDeps, executeCuaTaskLifecycle } from "./task-lifecycle";

const digests = {
  runtime: `sha256:${"1".repeat(64)}`,
  sandbox: `sha256:${"2".repeat(64)}`,
  policy: `sha256:${"3".repeat(64)}`,
  protocol: `sha256:${"4".repeat(64)}`,
  target: `sha256:${"5".repeat(64)}`,
  image: `sha256:${"6".repeat(64)}`,
  services: `sha256:${"7".repeat(64)}`,
  result: `sha256:${"8".repeat(64)}`,
  browser: `sha256:${"9".repeat(64)}`,
  computer: `sha256:${"a".repeat(64)}`,
  terminal: `sha256:${"b".repeat(64)}`,
} as const;

function component(name: string, digest: string): CuaComponentIdentity {
  return { name, version: "1.0.0", digest, owner: "fixture-owner" };
}

function readiness(taskOperations = [...CUA_TASK_OPERATIONS]): CuaRuntimeReadiness {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "runtime-readiness",
    mode: "standalone",
    status: "available",
    components: {
      runtime: component("fixture-runtime", digests.runtime),
      sandboxImage: component("fixture-sandbox", digests.sandbox),
      policy: component("fixture-policy", digests.policy),
      taskProtocol: component("fixture-protocol", digests.protocol),
    },
    inference: { provider: "fixture-provider", model: "fixture-model" },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: [
      "target.attach",
      "target.status",
      "target.health",
      "target.detach",
      "target.reset",
      "target.destroy",
    ],
    taskOperations,
  };
}

function attachment(activeTask: CuaTargetAttachment["activeTask"] = null): CuaTargetAttachment {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "attached",
    target: {
      identityDigest: digests.target,
      platform: "fixture-linux-amd64",
      image: component("fixture-target", digests.image),
      serviceBundle: component("fixture-services", digests.services),
      capabilities: [
        { id: "browser", protocolVersion: "1.0.0", health: "healthy" },
        { id: "computer", protocolVersion: "1.0.0", health: "healthy" },
        { id: "terminal", protocolVersion: "1.0.0", health: "healthy" },
      ],
    },
    activeTask,
  };
}

function activeAttachment(
  taskId = "task-1",
  status: NonNullable<CuaTargetAttachment["activeTask"]>["status"] = "running",
): CuaTargetAttachment {
  return attachment({ taskId, status });
}

function taskResult(
  taskId = "task-1",
  status: CuaTaskResult["status"] = "succeeded",
): CuaTaskResult {
  const runtime = readiness();
  const target = attachment().target!;
  const agentStatus = status === "cancelled" ? "cancelled" : status;
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-result",
    taskId,
    status,
    targetIdentityDigest: target.identityDigest,
    components: {
      runtime: runtime.components.runtime,
      sandboxImage: runtime.components.sandboxImage,
      targetImage: target.image,
      serviceBundle: target.serviceBundle,
      policy: runtime.components.policy,
      taskProtocol: runtime.components.taskProtocol,
    },
    inference: runtime.inference,
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "computer", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ],
    agentResult: { status: agentStatus, resultDigest: digests.result },
    verification: {
      status: status === "succeeded" ? "passed" : "not-run",
      checkIds: status === "succeeded" ? ["fixture-check"] : [],
      evidenceDigests: status === "succeeded" ? [digests.browser] : [],
    },
    receipts:
      status === "succeeded"
        ? [
            { capability: "browser", status: "completed", evidenceDigests: [digests.browser] },
            { capability: "computer", status: "completed", evidenceDigests: [digests.computer] },
            { capability: "terminal", status: "completed", evidenceDigests: [digests.terminal] },
          ]
        : [],
    evidence: [
      { digest: digests.result, classification: "private", mediaType: "application/json" },
      ...(status === "succeeded"
        ? [
            { digest: digests.browser, classification: "private" as const, mediaType: "image/png" },
            {
              digest: digests.computer,
              classification: "private" as const,
              mediaType: "application/json",
            },
            {
              digest: digests.terminal,
              classification: "private" as const,
              mediaType: "text/plain",
            },
          ]
        : []),
    ],
  };
}

function evidence(
  category: CuaTaskEvidenceIndex["category"],
  taskId = "task-1",
): CuaTaskEvidenceIndex {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-evidence-index",
    taskId,
    category,
    targetIdentityDigest: digests.target,
    evidence: [
      {
        digest: digests.browser,
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 42,
      },
    ],
  };
}

function securityAttestation(
  runtime = readiness(),
  target = attachment().target!,
): CuaSecurityAttestation {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      targetIdentityDigest: target.identityDigest,
      components: {
        runtime: runtime.components.runtime,
        sandboxImage: runtime.components.sandboxImage,
        targetImage: target.image,
        serviceBundle: target.serviceBundle,
        policy: runtime.components.policy,
        taskProtocol: runtime.components.taskProtocol,
      },
      inference: runtime.inference,
      capabilities: target.capabilities.map(({ id, protocolVersion }) => ({
        id,
        protocolVersion,
      })),
    },
    network: {
      defaultAction: "deny",
      managedInference: "only",
      targetServices: ["browser", "computer", "terminal"],
      deniedDestinations: CUA_DENIED_DESTINATIONS,
    },
    materialBoundary: {
      delivery: "host-side-secret-boundary",
      sandboxMaterial: "absent",
      excludedFrom: CUA_MATERIAL_EXCLUSIONS,
    },
    isolation: {
      runAs: "non-root",
      privileged: false,
      hostDockerSocket: false,
      hostDesktop: false,
      broadWritableHostMounts: false,
    },
    artifacts: {
      materials: CUA_PRIVATE_MATERIALS,
      classification: "private",
      contentIdentity: "sha256",
      access: "owner-only",
      metadata: "bounded",
      retention: "until-target-reset-or-destroy",
      cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
      backup: "excluded",
    },
    authority: {
      fixtureScope: "synthetic-local",
      externalSideEffects: "denied",
      untrustedInputs: CUA_UNTRUSTED_INPUTS,
      mayExpand: false,
    },
    verifier: component("fixture-security-verifier", digests.policy),
  };
}

function harness(
  target = attachment(),
  runtime = readiness(),
  cuaTaskResults: CuaTaskResult[] = [],
): {
  registry: SandboxRegistry;
  deps: CuaTaskLifecycleDeps;
} {
  const registry: SandboxRegistry = {
    sandboxes: {
      alpha: {
        name: "alpha",
        cuaRuntimeReadiness: structuredClone(runtime),
        cuaTarget: structuredClone(target),
        cuaSecurityAttestation:
          target.target === null
            ? undefined
            : structuredClone(securityAttestation(runtime, target.target)),
        cuaTaskResults: structuredClone(cuaTaskResults),
      },
    },
    defaultSandbox: "alpha",
  };
  return {
    registry,
    deps: {
      load: () => registry,
      save: vi.fn(),
      withLock: (fn) => fn(),
    },
  };
}

function fakeAdapter(
  implementation: (request: CuaTaskAdapterRequest) => CuaTaskAdapterResult,
): CuaTaskAdapter & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(implementation) };
}

describe("CUA task lifecycle (#7752)", () => {
  it.each<CuaTaskMode>([
    "interactive",
    "headless",
  ])("starts %s through the same adapter contract and stores only bounded active state", (mode) => {
    const { registry, deps } = harness();
    const adapter = fakeAdapter((request) => activeAttachment(request.taskId));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode,
        input: "private task input",
        adapter,
      },
      deps,
    );

    expect(outcome.exitCode).toBe(0);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "task.start",
        taskId: "task-1",
        mode,
        input: "private task input",
      }),
    );
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual({
      taskId: "task-1",
      status: "running",
    });
    expect(JSON.stringify(registry)).not.toContain("private task input");
  });

  it("rejects a second task without invoking the adapter", () => {
    const { registry, deps } = harness(activeAttachment("task-existing"));
    const adapter = fakeAdapter(() => activeAttachment("task-2"));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-2",
        mode: "headless",
        input: "second task",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "task_conflict" });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask?.taskId).toBe("task-existing");
  });

  it("fails before task execution when the security attestation is missing", () => {
    const { registry, deps } = harness();
    delete registry.sandboxes.alpha!.cuaSecurityAttestation;
    const adapter = fakeAdapter(() => activeAttachment());

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        input: "task",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "policy_invalid" });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("fails before task execution when the attested target identity is stale", () => {
    const { registry, deps } = harness();
    registry.sandboxes.alpha!.cuaSecurityAttestation!.bindings.targetIdentityDigest =
      digests.browser;
    const adapter = fakeAdapter(() => activeAttachment());

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        input: "task",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "policy_invalid" });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("rejects reuse of a retained completed task ID", () => {
    const { deps } = harness(attachment(), readiness(), [taskResult()]);
    const adapter = fakeAdapter(() => activeAttachment());

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        input: "reused task",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    "task.pause",
    "task.guide",
    "task.respond",
  ] as const)("reports unsupported optional operation %s explicitly", (operation) => {
    const requiredOnly = readiness([
      "task.start",
      "task.status",
      "task.result",
      "task.events",
      "task.logs",
      "task.plans",
      "task.cancel",
    ]);
    const { deps } = harness(activeAttachment(), requiredOnly);
    const adapter = fakeAdapter(() => activeAttachment());

    const outcome = executeCuaTaskLifecycle(
      {
        operation,
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
        ...(operation === "task.guide" || operation === "task.respond"
          ? { input: "private response" }
          : {}),
      },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "lifecycle_unavailable",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("preserves recoverable input-required state after a runtime response", () => {
    const { registry, deps } = harness(activeAttachment("task-1", "input-required"));
    const adapter = fakeAdapter(() => activeAttachment("task-1", "running"));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.respond",
        sandboxName: "alpha",
        taskId: "task-1",
        input: "private response",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "target-attachment",
      activeTask: { taskId: "task-1", status: "running" },
    });
    expect(JSON.stringify(registry)).not.toContain("private response");
  });

  it("rejects a pause response that leaves the task running", () => {
    const current = activeAttachment();
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() => activeAttachment("task-1", "running"));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.pause",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(current);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it.each<[CuaTaskOperation, CuaTaskEvidenceIndex["category"]]>([
    ["task.events", "events"],
    ["task.logs", "logs"],
    ["task.plans", "plans"],
  ])("returns a bounded private evidence index for %s", (operation, category) => {
    const { deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => evidence(category));

    const outcome = executeCuaTaskLifecycle(
      { operation, sandboxName: "alpha", taskId: "task-1", adapter },
      deps,
    );

    expect(outcome.record).toEqual(evidence(category));
    expect(JSON.stringify(outcome.record)).not.toMatch(/path|url|content/i);
  });

  it("persists an identity-bound terminal result and serves it after reconnect", () => {
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => taskResult());

    const completed = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );
    const reconnectAdapter = fakeAdapter(() => taskResult());
    const reconnected = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter: reconnectAdapter,
      },
      deps,
    );

    expect(completed.record).toEqual(taskResult());
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([taskResult()]);
    expect(reconnected.record).toEqual(taskResult());
    expect(reconnectAdapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    "failed",
    "not-run",
  ] as const)("rejects a succeeded task when independent verification is %s", (verificationStatus) => {
    const unverified = taskResult();
    unverified.verification.status = verificationStatus;
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => unverified);

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask?.taskId).toBe("task-1");
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([]);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("requires cancellation to return a terminal result and clears active state", () => {
    const cancelled = taskResult("task-1", "cancelled");
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => cancelled);

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.cancel",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toEqual(cancelled);
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([cancelled]);
  });

  it("rejects a cancellation response that is not cancelled", () => {
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => taskResult("task-1", "succeeded"));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.cancel",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask?.taskId).toBe("task-1");
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([]);
  });

  it("rejects a failure record for another operation without changing task state", () => {
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => ({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation: "task.cancel",
      family: "task_cancelled",
      retryable: false,
      component: "runtime",
    }));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask?.taskId).toBe("task-1");
  });

  it("clears active state when the runtime classifies a terminal timeout", () => {
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => ({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation: "task.status",
      family: "task_timeout",
      retryable: false,
      component: "runtime",
    }));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "task_timeout" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
  });

  it.each<[CuaFailureFamily, CuaTargetAttachment["status"]]>([
    ["target_unreachable", "unreachable"],
    ["target_replaced", "replaced"],
    ["target_incompatible", "incompatible"],
    ["capability_unhealthy", "unreachable"],
  ])("fails closed on %s and records target state %s", (family, status) => {
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => ({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation: "task.status",
      family,
      retryable: false,
      component: "target",
    }));

    executeCuaTaskLifecycle(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(registry.sandboxes.alpha?.cuaTarget?.status).toBe(status);
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
  });

  it("rejects a result whose exact runtime identity drifts", () => {
    const drifted = taskResult();
    drifted.components.runtime = component("fixture-runtime", `sha256:${"c".repeat(64)}`);
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => drifted);

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "runtime_incompatible",
    });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask?.taskId).toBe("task-1");
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([]);
  });

  it.each<CuaFailureFamily>(
    CUA_FAILURE_FAMILIES,
  )("preserves classified adapter failure family %s without raw diagnostics", (family) => {
    const { deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => ({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation: "task.status",
      family,
      retryable: false,
      component: "runtime",
    }));

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toEqual({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation: "task.status",
      family,
      retryable: false,
      component: "runtime",
    });
  });

  it("rejects malformed identifiers and missing private input before adapter invocation", () => {
    const { deps } = harness();
    const adapter = fakeAdapter(() => activeAttachment());

    const malformed = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "../private",
        mode: "headless",
        input: "task",
        adapter,
      },
      deps,
    );
    const missingInput = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        adapter,
      },
      deps,
    );
    const oversizedInput = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        input: "x".repeat(64 * 1024 + 1),
        adapter,
      },
      deps,
    );

    expect(malformed.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(missingInput.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(oversizedInput.record).toMatchObject({
      kind: "failure",
      family: "validation_failed",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
