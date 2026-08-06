// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CUA_CAPABILITIES,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  type CuaRuntimeReadiness,
  getCuaRuntimeReadinessDigest,
} from "./contract";
import { createCuaReconciliationState } from "./reconciliation";
import type { CuaAdapterBindings } from "./runtime-manifest";
import { executeCuaSecurityCommand } from "./security-command";
import type { CuaSecurityLifecycleInput } from "./security-lifecycle";
import { executeCuaTargetCommand } from "./target-command";
import type { CuaTargetLifecycleInput } from "./target-lifecycle";
import { executeCuaTaskCommand } from "./task-command";
import type { CuaTaskLifecycleInput } from "./task-lifecycle";

const digest = `sha256:${"a".repeat(64)}`;

const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: `sha256:${value.repeat(64).slice(0, 64)}`,
  owner: "fixture",
});

function retainedReadiness(): CuaRuntimeReadiness {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status: "available",
    sourceRevision: "a".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: component("manifest", "e").digest,
    providerAuthorityDigest: component("provider", "f").digest,
    qualification: {
      state: "qualified",
      candidateSourceRevision: "b".repeat(40),
      environmentDigest: component("environment", "c").digest,
      receiptDigest: component("receipt", "d").digest,
      bundleReceiptDigest: component("bundle", "7").digest,
    },
    components: {
      openshell: component("openshell", "0"),
      runtime: component("runtime", "1"),
      sandboxImage: component("sandbox-image", "2"),
      targetAdapter: component("target-adapter", "3"),
      policy: component("policy", "4"),
      taskProtocol: component("task-adapter", "5"),
      securityVerifier: component("security-adapter", "6"),
    },
    inference: {
      provider: "fixture",
      model: "fixture-model",
      routeDigest: component("route", "8").digest,
    },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: CUA_CAPABILITIES,
    targetOperations: CUA_TARGET_OPERATIONS,
    taskOperations: CUA_TASK_OPERATIONS,
    securityOperations: ["security.status", "security.verify"],
  };
}

function bindings(): CuaAdapterBindings {
  return {
    target: { path: "/opt/nemocua/target-adapter", digest, sizeBytes: 128 },
    task: { path: "/opt/nemocua/task-adapter", digest, sizeBytes: 128 },
    security: { path: "/opt/nemocua/security-adapter", digest, sizeBytes: 128 },
  };
}

const frameworkEnabled = () => true;
const withoutSandboxContention = async <T>(
  _sandboxName: string,
  operation: () => Promise<T> | T,
): Promise<T> => await operation();
const withoutGatewayContention = async <T>(
  _gatewayName: string,
  operation: () => Promise<T> | T,
): Promise<T> => await operation();

