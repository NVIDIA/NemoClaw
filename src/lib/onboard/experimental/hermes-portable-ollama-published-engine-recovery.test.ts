// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createHermesPortableUninstallFixture } from "../../../../test/helpers/hermes-portable-uninstall-fixture";
import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import type { ContainerEngineCommandResult } from "../../adapters/container-engine";
import type { PodmanBoundContainerEngine, PodmanContainerEngine } from "../../adapters/podman";
import type { SandboxEntry } from "../../state/registry";
import {
  normalizeHostLocalInferenceReceipt,
  normalizeHostLocalOllamaModelRef,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../runtime-provider/host-local-inference";
import type { HostLocalInferenceStartupRequest } from "../runtime-provider/host-local-inference-routing";
import {
  prepareHermesPortablePublishedHostLocalInferenceStartup,
  prepareHostLocalInferenceStartup,
} from "../runtime-provider/host-local-inference-routing";
import {
  prepareSandboxHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceDestroyAuthority,
  prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority,
} from "../runtime-provider/host-local-inference-lifecycle";
import { serializePersistedEngineAuthority } from "../runtime-provider/persisted-engine-authority";
import type { PersistedEngineAuthority } from "../runtime-provider/persisted-engine-authority";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import { requireRuntimeProviderHostLocalInferenceOperation } from "../runtime-provider/registry";
import {
  createPodmanHostLocalInferenceOperation,
  preparePodmanHostLocalInferenceOperationAuthority,
  PODMAN_INFERENCE_SPEC_LABEL,
  type PodmanPublishedResumeTiming,
} from "../runtime-provider/podman-host-local-inference";
import {
  createHermesPortableOllamaRuntimeAuthority,
  HermesPortableOllamaRecoveryError,
  recoverHermesPortableOllamaInference,
} from "./hermes-portable-ollama-inference";
import type { HermesPortableConfiguredReceipt } from "./hermes-portable-receipt";

const LISTENER_IP = "10.90.0.2";
const CURRENT_AUTHORITY_ID = "test:current-session";

function engineFor(
  source: PodmanContainerEngine,
  operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle",
  captures: string[],
  authorityAssertions: string[],
  transformCapture: (
    args: readonly string[],
    result: ContainerEngineCommandResult,
  ) => ContainerEngineCommandResult,
  assertTransactionAuthority: (
    operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle",
    captures: readonly string[],
  ) => void,
): PodmanBoundContainerEngine {
  return Object.freeze({
    ...source,
    operation,
    authorityId: CURRENT_AUTHORITY_ID,
    endpointAuthorityId: CURRENT_AUTHORITY_ID,
    assertAuthority: vi.fn(() => {
      authorityAssertions.push(operation);
      assertTransactionAuthority(operation, captures);
    }),
    capture: (args: readonly string[], timeoutMs?: number) => {
      captures.push(`${operation}:${args.join(" ")}`);
      return transformCapture(args, source.capture(args, timeoutMs));
    },
  });
}

function driftRestartPolicy(
  args: readonly string[],
  result: ContainerEngineCommandResult,
): ContainerEngineCommandResult {
  const inspected =
    args[0] === "container" && args[1] === "inspect" && result.status === 0
      ? (JSON.parse(result.stdout) as readonly Record<string, unknown>[])
      : null;
  const drifted = inspected?.map((value) => {
    const config = value.Config as {
      readonly CreateCommand: readonly string[];
    };
    const hostConfig = value.HostConfig as {
      readonly RestartPolicy: { readonly Name: string };
    };
    const restartValueIndex = config.CreateCommand.indexOf("--restart") + 1;
    expect(restartValueIndex).toBeGreaterThan(0);
    return {
      ...value,
      Config: {
        ...config,
        CreateCommand: config.CreateCommand.map((argument, index) =>
          index === restartValueIndex ? "always" : argument,
        ),
      },
      HostConfig: {
        ...hostConfig,
        RestartPolicy: { ...hostConfig.RestartPolicy, Name: "always" },
      },
    };
  });
  return drifted === null ? result : { ...result, stdout: JSON.stringify(drifted) };
}

function setup(
  options: {
    readonly creationAuthority?: (value: PersistedEngineAuthority) => PersistedEngineAuthority;
    readonly publishedIntent?: string;
    readonly serializedReceipt?: (value: string) => string;
    readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
    readonly transformCapture?: (
      args: readonly string[],
      result: ContainerEngineCommandResult,
    ) => ContainerEngineCommandResult;
    readonly assertTransactionAuthority?: (
      operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle",
      captures: readonly string[],
    ) => void;
  } = {},
) {
  const harness = createPodmanHostLocalInferenceTestHarness({ service: "ollama" });
  const externalNetwork = Object.freeze({
    networkId: harness.input.networkId,
    name: harness.input.networkName,
    subnet: "10.89.0.0/24",
    gatewayIp: harness.input.networkGatewayIp,
    listenerIp: LISTENER_IP,
    authoritySha256: "8".repeat(64),
    assertCurrent: vi.fn(),
  });
  const input = Object.freeze({
    ...harness.input,
    containerPort: 11_434,
    networkListenerIp: LISTENER_IP,
    ollamaContextLength: 64_000,
  });
  harness.state.ollamaPsModels = [
    {
      name: normalizeHostLocalOllamaModelRef(input.model),
      model: normalizeHostLocalOllamaModelRef(input.model),
      size: 8 * 1024 ** 3,
      size_vram: 8 * 1024 ** 3,
      digest: "7".repeat(64),
    },
  ];
  const creationOperation = createPodmanHostLocalInferenceOperation({
    engine: harness.engine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    externalNetwork,
    onFailureEvidence: harness.onFailureEvidence,
    redactSensitive: harness.redactSensitive,
  });
  const creationRuntime = creationOperation.managedRuntime!;
  const created = creationRuntime.startManaged(input, harness.writer);
  created.validateBeforeCommit();
  const receipt = created.commit();
  creationRuntime.stopManaged(receipt);
  const serializedReceipt = serializeHostLocalInferenceReceipt(receipt);
  const publishedSerializedReceipt = options.serializedReceipt
    ? options.serializedReceipt(serializedReceipt)
    : serializedReceipt;
  const creationAuthority = harness.authorityStore.load("host-local-inference")!;
  const publishedCreationAuthority = options.creationAuthority
    ? options.creationAuthority(creationAuthority)
    : creationAuthority;
  const assertForwardAuthority = vi.fn();
  const currentExecutionCaptures: string[] = [];
  const transactionAuthorityAssertions: string[] = [];
  const transformCapture = options.transformCapture ?? ((_args, result) => result);
  const assertTransactionAuthority = options.assertTransactionAuthority ?? (() => undefined);
  const hostDoctorEngine = engineFor(
    harness.engine,
    "host-doctor",
    currentExecutionCaptures,
    transactionAuthorityAssertions,
    transformCapture,
    assertTransactionAuthority,
  );
  const hostLocalInferenceEngine = engineFor(
    harness.engine,
    "host-local-inference",
    currentExecutionCaptures,
    transactionAuthorityAssertions,
    transformCapture,
    assertTransactionAuthority,
  );
  const sandboxLifecycleEngine = engineFor(
    harness.engine,
    "sandbox-lifecycle",
    currentExecutionCaptures,
    transactionAuthorityAssertions,
    transformCapture,
    assertTransactionAuthority,
  );
  const publishedEngineAuthority = {
    intent: (options.publishedIntent ?? "connect-probe-only") as "connect-probe-only",
    creationAuthority: publishedCreationAuthority,
    serializedReceipt: publishedSerializedReceipt,
    assertForwardAuthority,
  } as const;
  const publishedOperationAuthority = preparePodmanHostLocalInferenceOperationAuthority({
    engine: hostLocalInferenceEngine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    redactSensitive: harness.redactSensitive,
  });
  const publishedOperation = publishedOperationAuthority.createOperation({
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    externalNetwork,
    hermesPortablePublishedEngineAuthority: publishedEngineAuthority,
    ...(options.publishedResumeTiming
      ? { publishedResumeTiming: options.publishedResumeTiming }
      : {}),
    onFailureEvidence: harness.onFailureEvidence,
  });
  const bundle = createPodmanRuntimeProviderBundle({
    engines: {
      hostDoctor: hostDoctorEngine,
      hostLocalInference: hostLocalInferenceEngine,
      sandboxLifecycle: sandboxLifecycleEngine,
    },
    hostLocalInference: {
      authorityStore: harness.authorityStore,
      routeAuthorityStore: harness.routeAuthorityStore,
      externalNetwork,
      hermesPortablePublishedEngineAuthority: publishedEngineAuthority,
      hermesPortablePublishedRecoveryOperation: {
        operation: publishedOperation,
        environment: harness.env,
      },
      ...(options.publishedResumeTiming
        ? { publishedResumeTiming: options.publishedResumeTiming }
        : {}),
      onFailureEvidence: harness.onFailureEvidence,
      redactSensitive: harness.redactSensitive,
    },
  });
  const entry = Object.freeze({
    name: "alpha",
    agent: "hermes",
    provider: "ollama-local",
    model: receipt.inference!.model,
    policies: ["personal-open-internet"],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    endpointUrl: "https://inference.local/v1",
    hostLocalInferenceReceipt: serializedReceipt,
  }) as SandboxEntry;
  const providerEntry = Object.freeze({ ...entry, openshellDriver: "podman" }) as SandboxEntry;
  return {
    assertForwardAuthority,
    bundle,
    creationAuthority,
    currentExecutionCaptures,
    entry,
    externalNetwork,
    harness,
    input,
    providerEntry,
    publishedOperation,
    publishedOperationAuthority,
    receipt,
    serializedReceipt,
    transactionAuthorityAssertions,
  };
}

function publishedRequest(fixture: ReturnType<typeof setup>) {
  return {
    application: "hermes" as const,
    service: "ollama" as const,
    managed: Object.freeze({ ...fixture.input, model: fixture.receipt.inference!.model }),
    resumeReceipt: fixture.receipt,
    receiptWriter: fixture.harness.writer,
  };
}

function composedRecovery(fixture: ReturnType<typeof setup>, assertPublished = vi.fn()) {
  const operatingReceipt = {
    phase: "active",
    sandboxName: "alpha",
  } as HermesPortableConfiguredReceipt;
  const assertOperating = vi.fn();
  const assertRuntimeTransaction = vi.fn(() => fixture.externalNetwork.assertCurrent());
  const assertRuntime = vi.fn(() => {
    fixture.externalNetwork.assertCurrent();
    fixture.harness.events.push("test:full-runtime-qualified");
  });
  const registryRecovery = {
    started: true,
    assertTransactionCurrent: vi.fn(),
    assertCurrent: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  const createRuntimeAuthority = vi.fn(
    (options: { readonly assertForwardAuthority: () => void }) => {
      expect(options.assertForwardAuthority).toBeTypeOf("function");
      fixture.assertForwardAuthority.mockImplementation(options.assertForwardAuthority);
      return {
        bundle: fixture.bundle,
        inferenceStateDir: "/state/portable-inference/alpha",
        network: fixture.externalNetwork,
        operation: fixture.publishedOperation,
        assertTransactionCurrent: assertRuntimeTransaction,
        assertCurrent: assertRuntime,
      };
    },
  );
  const input = {
    intent: "connect-probe-only" as const,
    sandboxName: "alpha",
    entry: fixture.entry,
    env: fixture.harness.env,
    stateDir: "/state",
    runGatewayOpenshell: vi.fn(),
    readRegistry: vi.fn(() => fixture.entry),
    assertCallerTransactionCurrent: vi.fn(),
    assertCallerCurrent: vi.fn(),
    verifyRoute: vi.fn(() => fixture.entry),
    prepareProbeDependency: undefined as Parameters<
      typeof recoverHermesPortableOllamaInference
    >[0]["prepareProbeDependency"],
  };
  const overrides = {
    readReceipt: vi.fn(() => ({ receipt: operatingReceipt, successor: {} })),
    qualifyOperatingAuthority: vi.fn(() => ({
      receipt: operatingReceipt,
      assertTransactionCurrent: assertOperating,
      assertCurrent: assertOperating,
    })),
    prepareRecoveryEntry: vi.fn(() => ({
      registryRecovery,
      createRuntimeAuthority,
    })),
    prepareInferenceAuthority: vi.fn(
      prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority,
    ),
    preparePublishedAuthority: vi.fn(() => ({
      receipt: fixture.receipt,
      serializedReceipt: fixture.serializedReceipt,
      receiptWriter: fixture.harness.writer,
      assertTransactionCurrent: assertPublished,
      assertCurrent: assertPublished,
    })),
  };
  return {
    assertOperating,
    assertPublished,
    assertRuntime,
    assertRuntimeTransaction,
    input,
    overrides,
    registryRecovery,
  };
}

function observePublishedFinalization(events: string[]) {
  const finalize = vi.fn();
  const prepareStartup = vi.fn(
    (...args: Parameters<typeof prepareHermesPortablePublishedHostLocalInferenceStartup>) => {
      const route = prepareHermesPortablePublishedHostLocalInferenceStartup(...args);
      const finalizePublishedResume = route.prepared.finalizePublishedResume!;
      return Object.freeze({
        ...route,
        prepared: Object.freeze({
          ...route.prepared,
          finalizePublishedResume(assertPublishedAuthority: () => void) {
            const receipt = finalizePublishedResume(assertPublishedAuthority);
            finalize();
            events.push("test:publication-finalized");
            return receipt;
          },
        }),
      });
    },
  );
  return { finalize, prepareStartup };
}

describe("Hermes Portable published engine recovery", () => {
  it("retains full generated, tool, and model-placement proof during creation (#10423)", () => {
    const fixture = setup();

    expect(fixture.harness.events.some((event) => event.includes("/api/tags"))).toBe(true);
    expect(fixture.harness.events.some((event) => event.includes("/v1/chat/completions"))).toBe(
      true,
    );
    expect(fixture.harness.events.some((event) => event.includes("/api/ps"))).toBe(true);
  });

  it("carries the exact published receipt through the production runtime factory (#10423)", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-published-factory-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixture = await createHermesPortableUninstallFixture(homeDir);
    try {
      const serializedReceipt = fixture.targetRow.hostLocalInferenceReceipt!;
      const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
      const container = fixture.harness.container()!;
      container.running = false;
      container.status = "exited";
      container.exitCode = 0;
      const currentOperatingReceipt = {
        ...fixture.lifecycleReceipt,
        socketAuthority: {
          ...fixture.lifecycleReceipt.socketAuthority,
          inode: "2002",
        },
      } as HermesPortableConfiguredReceipt;
      const assertForwardAuthority = vi.fn();
      const runtimeAuthority = createHermesPortableOllamaRuntimeAuthority({
        receipt: currentOperatingReceipt,
        publishedRecovery: { inferenceReceipt: receipt, assertForwardAuthority },
        stateDir: fixture.stateDir,
        env: fixture.cleanupInput.env,
        podmanAuthorityDeps: fixture.deps.podmanAuthorityDeps,
        captureGpuDevices: fixture.deps.captureGpuDevices,
        captureCdiDevices: fixture.deps.captureCdiDevices,
      });
      const providerEntry = {
        ...fixture.targetRow,
        openshellDriver: "podman",
      } as SandboxEntry;
      const preparedAuthority = prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority(
        runtimeAuthority.bundle,
        providerEntry,
        { environment: fixture.cleanupInput.env },
        undefined,
        requireRuntimeProviderHostLocalInferenceOperation(runtimeAuthority.bundle, "ollama", {
          env: fixture.cleanupInput.env,
          acceleration: "nvidia-gpu",
        }),
      );
      expect(preparedAuthority?.serializedReceipt).toBe(serializedReceipt);
      const operation = requireRuntimeProviderHostLocalInferenceOperation(
        runtimeAuthority.bundle,
        "ollama",
        { env: fixture.cleanupInput.env, acceleration: "nvidia-gpu" },
      );
      expect(operation.engine.authorityId).not.toBe(receipt.engineAuthority.authorityId);
      const publishedRequest = {
        ...(fixture.inferenceRequest as Extract<
          HostLocalInferenceStartupRequest,
          { readonly service: "ollama"; readonly managed: unknown }
        >),
        resumeReceipt: receipt,
      };
      const recoveryEventStart = fixture.harness.events.length;
      const route = prepareHermesPortablePublishedHostLocalInferenceStartup(
        operation,
        publishedRequest,
      );
      expect(route.prepared.rollbackPriorState).toBe("stopped");
      expect(route.prepared.validateBeforeCommit()).toEqual(receipt);
      expect(route.prepared.finalizePublishedResume?.(runtimeAuthority.assertCurrent)).toEqual(
        receipt,
      );
      const recoveryEvents = fixture.harness.events.slice(recoveryEventStart);
      expect(recoveryEvents.filter((event) => event.includes("/api/tags"))).toHaveLength(0);
      expect(
        recoveryEvents.filter(
          (event) => event.includes("podman:exec ") && event.includes(" nvidia-smi "),
        ),
      ).toHaveLength(1);
      expect(recoveryEvents.some((event) => event.includes("/v1/chat/completions"))).toBe(false);
      expect(recoveryEvents.some((event) => event.includes("/api/ps"))).toBe(false);
      expect(fixture.harness.container()).toMatchObject({ running: true, status: "running" });
      expect(assertForwardAuthority).toHaveBeenCalled();
      const timingLines = log.mock.calls
        .map(([line]) => line)
        .filter(
          (line) =>
            typeof line === "string" && line.startsWith("  Hermes Portable Ollama resume timing:"),
        );
      expect(timingLines).toHaveLength(1);
      expect(timingLines[0]).toMatch(
        /^  Hermes Portable Ollama resume timing: start=\d+ms managedReady=0ms gpuIdentity=\d+ms generatedProof=0ms modelPlacement=0ms cleanupCurrentness=\d+ms total=\d+ms runtimeAction=started result=proved$/u,
      );
      expect(timingLines[0]).not.toContain(receipt.inference?.model);
      expect(timingLines[0]).not.toContain(
        receipt.runtime.kind === "container" ? receipt.runtime.name : "unexpected-host-runtime",
      );
    } finally {
      log.mockRestore();
      fixture.restore();
      fs.rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("finalizes the immutable generation through the requalified execution endpoint (#10423)", () => {
    const fixture = setup();
    const operation = requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
      env: fixture.harness.env,
      acceleration: "nvidia-gpu",
    });
    expect(operation.engine.authorityId).toBe(CURRENT_AUTHORITY_ID);
    expect(operation.engine.authorityId).not.toBe(fixture.receipt.engineAuthority.authorityId);
    expect(operation.bindingSha256).not.toBe(fixture.receipt.engineAuthority.bindingSha256);

    const prepared = prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority(
      fixture.bundle,
      fixture.providerEntry,
      { environment: fixture.harness.env },
      undefined,
      fixture.publishedOperation,
    );
    expect(prepared?.serializedReceipt).toBe(fixture.serializedReceipt);
    expect(Object.isFrozen(prepared?.managedInspection)).toBe(true);
    expect(Object.isFrozen(prepared?.managedInspection?.receipt)).toBe(true);
    const creationContainer = fixture.harness.container()!;
    const immutableContainer = JSON.stringify({
      id: creationContainer.id,
      name: creationContainer.name,
      imageRef: creationContainer.imageRef,
      labels: creationContainer.labels,
      createArguments: creationContainer.createArguments,
    });

    const route = prepareHermesPortablePublishedHostLocalInferenceStartup(
      operation,
      publishedRequest(fixture),
    );
    expect(route.prepared.rollbackPriorState).toBe("stopped");
    expect(route.prepared.validateBeforeCommit()).toEqual(fixture.receipt);
    expect(route.prepared.finalizePublishedResume?.(() => undefined)).toEqual(fixture.receipt);
    expect(route.prepared.publicationState()).toBe("published");
    const finalizedContainer = fixture.harness.container()!;
    expect(finalizedContainer).toMatchObject({ running: true, status: "running" });
    expect(
      JSON.stringify({
        id: finalizedContainer.id,
        name: finalizedContainer.name,
        imageRef: finalizedContainer.imageRef,
        labels: finalizedContainer.labels,
        createArguments: finalizedContainer.createArguments,
      }),
    ).toBe(immutableContainer);
    expect(
      serializePersistedEngineAuthority(
        fixture.harness.authorityStore.load("host-local-inference")!,
      ),
    ).toBe(serializePersistedEngineAuthority(fixture.creationAuthority));
    expect(fixture.harness.written).toEqual([fixture.serializedReceipt]);
    expect(fixture.assertForwardAuthority).toHaveBeenCalled();
    expect(fixture.externalNetwork.assertCurrent).toHaveBeenCalled();
    expect(fixture.currentExecutionCaptures).toContain(
      `host-local-inference:start ${finalizedContainer.id}`,
    );
    expect(
      fixture.currentExecutionCaptures.every((event) => event.startsWith("host-local-inference:")),
    ).toBe(true);
  });

  it("restores the immutable stopped generation when publication is withheld (#10423)", () => {
    const fixture = setup();
    const operation = requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
      env: fixture.harness.env,
      acceleration: "nvidia-gpu",
    });
    const route = prepareHermesPortablePublishedHostLocalInferenceStartup(
      operation,
      publishedRequest(fixture),
    );

    expect(route.prepared.rollback()).toMatchObject({ priorState: "stopped", status: "restored" });
    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(fixture.harness.written).toEqual([fixture.serializedReceipt]);
  });

  it("composes the probe-only owner through private publication and final route proof (#10423)", () => {
    const fixture = setup();
    const beforeEntry = JSON.stringify(fixture.entry);
    const beforeContainer = fixture.harness.container()!;
    const immutableContainer = JSON.stringify({
      id: beforeContainer.id,
      labels: beforeContainer.labels,
      createArguments: beforeContainer.createArguments,
    });
    const composed = composedRecovery(fixture);
    const observed = observePublishedFinalization(fixture.harness.events);
    Object.assign(composed.overrides, { prepareStartup: observed.prepareStartup });
    const recoveryEventStart = fixture.harness.events.length;
    composed.input.verifyRoute.mockImplementation(() => {
      fixture.harness.events.push("test:route-verified");
      return fixture.entry;
    });
    const dependency = {
      release: vi.fn(() => fixture.harness.events.push("test:dependency-released")),
      rollback: vi.fn(() => fixture.harness.events.push("test:dependency-rolled-back")),
    };
    composed.input.prepareProbeDependency = vi.fn(() => {
      fixture.harness.events.push("test:dependency-prepared");
      return dependency;
    });
    composed.registryRecovery.release.mockImplementation(() => {
      fixture.harness.events.push("test:registry-released");
    });

    expect(recoverHermesPortableOllamaInference(composed.input, composed.overrides as never)).toBe(
      "recovered",
    );
    const afterContainer = fixture.harness.container()!;
    expect(afterContainer).toMatchObject({ running: true, status: "running" });
    expect(
      JSON.stringify({
        id: afterContainer.id,
        labels: afterContainer.labels,
        createArguments: afterContainer.createArguments,
      }),
    ).toBe(immutableContainer);
    expect(JSON.stringify(fixture.entry)).toBe(beforeEntry);
    expect(fixture.harness.written).toEqual([fixture.serializedReceipt]);
    expect(composed.input.verifyRoute).toHaveBeenCalledOnce();
    expect(composed.input.assertCallerCurrent).toHaveBeenCalled();
    expect(composed.registryRecovery.release).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.rollback).not.toHaveBeenCalled();
    expect(composed.assertPublished).toHaveBeenCalled();
    expect(observed.finalize).toHaveBeenCalledOnce();
    expect(dependency.release).toHaveBeenCalledOnce();
    expect(dependency.rollback).not.toHaveBeenCalled();
    expect(composed.assertRuntime).toHaveBeenCalledOnce();
    const recoveryOrder = fixture.harness.events.slice(recoveryEventStart);
    const gpuIndex = recoveryOrder.findIndex(
      (event) => event.includes("podman:exec ") && event.includes(" nvidia-smi "),
    );
    const routeIndex = recoveryOrder.indexOf("test:route-verified");
    const dependencyIndex = recoveryOrder.indexOf("test:dependency-prepared");
    const fullyQualifiedIndex = recoveryOrder.indexOf("test:full-runtime-qualified");
    const finalizedIndex = recoveryOrder.indexOf("test:publication-finalized");
    const releasedIndex = recoveryOrder.indexOf("test:registry-released");
    const dependencyReleasedIndex = recoveryOrder.indexOf("test:dependency-released");
    expect(recoveryOrder.some((event) => event.includes("/api/tags"))).toBe(false);
    expect(gpuIndex).toBeGreaterThanOrEqual(0);
    expect(routeIndex).toBeGreaterThan(gpuIndex);
    expect(dependencyIndex).toBeGreaterThan(routeIndex);
    expect(fullyQualifiedIndex).toBeGreaterThan(dependencyIndex);
    expect(finalizedIndex).toBeGreaterThan(fullyQualifiedIndex);
    expect(releasedIndex).toBeGreaterThan(finalizedIndex);
    expect(dependencyReleasedIndex).toBeGreaterThan(releasedIndex);
  });

  it("reuses a running published runtime with one GPU proof before route health (#10423)", () => {
    const onComplete = vi.fn();
    const fixture = setup({ publishedResumeTiming: { onComplete } });
    fixture.harness.container()!.running = true;
    fixture.harness.container()!.status = "running";
    const runningContainer = fixture.harness.container()!;
    const immutableRuntime = JSON.stringify({
      id: runningContainer.id,
      name: runningContainer.name,
      imageRef: runningContainer.imageRef,
      labels: runningContainer.labels,
      createArguments: runningContainer.createArguments,
    });
    const composed = composedRecovery(fixture);
    const recoveryEventStart = fixture.harness.events.length;
    const captureStart = fixture.currentExecutionCaptures.length;
    fixture.transactionAuthorityAssertions.splice(0);

    expect(recoverHermesPortableOllamaInference(composed.input, composed.overrides as never)).toBe(
      "reused",
    );

    const recoveryEvents = fixture.harness.events.slice(recoveryEventStart);
    expect(recoveryEvents.filter((event) => event.includes("/api/tags"))).toHaveLength(0);
    expect(
      recoveryEvents.filter(
        (event) => event.includes("podman:exec ") && event.includes(" nvidia-smi "),
      ),
    ).toHaveLength(1);
    expect(recoveryEvents.some((event) => event.includes("/v1/chat/completions"))).toBe(false);
    expect(recoveryEvents.some((event) => event.includes("/api/ps"))).toBe(false);
    const reconciledContainer = fixture.harness.container()!;
    expect(
      JSON.stringify({
        id: reconciledContainer.id,
        name: reconciledContainer.name,
        imageRef: reconciledContainer.imageRef,
        labels: reconciledContainer.labels,
        createArguments: reconciledContainer.createArguments,
      }),
    ).toBe(immutableRuntime);
    expect(
      fixture.currentExecutionCaptures
        .slice(captureStart)
        .filter(
          (event) =>
            event === `host-local-inference:start ${runningContainer.id}` ||
            (event.startsWith("host-local-inference:stop ") &&
              event.endsWith(` ${runningContainer.id}`)) ||
            (event.startsWith("host-local-inference:rm ") &&
              event.endsWith(` ${runningContainer.id}`)) ||
            (event.startsWith("host-local-inference:run ") &&
              event.includes(` --name ${runningContainer.name} `)),
        ),
    ).toEqual([]);
    expect(composed.input.verifyRoute).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.release).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.rollback).not.toHaveBeenCalled();
    expect(composed.overrides.prepareInferenceAuthority).toHaveBeenCalledOnce();
    expect(fixture.transactionAuthorityAssertions).toHaveLength(14);
    expect(
      fixture.currentExecutionCaptures
        .slice(captureStart)
        .filter((event) => event.includes("version") || event.includes("info")),
    ).toEqual([]);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        generatedProofMs: 0,
        managedReadyMs: 0,
        modelPlacementMs: 0,
        runtimeAction: "reused",
        startMs: 0,
      }),
    );
  });

  it("qualifies one retained published operation at entry and once at completion (#10423)", () => {
    const fixture = setup();
    const qualificationCommands = () =>
      fixture.currentExecutionCaptures.filter(
        (event) => event.includes("version") || event.includes("info"),
      );

    expect(qualificationCommands()).toEqual([
      "host-local-inference:version --format json",
      "host-local-inference:info --format json",
    ]);
    expect(
      requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
        env: fixture.harness.env,
        acceleration: "nvidia-gpu",
      }),
    ).toBe(fixture.publishedOperation);
    expect(
      requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
        env: fixture.harness.env,
        acceleration: "nvidia-gpu",
      }),
    ).toBe(fixture.publishedOperation);
    expect(qualificationCommands()).toEqual([
      "host-local-inference:version --format json",
      "host-local-inference:info --format json",
    ]);
    expect(() => fixture.publishedOperationAuthority.createOperation({} as never)).toThrow(
      "operation authority was already consumed",
    );
    fixture.publishedOperationAuthority.assertCurrent();
    expect(qualificationCommands()).toEqual([
      "host-local-inference:version --format json",
      "host-local-inference:info --format json",
      "host-local-inference:version --format json",
      "host-local-inference:info --format json",
    ]);
  });

  it("settles exact published-runtime authority after a failed GPU command (#10423)", () => {
    let gpuAttempted = false;
    let postGpuInspection = false;
    const fixture = setup({
      transformCapture(args, result) {
        postGpuInspection ||= gpuAttempted && args[0] === "container" && args[1] === "inspect";
        const gpuCommand = args[0] === "exec" && args[2] === "nvidia-smi";
        gpuAttempted ||= gpuCommand;
        return gpuCommand
          ? { ...result, status: 1, stdout: "", stderr: "gpu proof failed" }
          : result;
      },
    });
    fixture.harness.container()!.running = true;
    fixture.harness.container()!.status = "running";

    expect(() =>
      fixture.publishedOperation.managedRuntime?.validatePublishedResume?.(fixture.receipt),
    ).toThrow("managed GPU proof failed");
    expect(gpuAttempted).toBe(true);
    expect(postGpuInspection).toBe(true);
  });

  it("reports post-GPU runtime drift instead of masking it with the GPU failure (#10423)", () => {
    let gpuAttempted = false;
    let postGpuInspection = false;
    const fixture = setup({
      transformCapture(args, result) {
        postGpuInspection ||= gpuAttempted && args[0] === "container" && args[1] === "inspect";
        const gpuCommand = args[0] === "exec" && args[2] === "nvidia-smi";
        gpuAttempted ||= gpuCommand;
        return gpuCommand
          ? (() => {
              fixture.harness.container()!.labels[PODMAN_INFERENCE_SPEC_LABEL] = "0".repeat(64);
              return { ...result, status: 1, stdout: "", stderr: "gpu proof failed" };
            })()
          : result;
      },
    });
    fixture.harness.container()!.running = true;
    fixture.harness.container()!.status = "running";

    let failure: unknown;
    try {
      fixture.publishedOperation.managedRuntime?.validatePublishedResume?.(fixture.receipt);
    } catch (error) {
      failure = error;
    }
    expect(gpuAttempted).toBe(true);
    expect(postGpuInspection).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("managed GPU proof failed");
  });

  it("uses two full runtime inspections and no behavioral qualification around GPU proof (#10423)", () => {
    const fixture = setup();
    fixture.harness.container()!.running = true;
    fixture.harness.container()!.status = "running";
    const captureStart = fixture.currentExecutionCaptures.length;
    fixture.transactionAuthorityAssertions.splice(0);

    expect(
      fixture.publishedOperation.managedRuntime?.validatePublishedResume?.(fixture.receipt),
    ).toEqual(fixture.receipt);

    const captures = fixture.currentExecutionCaptures.slice(captureStart);
    expect(
      captures.filter((event) => event.startsWith("host-local-inference:network inspect ")),
    ).toHaveLength(2);
    expect(
      captures.filter((event) => event.startsWith("host-local-inference:container inspect ")),
    ).toHaveLength(2);
    expect(
      captures.filter((event) => event.includes("exec") && event.includes("nvidia-smi")),
    ).toHaveLength(1);
    expect(captures.filter((event) => event.includes("version") || event.includes("info"))).toEqual(
      [],
    );
    expect(fixture.transactionAuthorityAssertions).toHaveLength(6);
  });

  it.each([
    "lifecycle-receipt",
    "private-publication",
    "command-endpoint",
    "network",
    "container",
    "registry",
  ] as const)("rejects %s drift immediately after the exact GPU command (#10423)", (driftKind) => {
    let armed = false;
    let gpuCommandCompleted = false;
    let commandEndpointDrifted = false;
    let fixture: ReturnType<typeof setup>;
    let composed: ReturnType<typeof composedRecovery>;
    fixture = setup({
      assertTransactionAuthority(operation) {
        expect(
          armed && commandEndpointDrifted && operation === "host-local-inference",
          "current executable or socket authority changed",
        ).toBe(false);
      },
      transformCapture(args, result) {
        const firstGpuCommand =
          armed && args[0] === "exec" && args[2] === "nvidia-smi" && !gpuCommandCompleted;
        const drift = {
          "lifecycle-receipt": () =>
            composed.input.assertCallerTransactionCurrent.mockImplementation(() => {
              throw new Error("active receipt file identity changed");
            }),
          "private-publication": () =>
            composed.assertPublished.mockImplementation(() => {
              throw new Error("private publication receipt changed");
            }),
          "command-endpoint": () => {
            commandEndpointDrifted = true;
          },
          network: () => {
            fixture.harness.state.networkName = "drifted-network";
          },
          container: () => {
            fixture.harness.container()!.labels[PODMAN_INFERENCE_SPEC_LABEL] = "0".repeat(64);
          },
          registry: () =>
            composed.input.readRegistry.mockReturnValue({
              ...fixture.entry,
              model: "registry-model-drift",
            }),
        }[driftKind];
        (firstGpuCommand
          ? () => {
              gpuCommandCompleted = true;
              drift();
            }
          : () => undefined)();
        return result;
      },
    });
    fixture.harness.container()!.running = true;
    fixture.harness.container()!.status = "running";
    composed = composedRecovery(fixture);
    armed = true;

    expect(() =>
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never),
    ).toThrow();

    expect(gpuCommandCompleted).toBe(true);
    expect(composed.input.verifyRoute).not.toHaveBeenCalled();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
    expect(composed.registryRecovery.rollback).toHaveBeenCalledOnce();
    expect(fixture.harness.container()).toMatchObject({ running: true, status: "running" });
  });

  it("rolls both stopped resources back when private publication drifts after start (#10423)", () => {
    const fixture = setup();
    const assertPublished = vi.fn(() => {
      expect(
        fixture.harness.container()?.running ? "private publication changed" : null,
      ).toBeNull();
    });
    const composed = composedRecovery(fixture, assertPublished);

    let failure: unknown;
    try {
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect((failure as HermesPortableOllamaRecoveryError).failure).toBe("authority-drift");
    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(composed.registryRecovery.rollback).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
    expect(composed.input.verifyRoute).not.toHaveBeenCalled();
  });

  it("restores both stopped resources when the sandbox registry drifts after start (#10423)", () => {
    const fixture = setup();
    const composed = composedRecovery(fixture);
    composed.input.readRegistry.mockImplementation(() =>
      fixture.harness.container()?.running
        ? { ...fixture.entry, lifecycleGeneration: "generation-2" }
        : fixture.entry,
    );

    let failure: unknown;
    try {
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect((failure as HermesPortableOllamaRecoveryError).failure).toBe("authority-drift");
    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(composed.registryRecovery.rollback).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
  });

  it("restores both stopped resources when final managed route health fails (#10423)", () => {
    const fixture = setup();
    const composed = composedRecovery(fixture);
    composed.input.verifyRoute.mockImplementation(() => {
      throw new Error("managed route unavailable");
    });
    const observed = observePublishedFinalization([]);
    Object.assign(composed.overrides, { prepareStartup: observed.prepareStartup });
    composed.input.prepareProbeDependency = vi.fn(() => ({
      release: vi.fn(),
      rollback: vi.fn(),
    }));

    expect(() =>
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never),
    ).toThrow();

    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(composed.input.verifyRoute).toHaveBeenCalledOnce();
    expect(composed.input.prepareProbeDependency).not.toHaveBeenCalled();
    expect(observed.finalize).not.toHaveBeenCalled();
    expect(composed.registryRecovery.rollback).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
  });

  it("restores both stopped resources when exact GPU identity changes (#10423)", () => {
    const fixture = setup();
    fixture.harness.state.gpuIdentities = ["GPU-00000000-0000-0000-0000-000000000000"];
    const composed = composedRecovery(fixture);
    const observed = observePublishedFinalization([]);
    Object.assign(composed.overrides, { prepareStartup: observed.prepareStartup });
    composed.input.prepareProbeDependency = vi.fn(() => ({
      release: vi.fn(),
      rollback: vi.fn(),
    }));

    expect(() =>
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never),
    ).toThrow("requested CDI UUID authority");

    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(composed.input.verifyRoute).not.toHaveBeenCalled();
    expect(composed.input.prepareProbeDependency).not.toHaveBeenCalled();
    expect(observed.finalize).not.toHaveBeenCalled();
    expect(composed.registryRecovery.rollback).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
  });

  it("restores stopped state when published authority drifts during precommit validation (#10423)", () => {
    let recoveryStarted = false;
    let validationReached = false;
    const fixture = setup({
      transformCapture: (args, result) => {
        validationReached ||=
          recoveryStarted &&
          args[0] === "exec" &&
          args.some((argument) => argument === "nvidia-smi");
        return result;
      },
    });
    const assertPublished = vi.fn(() => {
      expect(validationReached ? "published authority changed during validation" : null).toBeNull();
    });
    const composed = composedRecovery(fixture, assertPublished);
    recoveryStarted = true;

    expect(() =>
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never),
    ).toThrow();

    expect(validationReached).toBe(true);
    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(composed.input.verifyRoute).not.toHaveBeenCalled();
    expect(composed.registryRecovery.rollback).toHaveBeenCalledOnce();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
  });

  it("reports unproved restoration when the current network drifts after start (#10423)", () => {
    const fixture = setup();
    const composed = composedRecovery(fixture);
    fixture.externalNetwork.assertCurrent.mockImplementation(() => {
      expect(
        fixture.harness.container()?.running ? "current network authority changed" : null,
      ).toBeNull();
    });

    let failure: unknown;
    try {
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect((failure as HermesPortableOllamaRecoveryError).failure).toBe(
      "runtime-restoration-unproved",
    );
    expect(composed.registryRecovery.rollback).not.toHaveBeenCalled();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
  });

  it("does not roll back the registry from an indeterminate stopped-looking runtime (#10423)", () => {
    const fixture = setup();
    fixture.harness.container()!.status = "unknown";
    const composed = composedRecovery(fixture);

    let failure: unknown;
    try {
      recoverHermesPortableOllamaInference(composed.input, composed.overrides as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect((failure as HermesPortableOllamaRecoveryError).failure).toBe(
      "runtime-restoration-unproved",
    );
    expect(composed.registryRecovery.rollback).not.toHaveBeenCalled();
    expect(composed.registryRecovery.release).not.toHaveBeenCalled();
  });

  it("keeps ordinary startup and lifecycle consumers on one engine generation (#10423)", () => {
    const fixture = setup();
    const operation = requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
      env: fixture.harness.env,
      acceleration: "nvidia-gpu",
    });
    const request = publishedRequest(fixture);

    expect(() =>
      prepareSandboxHostLocalInferenceDestroyAuthority(fixture.bundle, fixture.providerEntry, {
        environment: fixture.harness.env,
      }),
    ).toThrow("receipt differs from the operation-scoped provider engine authority");
    expect(() =>
      prepareSandboxHostLocalInferenceAuthority(fixture.bundle, fixture.providerEntry, {
        environment: fixture.harness.env,
      }),
    ).toThrow("receipt differs from the operation-scoped provider engine authority");
    expect(() => prepareHostLocalInferenceStartup(operation, request)).toThrow(
      "different runtime, proof, or publication authority",
    );
    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
  });

  it("rejects another receipt that shares the immutable engine authority (#10423)", () => {
    const fixture = setup();
    const operation = requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
      env: fixture.harness.env,
      acceleration: "nvidia-gpu",
    });
    const foreignReceipt = normalizeHostLocalInferenceReceipt({
      ...fixture.receipt,
      inference: { ...fixture.receipt.inference!, model: "foreign:latest" },
    });
    const captureCount = fixture.currentExecutionCaptures.length;

    expect(() => operation.managedRuntime!.inspectManaged(foreignReceipt)).toThrow(
      "differs from its exact recovery receipt",
    );
    expect(fixture.currentExecutionCaptures).toHaveLength(captureCount);
    const { modelDigest: _modelDigest, ...vllmRuntime } = fixture.receipt.runtime as Extract<
      typeof fixture.receipt.runtime,
      { readonly kind: "container" }
    >;
    const nonOllamaReceipt = normalizeHostLocalInferenceReceipt({
      ...fixture.receipt,
      service: "vllm",
      runtime: vllmRuntime,
    });
    expect(() => operation.managedRuntime!.inspectManaged(nonOllamaReceipt)).toThrow(
      "differs from its exact recovery receipt",
    );
    expect(fixture.currentExecutionCaptures).toHaveLength(captureCount);
  });

  it("rejects immutable label and launch drift before resume mutation (#10423)", () => {
    const labelFixture = setup();
    const labelOperation = requireRuntimeProviderHostLocalInferenceOperation(
      labelFixture.bundle,
      "ollama",
      { env: labelFixture.harness.env, acceleration: "nvidia-gpu" },
    );
    labelFixture.harness.container()!.labels[PODMAN_INFERENCE_SPEC_LABEL] = "0".repeat(64);
    expect(() =>
      prepareHermesPortablePublishedHostLocalInferenceStartup(
        labelOperation,
        publishedRequest(labelFixture),
      ),
    ).toThrow();
    expect(labelFixture.currentExecutionCaptures.some((event) => event.includes(":start "))).toBe(
      false,
    );

    let driftLaunch = false;
    const launchFixture = setup({
      transformCapture: (args, result) => (driftLaunch ? driftRestartPolicy(args, result) : result),
    });
    const launchOperation = requireRuntimeProviderHostLocalInferenceOperation(
      launchFixture.bundle,
      "ollama",
      { env: launchFixture.harness.env, acceleration: "nvidia-gpu" },
    );
    driftLaunch = true;
    expect(() =>
      prepareHermesPortablePublishedHostLocalInferenceStartup(
        launchOperation,
        publishedRequest(launchFixture),
      ),
    ).toThrow();
    expect(launchFixture.currentExecutionCaptures.some((event) => event.includes(":start "))).toBe(
      false,
    );
  });

  it("rejects noncanonical receipt bytes and a mismatched persisted authority (#10423)", () => {
    expect(() => setup({ serializedReceipt: (value) => value.trimEnd() })).toThrow(
      "serialized receipt is not canonical",
    );

    const mismatched = setup({
      creationAuthority: (value) => ({ ...value, bindingSha256: "9".repeat(64) }),
    });
    expect(() =>
      prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority(
        mismatched.bundle,
        mismatched.providerEntry,
        { environment: mismatched.harness.env },
        undefined,
        mismatched.publishedOperation,
      ),
    ).toThrow("differs from its persisted engine authority");
    expect(mismatched.harness.container()).toMatchObject({ running: false });
  });

  it("rejects a published operation outside connect probe-only intent (#10423)", () => {
    expect(() => setup({ publishedIntent: "interactive-launch" })).toThrow(
      "invalid creation engine authority",
    );
  });

  it("denies unrelated provider mutation surfaces in published recovery mode (#10423)", () => {
    const fixture = setup();
    const operation = requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
      env: fixture.harness.env,
      acceleration: "nvidia-gpu",
    });
    const runtime = operation.managedRuntime!;

    expect(runtime.services).toEqual(["ollama"]);
    expect(() => runtime.translateContainerArgs(["run"])).toThrow(
      "cannot translate new runtime input",
    );
    expect(() => runtime.startManaged(fixture.input, fixture.harness.writer)).toThrow(
      "cannot start a new managed runtime",
    );
    expect(() => runtime.recoverManaged?.(fixture.input, fixture.harness.writer)).toThrow(
      "cannot recover an unpublished runtime",
    );
    expect(() => runtime.stopManaged(fixture.receipt)).toThrow(
      "cannot stop through a public lifecycle",
    );
    expect(() => runtime.destroy(fixture.receipt)).toThrow("cannot destroy a published runtime");
    expect(fixture.harness.container()).toMatchObject({ running: false, status: "exited" });
  });

  it("restores stopped state when forward product authority drifts (#10423)", () => {
    const before = setup();
    const beforeOperation = requireRuntimeProviderHostLocalInferenceOperation(
      before.bundle,
      "ollama",
      { env: before.harness.env, acceleration: "nvidia-gpu" },
    );
    before.assertForwardAuthority.mockImplementation(() => {
      throw new Error("current execution authority changed");
    });
    expect(() =>
      prepareHermesPortablePublishedHostLocalInferenceStartup(
        beforeOperation,
        publishedRequest(before),
      ),
    ).toThrow("Published inference forward authority changed");
    expect(before.currentExecutionCaptures.some((event) => event.includes(":start "))).toBe(false);

    const after = setup();
    const afterOperation = requireRuntimeProviderHostLocalInferenceOperation(
      after.bundle,
      "ollama",
      { env: after.harness.env, acceleration: "nvidia-gpu" },
    );
    const route = prepareHermesPortablePublishedHostLocalInferenceStartup(
      afterOperation,
      publishedRequest(after),
    );
    after.assertForwardAuthority.mockImplementation(() => {
      throw new Error("current execution authority changed");
    });
    expect(() => route.prepared.validateBeforeCommit()).toThrow(
      "Published inference forward authority changed",
    );
    expect(route.prepared.rollback()).toMatchObject({ priorState: "stopped", status: "restored" });
    expect(after.harness.container()).toMatchObject({ running: false, status: "exited" });
  });

  it("leaves restoration unproved when current engine-network authority drifts (#10423)", () => {
    const fixture = setup();
    const operation = requireRuntimeProviderHostLocalInferenceOperation(fixture.bundle, "ollama", {
      env: fixture.harness.env,
      acceleration: "nvidia-gpu",
    });
    const route = prepareHermesPortablePublishedHostLocalInferenceStartup(
      operation,
      publishedRequest(fixture),
    );
    fixture.externalNetwork.assertCurrent.mockImplementation(() => {
      throw new Error("current network authority changed");
    });

    expect(() => route.prepared.validateBeforeCommit()).toThrow(
      "current network authority changed",
    );
    expect(() => route.prepared.rollback()).toThrow("current network authority changed");
    expect(route.prepared.publicationState()).toBe("indeterminate");
  });
});
