// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  CuaTargetAdapter,
  CuaTargetAdapterRequest,
  CuaTargetAdapterResult,
} from "../adapters/cua-target";
import type { SandboxRegistry } from "../state/registry/types";
import {
  CUA_CAPABILITIES,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_REQUIRED_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  type CuaRuntimeReadiness,
  type CuaTargetAttachment,
} from "./contract";
import type { CuaTargetManifest } from "./schema";
import {
  type CuaTargetLifecycleDeps,
  detachedCuaTarget,
  executeCuaTargetLifecycle,
} from "./target-lifecycle";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

const runtimeReadiness: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  mode: "standalone",
  status: "available",
  components: {
    runtime: { name: "cua-fixture", version: "1.0.0", digest: digest("1"), owner: "fixture" },
    sandboxImage: {
      name: "cua-sandbox",
      version: "1.0.0",
      digest: digest("2"),
      owner: "fixture",
    },
    policy: { name: "cua-policy", version: "1.0.0", digest: digest("3"), owner: "fixture" },
    taskProtocol: {
      name: "cua-task",
      version: "1.0.0",
      digest: digest("4"),
      owner: "fixture",
    },
  },
  inference: { provider: "fixture", model: "fixture-model" },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: CUA_CAPABILITIES,
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_REQUIRED_TASK_OPERATIONS,
};

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
    },
  };
}

describe("CUA target lifecycle (#7751)", () => {
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
        current: detachedCuaTarget(),
      }),
    );
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
    expect(registry.sandboxes.alpha?.cuaTarget).toBeUndefined();
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
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual({ ...current, status: "replaced" });
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
  });

  it("records an unreachable target without exposing adapter diagnostics", () => {
    const current = attachedTarget();
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
  });

  it("rejects reset while the target has an active task", () => {
    const current: CuaTargetAttachment = {
      ...attachedTarget(),
      activeTask: { taskId: "task-1", status: "running" },
    };
    const { deps } = harness(current);
    const adapter = fakeAdapter(() => attachedTarget({ identityDigest: digest("8") }));

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.reset", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome.record).toMatchObject({ kind: "failure", family: "task_conflict" });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("accepts a reset replacement only after component and capability checks pass", () => {
    const current = attachedTarget();
    const replacement = attachedTarget({ identityDigest: digest("8") });
    const { registry, deps } = harness(current);
    const adapter = fakeAdapter(() => replacement);

    const outcome = executeCuaTargetLifecycle(
      { operation: "target.reset", sandboxName: "alpha", adapter },
      deps,
    );

    expect(outcome).toEqual({ record: replacement, exitCode: 0 });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(replacement);
  });

  it.each([
    "target.detach",
    "target.destroy",
  ] as const)("%s clears attachment state after the adapter revokes reachability", (operation) => {
    const { registry, deps } = harness(attachedTarget());
    const adapter = fakeAdapter(() => detachedCuaTarget());

    const outcome = executeCuaTargetLifecycle({ operation, sandboxName: "alpha", adapter }, deps);

    expect(outcome).toEqual({ record: detachedCuaTarget(), exitCode: 0 });
    expect(registry.sandboxes.alpha?.cuaTarget).toEqual(detachedCuaTarget());
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