describe("public CUA command adapter authority", () => {
  it("fails before reading disabled command inputs, adapter authority, or state", async () => {
    const isFrameworkEnabled = vi.fn(() => false);
    const readManifest = vi.fn((_path: string) => {
      throw new Error("disabled target manifest read");
    });
    const readPrivateInput = vi.fn((_path: string) => {
      throw new Error("disabled private input read");
    });
    const getAdapterBindings = vi.fn(() => {
      throw new Error("disabled adapter authority read");
    });
    const getSandbox = vi.fn((_name: string) => {
      throw new Error("disabled registry read");
    });
    const targetLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => {
      throw new Error("disabled target lifecycle");
    });
    const taskLifecycle = vi.fn((_input: CuaTaskLifecycleInput) => {
      throw new Error("disabled task lifecycle");
    });
    const securityLifecycle = vi.fn((_input: CuaSecurityLifecycleInput) => {
      throw new Error("disabled security lifecycle");
    });

    const target = await executeCuaTargetCommand(
      {
        operation: "target.attach",
        sandboxName: "alpha",
        manifestPath: "/private/target-manifest.json",
        adapterPath: bindings().target.path,
      },
      {
        isFrameworkEnabled,
        readManifest,
        getAdapterBindings,
        getSandbox,
        executeLifecycle: targetLifecycle,
      },
    );
    const task = await executeCuaTaskCommand(
      {
        operation: "task.start",
        sandboxName: "alpha",
        taskId: "task-1",
        mode: "interactive",
        inputPath: "/private/task-input.txt",
        adapterPath: bindings().task.path,
      },
      {
        isFrameworkEnabled,
        readPrivateInput,
        getAdapterBindings,
        getSandbox,
        executeLifecycle: taskLifecycle,
      },
    );
    const security = await executeCuaSecurityCommand(
      {
        operation: "security.verify",
        sandboxName: "alpha",
        adapterPath: bindings().security.path,
      },
      {
        isFrameworkEnabled,
        getAdapterBindings,
        getSandbox,
        executeLifecycle: securityLifecycle,
      },
    );

    for (const result of [target, task, security]) {
      expect(result).toMatchObject({
        exitCode: 4,
        record: {
          kind: "failure",
          family: "lifecycle_unavailable",
          retryable: false,
          component: "runtime",
        },
      });
    }
    expect(isFrameworkEnabled).toHaveBeenCalledTimes(3);
    expect(readManifest).not.toHaveBeenCalled();
    expect(readPrivateInput).not.toHaveBeenCalled();
    expect(getAdapterBindings).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(targetLifecycle).not.toHaveBeenCalled();
    expect(taskLifecycle).not.toHaveBeenCalled();
    expect(securityLifecycle).not.toHaveBeenCalled();
  });

  it("rejects unadvertised commands before reading inputs or invoking adapters (#7755)", async () => {
    const readManifest = vi.fn(() => {
      throw new Error("unadvertised target manifest read");
    });
    const readPrivateInput = vi.fn(() => {
      throw new Error("unadvertised task input read");
    });
    const getAdapterBindings = vi.fn(() => {
      throw new Error("unadvertised adapter authority read");
    });
    const getSandbox = vi.fn(() => {
      throw new Error("unadvertised registry read");
    });
    const targetLifecycle = vi.fn();
    const taskLifecycle = vi.fn();

    const target = await executeCuaTargetCommand(
      {
        operation: "target.reset",
        sandboxName: "alpha",
        manifestPath: "/private/target-manifest.json",
        adapterPath: "/private/target-adapter",
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        readManifest,
        getAdapterBindings,
        getSandbox,
        executeLifecycle: targetLifecycle,
      },
    );
    const task = await executeCuaTaskCommand(
      {
        operation: "task.guide",
        sandboxName: "alpha",
        taskId: "task-1",
        inputPath: "/private/task-input.txt",
        adapterPath: "/private/task-adapter",
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        readPrivateInput,
        getAdapterBindings,
        getSandbox,
        executeLifecycle: taskLifecycle,
      },
    );

    for (const outcome of [target, task]) {
      expect(outcome).toMatchObject({
        exitCode: 4,
        record: { kind: "failure", family: "lifecycle_unavailable", retryable: false },
      });
    }
    expect(readManifest).not.toHaveBeenCalled();
    expect(readPrivateInput).not.toHaveBeenCalled();
    expect(getAdapterBindings).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(targetLifecycle).not.toHaveBeenCalled();
    expect(taskLifecycle).not.toHaveBeenCalled();
  });

  it("orders the sandbox lease before the gateway lease and lifecycle execution", async () => {
    const sequence: string[] = [];
    const executeLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => {
      sequence.push("lifecycle");
      return {
        record: {
          schemaVersion: "1.1.0",
          kind: "failure" as const,
          operation: "target.status" as const,
          family: "target_unreachable" as const,
          retryable: true,
          component: "target" as const,
        },
        exitCode: 5,
      };
    });

    await executeCuaTargetCommand(
      { operation: "target.status", sandboxName: "alpha" },
      {
        isFrameworkEnabled: frameworkEnabled,
        executeLifecycle,
        getSandbox: () => ({ name: "alpha" }),
        withSandboxMutationLock: async (sandboxName, operation) => {
          expect(sandboxName).toBe("alpha");
          sequence.push("sandbox-start");
          const result = await operation();
          sequence.push("sandbox-end");
          return result;
        },
        withGatewayRouteMutationLock: async (gatewayName, operation) => {
          expect(gatewayName).toBe("nemoclaw");
          sequence.push("gateway-start");
          const result = await operation();
          sequence.push("gateway-end");
          return result;
        },
      },
    );

    expect(sequence).toEqual([
      "sandbox-start",
      "gateway-start",
      "lifecycle",
      "gateway-end",
      "sandbox-end",
    ]);
  });

  it("binds target and task process adapters to the runtime manifest path and digest", async () => {
    const targetLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "target.health" as const,
        family: "target_unreachable" as const,
        retryable: true,
        component: "target" as const,
      },
      exitCode: 5,
    }));
    const taskLifecycle = vi.fn((_input: CuaTaskLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "task.status" as const,
        family: "runtime_unavailable" as const,
        retryable: false,
        component: "runtime" as const,
      },
      exitCode: 4,
    }));

    await executeCuaTargetCommand(
      {
        operation: "target.health",
        sandboxName: "alpha",
        adapterPath: bindings().target.path,
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: bindings,
        executeLifecycle: targetLifecycle,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );
    await executeCuaTaskCommand(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapterPath: bindings().task.path,
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: bindings,
        executeLifecycle: taskLifecycle,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );

    expect(targetLifecycle.mock.calls[0]?.[0].adapter).toMatchObject({
      executable: bindings().target.path,
      expectedDigest: digest,
    });
    expect(taskLifecycle.mock.calls[0]?.[0].adapter).toMatchObject({
      executable: bindings().task.path,
      expectedDigest: digest,
    });
  });

  it("rejects substituted current-manifest adapter bytes while reconciling an older effect", async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-retained-adapter-"),
    );
    const adapterPath = path.join(temporaryDirectory, "target-adapter.sh");
    const markerPath = path.join(temporaryDirectory, "substituted-adapter-ran");
    fs.writeFileSync(adapterPath, `#!/bin/sh\ntouch '${markerPath}'\n`, { mode: 0o755 });
    const readiness = retainedReadiness();
    const readinessDigest = getCuaRuntimeReadinessDigest(readiness);
    const getAdapterBindings = vi.fn(() => ({
      ...bindings(),
      target: {
        path: adapterPath,
        digest: component("substituted-target-adapter", "9").digest,
        sizeBytes: fs.statSync(adapterPath).size,
      },
    }));
    const executeLifecycle = vi.fn((input: CuaTargetLifecycleInput) => {
      input.adapter?.execute({
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "target-adapter-request",
        operation: "target.health",
        sandboxName: "alpha",
        manifest: null,
        current: {
          schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
          kind: "target-attachment",
          status: "detached",
          runtimeReadinessDigest: readinessDigest,
          target: null,
          activeTask: null,
        },
      });
      throw new Error("a substituted adapter must never complete reconciliation");
    });

    try {
      const result = await executeCuaTargetCommand(
        {
          operation: "target.health",
          sandboxName: "alpha",
          adapterPath,
        },
        {
          isFrameworkEnabled: frameworkEnabled,
          getAdapterBindings,
          executeLifecycle,
          getSandbox: () => ({
            name: "alpha",
            cuaRuntimeReadiness: readiness,
            cuaReconciliation: createCuaReconciliationState({
              trigger: "readiness-change",
              runtimeReadinessDigest: readinessDigest,
            }),
          }),
          withSandboxMutationLock: withoutSandboxContention,
          withGatewayRouteMutationLock: withoutGatewayContention,
        },
      );

      expect(result).toMatchObject({
        exitCode: 4,
        record: { kind: "failure", family: "runtime_unavailable" },
      });
      expect(executeLifecycle).toHaveBeenCalledOnce();
      expect(executeLifecycle.mock.calls[0]?.[0].adapter).toMatchObject({
        executable: adapterPath,
        expectedDigest: readiness.components.targetAdapter.digest,
      });
      expect(getAdapterBindings).not.toHaveBeenCalled();
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("binds every reconciliation adapter to the retained readiness instead of the current manifest", async () => {
    const readiness = retainedReadiness();
    const entry = {
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaReconciliation: createCuaReconciliationState({
        trigger: "readiness-change",
        runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
      }),
    };
    const getAdapterBindings = vi.fn(() => {
      throw new Error("current manifest adapter authority must not be used for reconciliation");
    });
    const targetLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => ({
      record: {
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "failure" as const,
        operation: "target.health" as const,
        family: "target_unreachable" as const,
        retryable: true,
        component: "target" as const,
      },
      exitCode: 5,
    }));
    const taskLifecycle = vi.fn((_input: CuaTaskLifecycleInput) => ({
      record: {
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "failure" as const,
        operation: "task.status" as const,
        family: "runtime_unavailable" as const,
        retryable: false,
        component: "runtime" as const,
      },
      exitCode: 4,
    }));
    const securityLifecycle = vi.fn((_input: CuaSecurityLifecycleInput) => ({
      record: {
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "failure" as const,
        operation: "security.verify" as const,
        family: "policy_invalid" as const,
        retryable: false,
        component: "policy" as const,
      },
      exitCode: 5,
    }));
    const common = {
      isFrameworkEnabled: frameworkEnabled,
      getAdapterBindings,
      getSandbox: () => entry,
      withSandboxMutationLock: withoutSandboxContention,
      withGatewayRouteMutationLock: withoutGatewayContention,
      resolveQualificationArtifactRunner: () => undefined,
    };

    await executeCuaTargetCommand(
      {
        operation: "target.health",
        sandboxName: "alpha",
        adapterPath: "/retained/target-adapter",
      },
      { ...common, executeLifecycle: targetLifecycle },
    );
    await executeCuaTaskCommand(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapterPath: "/retained/task-adapter",
      },
      { ...common, executeLifecycle: taskLifecycle },
    );
    await executeCuaSecurityCommand(
      {
        operation: "security.verify",
        sandboxName: "alpha",
        adapterPath: "/retained/security-adapter",
      },
      { ...common, executeLifecycle: securityLifecycle },
    );

    expect(targetLifecycle.mock.calls[0]?.[0].adapter).toMatchObject({
      expectedDigest: readiness.components.targetAdapter.digest,
    });
    expect(taskLifecycle.mock.calls[0]?.[0].adapter).toMatchObject({
      expectedDigest: readiness.components.taskProtocol.digest,
    });
    expect(securityLifecycle.mock.calls[0]?.[0].adapter).toMatchObject({
      expectedDigest: readiness.components.securityVerifier.digest,
    });
    expect(getAdapterBindings).not.toHaveBeenCalled();
  });

  it("fails closed when a reconciliation journal no longer matches retained readiness", async () => {
    const originalReadiness = retainedReadiness();
    const changedReadiness = {
      ...originalReadiness,
      sourceRevision: "c".repeat(40),
    };
    const getAdapterBindings = vi.fn(() => bindings());
    const executeLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => {
      throw new Error("mismatched retained authority must not reach lifecycle execution");
    });
    const resolveQualificationArtifactRunner = vi.fn(() => undefined);

    const result = await executeCuaTargetCommand(
      {
        operation: "target.health",
        sandboxName: "alpha",
        adapterPath: "/retained/target-adapter",
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings,
        executeLifecycle,
        getSandbox: () => ({
          name: "alpha",
          cuaRuntimeReadiness: changedReadiness,
          cuaReconciliation: createCuaReconciliationState({
            trigger: "readiness-change",
            runtimeReadinessDigest: getCuaRuntimeReadinessDigest(originalReadiness),
          }),
        }),
        withSandboxMutationLock: withoutSandboxContention,
        withGatewayRouteMutationLock: withoutGatewayContention,
        resolveQualificationArtifactRunner,
      },
    );

    expect(result).toMatchObject({
      exitCode: 4,
      record: { kind: "failure", family: "runtime_unavailable" },
    });
    expect(getAdapterBindings).not.toHaveBeenCalled();
    expect(resolveQualificationArtifactRunner).not.toHaveBeenCalled();
    expect(executeLifecycle).not.toHaveBeenCalled();
  });

  it("routes every candidate adapter through one validated qualification isolation runner", async () => {
    const runner = "/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner";
    const resolveQualificationArtifactRunner = vi.fn(() => runner);
    const targetLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "target.health" as const,
        family: "target_unreachable" as const,
        retryable: true,
        component: "target" as const,
      },
      exitCode: 5,
    }));
    const taskLifecycle = vi.fn((_input: CuaTaskLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "task.status" as const,
        family: "runtime_unavailable" as const,
        retryable: false,
        component: "runtime" as const,
      },
      exitCode: 4,
    }));
    const securityLifecycle = vi.fn((_input: CuaSecurityLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "security.verify" as const,
        family: "policy_invalid" as const,
        retryable: false,
        component: "policy" as const,
      },
      exitCode: 5,
    }));
    const common = {
      isFrameworkEnabled: frameworkEnabled,
      getAdapterBindings: bindings,
      getSandbox: () => null,
      withSandboxMutationLock: withoutSandboxContention,
      resolveQualificationArtifactRunner,
    };

    await executeCuaTargetCommand(
      {
        operation: "target.health",
        sandboxName: "alpha",
        adapterPath: bindings().target.path,
      },
      { ...common, executeLifecycle: targetLifecycle },
    );
    await executeCuaTaskCommand(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapterPath: bindings().task.path,
      },
      { ...common, executeLifecycle: taskLifecycle },
    );
    await executeCuaSecurityCommand(
      {
        operation: "security.verify",
        sandboxName: "alpha",
        adapterPath: bindings().security.path,
      },
      { ...common, executeLifecycle: securityLifecycle },
    );

    for (const invocation of [targetLifecycle, taskLifecycle, securityLifecycle]) {
      expect(invocation.mock.calls[0]?.[0].adapter).toMatchObject({
        qualificationArtifactRunner: runner,
      });
    }
    expect(resolveQualificationArtifactRunner).toHaveBeenCalledTimes(3);
  });

  it("rejects mismatched, relative, or lexically different adapter paths before lifecycle", async () => {
    const targetLifecycle = vi.fn((_input: CuaTargetLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "target.health" as const,
        family: "validation_failed" as const,
        retryable: false,
      },
      exitCode: 2,
    }));
    const taskLifecycle = vi.fn((_input: CuaTaskLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "task.status" as const,
        family: "validation_failed" as const,
        retryable: false,
      },
      exitCode: 2,
    }));
    const securityLifecycle = vi.fn((_input: CuaSecurityLifecycleInput) => ({
      record: {
        schemaVersion: "1.1.0",
        kind: "failure" as const,
        operation: "security.verify" as const,
        family: "validation_failed" as const,
        retryable: false,
      },
      exitCode: 2,
    }));

    const target = await executeCuaTargetCommand(
      {
        operation: "target.health",
        sandboxName: "alpha",
        adapterPath: "/tmp/target-adapter",
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: bindings,
        executeLifecycle: targetLifecycle,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );
    const task = await executeCuaTaskCommand(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapterPath: "opt/nemocua/task-adapter",
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: bindings,
        executeLifecycle: taskLifecycle,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );
    const security = await executeCuaSecurityCommand(
      {
        operation: "security.verify",
        sandboxName: "alpha",
        adapterPath: "/opt/nemocua/../nemocua/security-adapter",
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: bindings,
        executeLifecycle: securityLifecycle,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );

    for (const result of [target, task, security]) {
      expect(result).toMatchObject({
        exitCode: 2,
        record: { kind: "failure", family: "validation_failed" },
      });
    }
    expect(targetLifecycle).not.toHaveBeenCalled();
    expect(taskLifecycle).not.toHaveBeenCalled();
    expect(securityLifecycle).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime manifest cannot provide adapter authority", async () => {
    const unavailable = () => {
      throw new Error("runtime manifest unavailable");
    };

    const target = await executeCuaTargetCommand(
      {
        operation: "target.health",
        sandboxName: "alpha",
        adapterPath: bindings().target.path,
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: unavailable,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );
    const task = await executeCuaTaskCommand(
      {
        operation: "task.status",
        sandboxName: "alpha",
        taskId: "task-1",
        adapterPath: bindings().task.path,
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: unavailable,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );
    const security = await executeCuaSecurityCommand(
      {
        operation: "security.verify",
        sandboxName: "alpha",
        adapterPath: bindings().security.path,
      },
      {
        isFrameworkEnabled: frameworkEnabled,
        getAdapterBindings: unavailable,
        getSandbox: () => null,
        withSandboxMutationLock: withoutSandboxContention,
      },
    );

    for (const result of [target, task, security]) {
      expect(result).toMatchObject({
        exitCode: 4,
        record: { kind: "failure", family: "runtime_unavailable" },
      });
    }
  });
});
