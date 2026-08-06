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
  type CuaTaskResult,
  getCuaRuntimeReadinessDigest,
} from "./contract";
import { type CuaTaskLifecycleDeps, executeCuaTaskLifecycle } from "./task-lifecycle";

const digests = {
  runtime: `sha256:${"1".repeat(64)}`,
  sandbox: `sha256:${"2".repeat(64)}`,
  targetAdapter: `sha256:${"f".repeat(64)}`,
  policy: `sha256:${"3".repeat(64)}`,
  protocol: `sha256:${"4".repeat(64)}`,
  target: `sha256:${"5".repeat(64)}`,
  image: `sha256:${"6".repeat(64)}`,
  services: `sha256:${"7".repeat(64)}`,
  verifier: `sha256:${"c".repeat(64)}`,
  result: `sha256:${"8".repeat(64)}`,
  browser: `sha256:${"9".repeat(64)}`,
  computer: `sha256:${"a".repeat(64)}`,
  terminal: `sha256:${"b".repeat(64)}`,
} as const;
const appliedPolicy = { revision: 17, digest: `sha256:${"0".repeat(64)}` } as const;

function component(name: string, digest: string): CuaComponentIdentity {
  return { name, version: "1.0.0", digest, owner: "fixture-owner" };
}

function readiness(taskOperations = [...CUA_TASK_OPERATIONS]): CuaRuntimeReadiness {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status: "available",
    sourceRevision: "a".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: `sha256:${"e".repeat(64)}`,
    providerAuthorityDigest: `sha256:${"0".repeat(64)}`,
    qualification: {
      state: "qualified",
      candidateSourceRevision: "b".repeat(40),
      environmentDigest: `sha256:${"c".repeat(64)}`,
      receiptDigest: `sha256:${"d".repeat(64)}`,
      bundleReceiptDigest: `sha256:${"f".repeat(64)}`,
    },
    components: {
      openshell: component("fixture-openshell", `sha256:${"0".repeat(64)}`),
      runtime: component("fixture-runtime", digests.runtime),
      sandboxImage: component("fixture-sandbox", digests.sandbox),
      targetAdapter: component("fixture-target-adapter", digests.targetAdapter),
      policy: component("fixture-policy", digests.policy),
      taskProtocol: component("fixture-protocol", digests.protocol),
      securityVerifier: component("fixture-verifier", digests.verifier),
    },
    inference: {
      provider: "fixture-provider",
      model: "fixture-model",
      routeDigest: `sha256:${"d".repeat(64)}`,
    },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: [
      "target.attach",
      "target.status",
      "target.health",
      "target.detach",
      "target.destroy",
    ],
    taskOperations,
    securityOperations: ["security.status", "security.verify"],
  };
}

