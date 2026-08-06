// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type {
  CuaTargetAdapter,
  CuaTargetAdapterRequest,
  CuaTargetAdapterResult,
} from "../adapters/cua-target";
import type { SandboxRegistry } from "../state/registry/types";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_CAPABILITIES,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_TARGET_OPERATIONS,
  CUA_TASK_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  getCuaRuntimeReadinessDigest,
} from "./contract";
import type { CuaTargetManifest } from "./schema";
import {
  type CuaTargetLifecycleDeps,
  detachedCuaTarget,
  executeCuaTargetLifecycle,
  readCuaTargetManifest,
} from "./target-lifecycle";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const appliedPolicy = { revision: 17, digest: digest("a") } as const;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

const runtimeReadiness: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  agent: "nemocua",
  mode: "standalone",
  status: "available",
  sourceRevision: "a".repeat(40),
  sourceClean: true,
  runtimeManifestDigest: digest("e"),
  providerAuthorityDigest: digest("0"),
  qualification: {
    state: "qualified",
    candidateSourceRevision: "b".repeat(40),
    environmentDigest: digest("c"),
    receiptDigest: digest("d"),
    bundleReceiptDigest: digest("f"),
  },
  components: {
    openshell: {
      name: "openshell",
      version: "qualification-bound",
      digest: digest("0"),
      owner: "fixture",
    },
    runtime: { name: "cua-fixture", version: "1.0.0", digest: digest("1"), owner: "fixture" },
    sandboxImage: {
      name: "cua-sandbox",
      version: "1.0.0",
      digest: digest("2"),
      owner: "fixture",
    },
    targetAdapter: {
      name: "cua-target-adapter",
      version: "1.0.0",
      digest: digest("a"),
      owner: "fixture",
    },
    policy: { name: "cua-policy", version: "1.0.0", digest: digest("3"), owner: "fixture" },
    taskProtocol: {
      name: "cua-task",
      version: "1.0.0",
      digest: digest("4"),
      owner: "fixture",
    },
    securityVerifier: {
      name: "cua-security-verifier",
      version: "1.0.0",
      digest: digest("8"),
      owner: "fixture",
    },
  },
  inference: { provider: "fixture", model: "fixture-model", routeDigest: digest("9") },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: CUA_CAPABILITIES,
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_TASK_OPERATIONS,
  securityOperations: ["security.status", "security.verify"],
};
const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(runtimeReadiness);

const manifest: CuaTargetManifest = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-manifest",
  identityDigest: digest("5"),
  platform: "fixture-linux-amd64",
  image: { name: "desktop-fixture", version: "1.0.0", digest: digest("6"), owner: "fixture" },
  serviceBundle: {
    name: "desktop-services",
    version: "1.0.0",
    digest: digest("7"),
    owner: "fixture",
  },
  capabilities: [
    { id: "browser", protocolVersion: "1.0.0" },
    { id: "computer", protocolVersion: "1.0.0" },
    { id: "terminal", protocolVersion: "1.0.0" },
  ],
};

function attachedTarget(
  overrides: Partial<NonNullable<CuaTargetAttachment["target"]>> = {},
): CuaTargetAttachment {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "attached",
    runtimeReadinessDigest,
    target: {
      identityDigest: manifest.identityDigest,
      platform: manifest.platform,
      image: manifest.image,
      serviceBundle: manifest.serviceBundle,
      capabilities: manifest.capabilities.map((capability) => ({
        ...capability,
        health: "healthy" as const,
      })),
      ...overrides,
    },
    activeTask: null,
  };
}