function attachment(activeTask: CuaTargetAttachment["activeTask"] = null): CuaTargetAttachment {
  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(readiness());
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "attached",
    runtimeReadinessDigest,
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
  return attachment({ taskId, status, appliedPolicy });
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
    runtimeReadinessDigest: getCuaRuntimeReadinessDigest(runtime),
    components: {
      openshell: runtime.components.openshell,
      runtime: runtime.components.runtime,
      sandboxImage: runtime.components.sandboxImage,
      targetImage: target.image,
      serviceBundle: target.serviceBundle,
      policy: runtime.components.policy,
      taskProtocol: runtime.components.taskProtocol,
    },
    inference: runtime.inference,
    appliedPolicy,
    capabilities: [{ id: "browser", protocolVersion: "1.0.0" }],
    agentResult: { status: agentStatus, resultDigest: digests.result },
    verification: {
      status: status === "succeeded" ? "passed" : "not-run",
      checkIds: status === "succeeded" ? ["fixture-check"] : [],
      evidenceDigests: status === "succeeded" ? [digests.browser] : [],
    },
    receipts:
      status === "succeeded"
        ? [{ capability: "browser", status: "completed", evidenceDigests: [digests.browser] }]
        : [],
    evidence: [
      { digest: digests.result, classification: "private", mediaType: "application/json" },
      ...(status === "succeeded"
        ? [{ digest: digests.browser, classification: "private" as const, mediaType: "image/png" }]
        : []),
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
      runtimeReadinessDigest: getCuaRuntimeReadinessDigest(runtime),
      targetIdentityDigest: target.identityDigest,
      components: {
        openshell: runtime.components.openshell,
        runtime: runtime.components.runtime,
        sandboxImage: runtime.components.sandboxImage,
        targetImage: target.image,
        serviceBundle: target.serviceBundle,
        policy: runtime.components.policy,
        taskProtocol: runtime.components.taskProtocol,
      },
      inference: runtime.inference,
      appliedPolicy,
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
      retention: "until-target-detach-or-destroy",
      cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
      backup: "excluded",
    },
    authority: {
      fixtureScope: "synthetic-local",
      externalSideEffects: "denied",
      untrustedInputs: CUA_UNTRUSTED_INPUTS,
      mayExpand: false,
    },
    verifier: runtime.components.securityVerifier,
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
      isFrameworkEnabled: () => true,
      requireRuntimeReadiness: (entry) => entry.cuaRuntimeReadiness!,
      observeLiveAppliedPolicy: () => appliedPolicy,
    },
  };
}

function fakeAdapter(
  implementation: (request: CuaTaskAdapterRequest) => CuaTaskAdapterResult,
): CuaTaskAdapter & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(implementation) };
}