function securityAttestation(target: CuaTargetAttachment): CuaSecurityAttestation {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      runtimeReadinessDigest,
      targetIdentityDigest: target.target!.identityDigest,
      components: {
        openshell: runtimeReadiness.components.openshell,
        runtime: runtimeReadiness.components.runtime,
        sandboxImage: runtimeReadiness.components.sandboxImage,
        targetImage: target.target!.image,
        serviceBundle: target.target!.serviceBundle,
        policy: runtimeReadiness.components.policy,
        taskProtocol: runtimeReadiness.components.taskProtocol,
      },
      inference: runtimeReadiness.inference,
      appliedPolicy,
      capabilities: target.target!.capabilities.map(({ id, protocolVersion }) => ({
        id,
        protocolVersion,
      })),
    },
    network: {
      defaultAction: "deny",
      managedInference: "only",
      targetServices: CUA_CAPABILITIES,
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
    verifier: runtimeReadiness.components.securityVerifier,
  };
}

function fakeAdapter(
  implementation: (request: CuaTargetAdapterRequest) => CuaTargetAdapterResult,
): CuaTargetAdapter & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(implementation) };
}

function harness(target?: CuaTargetAttachment): {
  registry: SandboxRegistry;
  deps: CuaTargetLifecycleDeps;
} {
  const registry: SandboxRegistry = {
    defaultSandbox: "alpha",
    sandboxes: {
      alpha: {
        name: "alpha",
        cuaRuntimeReadiness: structuredClone(runtimeReadiness),
        ...(target ? { cuaTarget: structuredClone(target) } : {}),
        ...(target ? { cuaSecurityAttestation: structuredClone(securityAttestation(target)) } : {}),
        cuaTaskResults: [],
      },
    },
  };
  return {
    registry,
    deps: {
      load: () => structuredClone(registry),
      save: (next) => {
        registry.defaultSandbox = next.defaultSandbox;
        registry.sandboxes = structuredClone(next.sandboxes);
      },
      withLock: (fn) => fn(),
      isFrameworkEnabled: () => true,
      requireRuntimeReadiness: (entry) => entry.cuaRuntimeReadiness!,
      getRuntimeTargetAuthority: () => ({
        platform: manifest.platform,
        image: manifest.image,
        serviceBundle: manifest.serviceBundle,
      }),
      observeLiveAppliedPolicy: () => appliedPolicy,
    },
  };
}

describe("CUA target lifecycle (#7751)", () => {
  it("never executes the target adapter while the registry lock is held", () => {
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
    const adapter = fakeAdapter(() => {
      expect(registryLockHeld).toBe(false);
      expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
        phase: "pending",
        trigger: "target.attach",
      });
      return attachedTarget();
    });

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    expect(outcome.exitCode).toBe(0);
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(registry.sandboxes.alpha?.cuaReconciliation).toBeUndefined();
  });

  it("fails closed before reading state when the framework is not enabled", () => {
    const { deps } = harness();
    deps.isFrameworkEnabled = () => false;
    deps.load = vi.fn(deps.load);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.status", sandboxName: "alpha" },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "lifecycle_unavailable",
      component: "runtime",
    });
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("rejects an attach tuple that differs from the runtime authority", () => {
    const { deps } = harness();
    const adapter = fakeAdapter(() => attachedTarget());
    const mismatchedManifest: CuaTargetManifest = {
      ...manifest,
      image: component("unqualified-target", "a"),
    };

    const outcome = executeCuaTargetLifecycle(
      {
        operation: "target.attach",
        sandboxName: "alpha",
        adapter,
        manifest: mismatchedManifest,
      },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "target_incompatible",
      component: "target",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("quarantines a retained target whose tuple differs from runtime authority", () => {
    const retained = attachedTarget({ image: component("stale-target", "a") });
    const { registry, deps } = harness(retained);
    const adapter = fakeAdapter(() => retained);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "target_incompatible",
      component: "target",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(retained);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "runtime-authority-change",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("quarantines external target state when current-build readiness validation fails", () => {
    const { registry, deps } = harness(attachedTarget());
    deps.requireRuntimeReadiness = () => {
      throw new Error("executing build changed");
    };

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.status", sandboxName: "alpha" },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "runtime_unavailable" });
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toEqual(runtimeReadiness);
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(attachedTarget());
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "readiness-change",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("rejects a symlinked target manifest before parsing it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-target-manifest-"));
    try {
      const target = path.join(directory, "target.json");
      const link = path.join(directory, "manifest.json");
      fs.writeFileSync(target, JSON.stringify(manifest));
      fs.symlinkSync(target, link);

      expect(() => readCuaTargetManifest(link)).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized target manifest before parsing it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-target-manifest-"));
    try {
      const oversized = path.join(directory, "manifest.json");
      fs.writeFileSync(oversized, "x".repeat(64 * 1024 + 1));

      expect(() => readCuaTargetManifest(oversized)).toThrow(/regular file/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("attaches only after immutable identity and all capability checks pass", () => {
    const { registry, deps } = harness();
    const adapter = fakeAdapter(() => attachedTarget());

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    expect(outcome).toEqual({ record: attachedTarget(), exitCode: 0 });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(attachedTarget());
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "target.attach",
        sandboxName: "alpha",
        manifest,
        current: detachedCuaTarget(runtimeReadinessDigest),
      }),
    );
  });

  it("reconciles an attach timeout through independent health and explicit destroy", () => {
    const { registry, deps } = harness();
    const adapter = fakeAdapter((request) => {
      if (request.operation === "target.attach") {
        return {
          schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
          kind: "failure",
          operation: "target.attach",
          family: "target_unreachable",
          retryable: true,
          component: "target",
        };
      }
      if (request.operation === "target.health") return attachedTarget();
      return detachedCuaTarget(runtimeReadinessDigest);
    });

    const timedOut = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );
    expect(timedOut.record).toMatchObject({ kind: "failure", family: "target_unreachable" });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(detachedCuaTarget(runtimeReadinessDigest));
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "target.attach",
      runtimeReadinessDigest,
    });

    const blocked = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );
    expect(blocked.record).toMatchObject({ kind: "failure", family: "lifecycle_unavailable" });
    expect(adapter.execute).toHaveBeenCalledTimes(1);

    const observed = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );
    expect(observed.record).toMatchObject({ kind: "target-attachment", status: "attached" });
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "observed",
      observation: { via: "target.health", targetStatus: "attached", activeTask: null },
    });

    const destroyed = executeCuaTargetLifecycle(
      { operation: "target.destroy", sandboxName: "alpha", adapter },
      deps,
    );
    expect(destroyed).toEqual({
      record: detachedCuaTarget(runtimeReadinessDigest),
      exitCode: 0,
    });
    expect(registry.sandboxes.alpha?.cuaReconciliation).toBeUndefined();
  });

  it("never hides an unexpected active task observed by target health", () => {
    const current = attachedTarget();
    const unexpected: CuaTargetAttachment = {
      ...current,
      activeTask: { taskId: "task-unexpected", status: "running", appliedPolicy },
    };
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() => unexpected);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toEqual(unexpected);
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(unexpected.activeTask);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "observed",
      trigger: "unexpected-active-task",
      taskId: "task-unexpected",
      observation: {
        via: "target.health",
        activeTask: { taskId: "task-unexpected", status: "running" },
      },
    });
    expect(
      executeCuaTargetLifecycle(
        { operation: "target.destroy", sandboxName: "alpha", adapter },
        deps,
      ).record,
    ).toMatchObject({ kind: "failure", family: "lifecycle_unavailable" });
  });

  it("discards adapter output when live readiness changes before persistence", () => {
    const { registry, deps } = harness();
    let validationCount = 0;
    deps.requireRuntimeReadiness = (entry) => {
      validationCount += 1;
      if (validationCount === 1) return entry.cuaRuntimeReadiness!;
      return {
        ...entry.cuaRuntimeReadiness!,
        providerAuthorityDigest: digest("a"),
      };
    };
    const adapter = fakeAdapter(() => attachedTarget());

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "runtime_unavailable",
      component: "runtime",
    });
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toEqual(runtimeReadiness);
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(detachedCuaTarget(runtimeReadinessDigest));
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "target.attach",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("rejects semantically invalid target output from an injected adapter", () => {
    const { registry, deps } = harness();
    const unsafe = attachedTarget({
      image: { ...manifest.image, owner: "ghp_abcdefghijklmnopqrstuvwxyz" },
    });
    const adapter = fakeAdapter(() => unsafe);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure" });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(detachedCuaTarget(runtimeReadinessDigest));
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "target.attach",
    });
  });

  it("rejects a second target before invoking the adapter", () => {
    const current = attachedTarget();
    const { deps } = harness(current);
    const adapter = fakeAdapter(() => current);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "target_conflict" });
    expect(outcome.exitCode).toBe(3);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("rejects an observed target whose immutable identity does not match the manifest", () => {
    const { registry, deps } = harness();
    const adapter = fakeAdapter(() => attachedTarget({ identityDigest: digest("8") }));

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "target_incompatible" });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(detachedCuaTarget(runtimeReadinessDigest));
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "target.attach",
    });
  });

  it("records a changed identity as replaced without granting fresh authority", () => {
    const current = attachedTarget();
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() => attachedTarget({ identityDigest: digest("8") }));

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "target_replaced" });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual({
      ...attachedTarget({ identityDigest: digest("8") }),
      status: "replaced",
    });
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "observed",
      trigger: "runtime-authority-change",
      observation: { targetStatus: "replaced", targetIdentityDigest: digest("8") },
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
  });

  it("records service-bundle drift as incompatible", () => {
    const current = attachedTarget();
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() =>
      attachedTarget({
        serviceBundle: { ...manifest.serviceBundle, digest: digest("8") },
      }),
    );

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "target_incompatible" });
    expect(registry.sandboxes.alpha?.cuaTarget?.status).toBe("incompatible");
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
  });

  it("records an unreachable target without exposing adapter diagnostics", () => {
    const current: CuaTargetAttachment = {
      ...attachedTarget(),
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter((request) => ({
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "failure",
      operation: request.operation,
      family: "target_unreachable",
      retryable: true,
      component: "target",
    }));

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "target_unreachable" });
    expect(registry.sandboxes.alpha?.cuaTarget?.status).toBe("unreachable");
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(current.activeTask);
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("classifies one failed service check without disturbing other capability identities", () => {
    const current = attachedTarget();
    const unhealthy: CuaTargetAttachment = {
      ...current,
      status: "unreachable",
      target: {
        ...current.target!,
        capabilities: current.target!.capabilities.map((capability) => ({
          ...capability,
          health: capability.id === "browser" ? "unhealthy" : "healthy",
        })),
      },
    };
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() => unhealthy);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "capability_unhealthy",
      component: "browser",
    });
    expect(registry.sandboxes.alpha?.cuaTarget).toMatchObject({
      status: "unreachable",
      target: {
        capabilities: expect.arrayContaining([
          expect.objectContaining({ id: "browser", health: "unhealthy" }),
        ]),
      },
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
  });

  it("preserves the current attestation after a healthy identity-stable probe", () => {
    const current = attachedTarget();
    const { registry, deps } = harness(current);
    const original = structuredClone(registry.sandboxes.alpha?.cuaSecurityAttestation);
    const adapter = fakeAdapter(() => current);
    let policyObservations = 0;
    deps.observeLiveAppliedPolicy = () => {
      policyObservations += 1;
      return appliedPolicy;
    };

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome).toEqual({ record: current, exitCode: 0 });
    expect(policyObservations).toBe(2);
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toEqual(original);
  });

  it("discards a healthy probe and clears derived state when policy changes during execution", () => {
    const current: CuaTargetAttachment = {
      ...attachedTarget(),
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    const { registry, deps } = harness(current);
    const changedPolicy = { revision: 18, digest: digest("b") };
    let policyObservations = 0;
    deps.observeLiveAppliedPolicy = () => {
      policyObservations += 1;
      return policyObservations === 1 ? appliedPolicy : changedPolicy;
    };
    const adapter = fakeAdapter(() => current);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(policyObservations).toBe(2);
    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "policy_invalid",
      component: "policy",
    });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(current.activeTask);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "policy-change",
      taskId: "task-1",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("rejects a healthy probe when policy changes without retained derived state", () => {
    const current = attachedTarget();
    const { registry, deps } = harness(current);
    delete registry.sandboxes.alpha?.cuaSecurityAttestation;
    delete registry.sandboxes.alpha?.cuaTaskResults;
    const changedPolicy = { revision: 18, digest: digest("b") };
    let policyObservations = 0;
    deps.observeLiveAppliedPolicy = () => {
      policyObservations += 1;
      return policyObservations === 1 ? appliedPolicy : changedPolicy;
    };
    const adapter = fakeAdapter(() => current);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.health", sandboxName: "alpha", adapter },
      deps,
    );

    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(policyObservations).toBe(2);
    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "policy_invalid",
      component: "policy",
    });
  });

  it.each([
    "target.detach",
    "target.destroy",
  ] as const)("rejects %s while the target has an active task", (operation) => {
    const current: CuaTargetAttachment = {
      ...attachedTarget(),
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() => attachedTarget({ identityDigest: digest("8") }));

    const outcome = executeCuaTargetLifecycle({ operation, sandboxName: "alpha", adapter }, deps);

    expect(outcome).toMatchObject({
      record: { kind: "failure", family: "task_conflict" },
      exitCode: 3,
    });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(current);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    "target.detach",
    "target.destroy",
  ] as const)("%s clears attachment state after the adapter revokes reachability", (operation) => {
    const { registry, deps } = harness(attachedTarget());
    const adapter = fakeAdapter(() => detachedCuaTarget(runtimeReadinessDigest));

    const outcome = executeCuaTargetLifecycle({ operation, sandboxName: "alpha", adapter }, deps);

    expect(outcome).toEqual({
      record: detachedCuaTarget(runtimeReadinessDigest),
      exitCode: 0,
    });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(detachedCuaTarget(runtimeReadinessDigest));
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("reports the target lifecycle unavailable before canonical runtime registration", () => {
    const { registry, deps } = harness();
    delete registry.sandboxes.alpha!.cuaRuntimeReadiness;

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.status", sandboxName: "alpha" },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "lifecycle_unavailable" });
    expect(outcome.exitCode).toBe(4);
  });

  it("quarantines an active task before target status can project a changed policy", () => {
    const current: CuaTargetAttachment = {
      ...attachedTarget(),
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    const { registry, deps } = harness(current);
    deps.observeLiveAppliedPolicy = () => ({ revision: 18, digest: digest("b") });

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.status", sandboxName: "alpha" },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "policy_invalid" });
    expect(registry.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(current.activeTask);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "policy-change",
      taskId: "task-1",
    });
    expect(registry.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(registry.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
  });

  it("quarantines target state when its readiness identity is stale", () => {
    const current = { ...attachedTarget(), runtimeReadinessDigest: digest("a") };
    const { registry, deps } = harness(current);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.status", sandboxName: "alpha" },
      deps,
    );

    expect(outcome).toMatchObject({
      record: { kind: "failure", family: "runtime_unavailable" },
      exitCode: 4,
    });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(current);
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "readiness-change",
    });
  });

  it("quarantines all CUA authority when the durable inference route drifts", () => {
    const { registry, deps } = harness(attachedTarget());
    registry.sandboxes.alpha!.provider = "other-provider";

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.status", sandboxName: "alpha" },
      deps,
    );

    expect(outcome.record).toMatchObject({
      kind: "failure",
      family: "inference_unavailable",
      component: "inference",
    });
    expect(registry.sandboxes.alpha?.cuaRuntimeReadiness).toEqual(runtimeReadiness);
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(attachedTarget());
    expect(registry.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "inference-change",
    });
  });

  it("stores only the secret-free target projection", () => {
    const { registry, deps } = harness();
    const adapter = fakeAdapter(() => attachedTarget());
    executeCuaTargetLifecycle(
      { operation: "target.attach", sandboxName: "alpha", adapter, manifest },
      deps,
    );

    const persisted = JSON.stringify(registry);
    expect(persisted).not.toMatch(
      /credential|password|secret|token|endpoint|hostname|instance|ssh|vnc|path/i,
    );
  });
});