describe("CUA task lifecycle (#7752)", () => {
  it("never executes the task adapter while the registry lock is held", () => {
    const { registry, deps } = harness();
    let registryLockHeld = false;
    deps.withLock = (operation) => {
      registryLockHeld = true;
      try {
        return operation();
      } finally {
        registryLockHeld = false;
      }
    };
    const adapter = fakeAdapter(() => activeAttachment());
    adapter.execute.mockImplementation((request) => {
      expect(registryLockHeld).toBe(false);
      expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
        phase: "pending",
        trigger: "task.start",
        taskId: "task-1",
      });
      return activeAttachment(request.taskId);
    });

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        input: "bounded input",
        adapter,
      },
      deps,
    );

    expect(outcome.exitCode).toBe(0);
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(registry.sandboxes.alpha?.cuaReconciliation).toBeUndefined();
  });

  it("fails closed before reading state when the framework is disabled", () => {
    const { deps } = harness();
    deps.isFrameworkEnabled = () => false;
    deps.load = vi.fn(deps.load);

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
      },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "lifecycle_unavailable",
    });
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("quarantines retained external state when current-build readiness validation fails", () => {
    const { registry, deps } = harness(attachment(), readiness(), [taskResult()]);
    deps.requireRuntimeReadiness = () => {
      throw new Error("runtime manifest changed");
    };

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.result", sandboxName: "alpha", taskId: "task-1" },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "runtime_unavailable" });
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toEqual(readiness());
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(attachment());
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "readiness-change",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("durably removes invalid readiness even when no derived CUA state exists", () => {
    const { registry, deps } = harness();
    delete registry.sandboxes.alpha!.cuaTarget;
    delete registry.sandboxes.alpha!.cuaSecurityAttestation;
    delete registry.sandboxes.alpha!.cuaTaskResults;
    deps.requireRuntimeReadiness = () => {
      throw new Error("runtime identity changed");
    };

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.status", sandboxName: "alpha", taskId: "task-1" },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "runtime_unavailable" });
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toBeUndefined();
    expect(deps.save).toHaveBeenCalledOnce();
  });

  it("quarantines retained task authority when the durable inference route drifts", () => {
    const retained = taskResult();
    const { registry, deps } = harness(attachment(), readiness(), [retained]);
    registry.sandboxes.alpha!.model = "other-model";

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.result", sandboxName: "alpha", taskId: retained.taskId },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "inference_unavailable",
    });
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toEqual(readiness());
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(attachment());
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "inference-change",
    });
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

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
      appliedPolicy,
    });
    expect(JSON.stringify(registry)).not.toContain("private task input");
  });

  it("reconciles a timed-out task start across restart before allowing another task", () => {
    const { registry, deps } = harness();
    const adapter = fakeAdapter((request) => {
      if (request.operation === "task.start") {
        return {
          schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
          kind: "failure",
          operation: "task.start",
          family: "task_timeout",
          retryable: true,
          component: "runtime",
        };
      }
      if (request.operation === "task.status") return activeAttachment(request.taskId);
      return taskResult(request.taskId, "cancelled");
    });

    const timedOut = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-uncertain",
        mode: "headless",
        input: "bounded input",
        adapter,
      },
      deps,
    );
    expect(timedOut.record).toMatchObject({ kind: "failure", family: "task_timeout" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "task.start",
      taskId: "task-uncertain",
      appliedPolicy,
    });

    registry.sandboxes.alpha = JSON.parse(JSON.stringify(registry.sandboxes.alpha));
    const blocked = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-next",
        mode: "headless",
        input: "next input",
        adapter,
      },
      deps,
    );
    expect(blocked.record).toMatchObject({ kind: "failure", family: "lifecycle_unavailable" });
    expect(adapter.execute).toHaveBeenCalledTimes(1);

    const observed = executeCuaTaskLifecycle(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-uncertain",
        adapter,
      },
      deps,
    );
    expect(observed.record).toMatchObject({
      kind: "target-attachment",
      activeTask: { taskId: "task-uncertain" },
    });
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "observed",
      observation: { via: "task.status", activeTask: { taskId: "task-uncertain" } },
    });

    const cancelled = executeCuaTaskLifecycle(
      {
        operation: "task.cancel",
        sandboxName: "alpha",
        taskId: "task-uncertain",
        adapter,
      },
      deps,
    );
    expect(cancelled.record).toMatchObject({
      kind: "task-result",
      taskId: "task-uncertain",
      status: "cancelled",
    });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
    expect(registry.sandboxes.alpha?.cuaReconciliation).toBeUndefined();
  });

  it("quarantines adapter output when live provider authority changes during invocation", () => {
    const { registry, deps } = harness(activeAttachment());
    let readinessChecks = 0;
    deps.requireRuntimeReadiness = (entry) => {
      readinessChecks += 1;
      if (readinessChecks > 1) throw new Error("provider authority changed");
      return entry.cuaRuntimeReadiness!;
    };
    const adapter = fakeAdapter(() => taskResult());

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "runtime_unavailable" });
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(readinessChecks).toBe(2);
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toEqual(readiness());
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(activeAttachment());
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "readiness-change",
      taskId: "task-1",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(deps.save).toHaveBeenCalledOnce();
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

  it("fails before task execution when the attestation names an unregistered verifier", () => {
    const { registry, deps } = harness();
    registry.sandboxes.alpha!.cuaSecurityAttestation!.verifier = component(
      "unregistered-verifier",
      digests.browser,
    );
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

  it("does not replay a retained result after its security attestation becomes stale", () => {
    const { registry, deps } = harness(attachment(), readiness(), [taskResult()]);
    registry.sandboxes.alpha!.cuaSecurityAttestation!.bindings.targetIdentityDigest =
      digests.browser;
    const adapter = fakeAdapter(() => taskResult());

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "policy_invalid" });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(deps.save).toHaveBeenCalledOnce();
  });

  it("does not replay a retained result after the effective policy revision changes", () => {
    const retained = taskResult();
    const { registry, deps } = harness(attachment(), readiness(), [retained]);
    const changedPolicy = { revision: 18, digest: `sha256:${"f".repeat(64)}` };
    registry.sandboxes.alpha!.cuaSecurityAttestation!.bindings.appliedPolicy = changedPolicy;
    deps.observeLiveAppliedPolicy = () => changedPolicy;

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.result", sandboxName: "alpha", taskId: retained.taskId },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([]);
  });

  it("rejects task output when the effective policy changes during adapter execution", () => {
    const { registry, deps } = harness(activeAttachment());
    let observations = 0;
    deps.observeLiveAppliedPolicy = () => {
      observations += 1;
      return observations === 1
        ? appliedPolicy
        : { revision: 18, digest: `sha256:${"f".repeat(64)}` };
    };
    const adapter = fakeAdapter(() => taskResult());

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.result", sandboxName: "alpha", taskId: "task-1", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "policy_invalid" });
    expect(observations).toBe(2);
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(activeAttachment().activeTask);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "policy-change",
      taskId: "task-1",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("quarantines a pre-change active task before it can be replayed", () => {
    const { registry, deps } = harness(activeAttachment());
    const changedPolicy = { revision: 18, digest: `sha256:${"f".repeat(64)}` };
    registry.sandboxes.alpha!.cuaSecurityAttestation!.bindings.appliedPolicy = changedPolicy;
    deps.observeLiveAppliedPolicy = () => changedPolicy;
    const adapter = fakeAdapter(() => activeAttachment());

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.status", sandboxName: "alpha", taskId: "task-1", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "policy_invalid" });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(activeAttachment().activeTask);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "policy-change",
      taskId: "task-1",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
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

  it("does not return a retained result after the qualified target adapter changes", () => {
    const currentRuntime = readiness();
    currentRuntime.components.targetAdapter = component(
      "changed-target-adapter",
      `sha256:${"e".repeat(64)}`,
    );
    const currentTarget = {
      ...attachment(),
      runtimeReadinessDigest: getCuaRuntimeReadinessDigest(currentRuntime),
    };
    const stale = taskResult();
    const { registry, deps } = harness(currentTarget, currentRuntime, [stale]);

    const outcome = executeCuaTaskLifecycle(
      { operation: "task.result", sandboxName: "alpha", taskId: stale.taskId },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTaskResults).toEqual([]);
  });

  it("rejects an adapter result replayed after the qualified target adapter changes", () => {
    const currentRuntime = readiness();
    currentRuntime.components.targetAdapter = component(
      "changed-target-adapter",
      `sha256:${"e".repeat(64)}`,
    );
    const currentTarget = {
      ...activeAttachment(),
      runtimeReadinessDigest: getCuaRuntimeReadinessDigest(currentRuntime),
    };
    const { deps } = harness(currentTarget, currentRuntime);
    const adapter = fakeAdapter(() => taskResult());

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.cancel",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "runtime_incompatible" });
  });

  it("rejects active-task output minted under another applied-policy identity", () => {
    const { registry, deps } = harness();
    const replayed = activeAttachment();
    replayed.activeTask!.appliedPolicy = {
      revision: 16,
      digest: `sha256:${"f".repeat(64)}`,
    };
    const adapter = fakeAdapter(() => replayed);

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "headless",
        input: "private task input",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "validation_failed" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toBeNull();
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

  it("does not erase active state when status reports a terminal timeout", () => {
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
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(activeAttachment().activeTask);
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
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(activeAttachment().activeTask);
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

  it("rejects semantically invalid terminal output from an injected adapter", () => {
    const invalid = taskResult();
    invalid.agentResult.status = "failed";
    const { registry, deps } = harness(activeAttachment());
    const adapter = fakeAdapter(() => invalid);

    const outcome = executeCuaTaskLifecycle(
      {
        operation: "task.result",
        sandboxName: "alpha",
        taskId: "task-1",
        adapter,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure" });
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
    const credentialShaped = executeCuaTaskLifecycle(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "ghp_abcdefghijklmnopqrstuvwxyz",
        mode: "headless",
        input: "task",
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
    expect(credentialShaped.record).toMatchObject({
      kind: "failure",
      family: "validation_failed",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
