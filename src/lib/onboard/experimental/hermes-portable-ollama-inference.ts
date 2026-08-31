// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { capturePodmanSocketAuthority, type PodmanSocketAuthority } from "../../adapters/podman";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { SandboxEntry } from "../../state/registry";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import {
  hostLocalInferenceRollbackStatus,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
  type HostLocalInferencePreparedStartup,
  type HostLocalInferenceOperation,
  type HostLocalInferenceProofEndpointAuthority,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceReceiptWriter,
  type HostLocalInferenceRouteAuthorityStore,
} from "../runtime-provider/host-local-inference";
import {
  assertHermesPortableHostLocalInferencePublishedRecoveryAuthorityCurrent,
  prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority,
  type HostLocalInferenceLifecycleSandbox,
} from "../runtime-provider/host-local-inference-lifecycle";
import type {
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
  HostLocalInferenceStartupSelectionResolver,
  HostLocalInferenceStartupRequest,
} from "../runtime-provider/host-local-inference-routing";
import { prepareHermesPortablePublishedHostLocalInferenceStartup } from "../runtime-provider/host-local-inference-routing";
import {
  createFilePersistedEngineAuthorityStore,
  openFilePersistedEngineAuthorityStore,
  serializePersistedEngineAuthority,
} from "../runtime-provider/persisted-engine-authority";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import {
  inspectPodmanPublishedOllamaReadinessRuntime,
  preparePodmanHostLocalInferenceOperationAuthority,
  PublishedInferenceForwardAuthorityError,
  type PodmanPublishedResumeTiming,
  type PodmanPublishedResumeTimingEvidence,
} from "../runtime-provider/podman-host-local-inference";
import {
  qualifyPodmanInferenceAuthority,
  revalidatePodmanInferenceAuthority,
} from "../runtime-provider/podman-preflight";
import {
  redactOnboardCommandDiagnosticText,
  redactOnboardDiagnosticText,
} from "../session-bootstrap";
import { PORTABLE_DOCKER_NETWORK_NAME, isPortableExperimentalProfile } from "./portable-profile";
import {
  captureHermesPortablePodmanExecutableAuthority,
  createHermesPortablePodmanInferenceInspectionAuthority,
  createHermesPortablePodmanOperationEngines,
  HERMES_PORTABLE_PODMAN_VERSION,
  type HermesPortablePodmanAuthorityDeps,
} from "./hermes-portable-podman-authority";
import { buildHermesPortablePodmanEnvironment } from "./hermes-portable-container";
import {
  captureCurrentCdiDevices,
  captureCurrentGpuDevices,
  capturePortableNetworkAuthority,
  captureQualifiedGpuDevices,
  preparePortableRegistryRecovery,
  PortableRegistryRecoveryPhaseError,
  PortableRegistryRecoveryRestorationError,
  PORTABLE_OLLAMA_IMAGE,
  PORTABLE_PROBE_IMAGE,
  type PortableRegistryRecoveryPhase,
  type PreparedPortableRegistryRecovery,
  withRetainedImageAcquisition,
} from "./hermes-portable-ollama-authority";
import {
  createHermesPortableOllamaGatewayTransaction,
  hasHermesPortableOllamaRecoveryContainer,
  prepareHermesPortableOllamaPublishedInferenceAuthority,
  prepareHermesPortableOllamaPublishedReceiptAuthority,
  type HermesPortableOllamaGatewayRunner,
} from "./hermes-portable-ollama-gateway-transaction";
import { qualifyHermesPortableOperatingAuthority } from "./hermes-portable-operating-authority";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";
import {
  readHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
} from "./hermes-portable-receipt";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MODEL_MAX_LENGTH = 512;
const SAFE_MODEL_ID = /^[A-Za-z0-9._:/-]+$/u;
const SAFE_CREDENTIAL_ENV = /^[A-Z_][A-Z0-9_]*$/u;

export interface HermesPortableOllamaInferenceResolverOptions {
  readonly runtimeContext: PortableOnboardRuntimeContext | null;
  readonly credentialEnv: string;
  readonly getReservationSessionId: () => string | null | undefined;
  readonly runGatewayOpenshell: HermesPortableOllamaGatewayRunner;
  readonly stateDir?: string;
  readonly podmanAuthorityDeps?: HermesPortablePodmanAuthorityDeps;
  readonly captureSocketAuthority?: (socketPath: string, uid: number) => PodmanSocketAuthority;
  readonly captureGpuDevices?: () => readonly string[];
  readonly captureCdiDevices?: () => readonly string[];
}

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hermesPortableInferenceStateDir(stateDir: string, sandboxName: string): string {
  return path.join(stateDir, "portable-inference", digest({ sandboxName }));
}

function requireSessionId(value: string | null | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error("Hermes Portable inference requires the current reservation session.");
  }
  return value;
}

function requirePortableOllamaModel(model: string): string {
  if (
    model.length === 0 ||
    model.length > MODEL_MAX_LENGTH ||
    model !== model.trim() ||
    !SAFE_MODEL_ID.test(model)
  ) {
    throw new Error("Hermes Portable Ollama has an invalid selected model authority.");
  }
  return model;
}

function createUnusedRouteAuthorityStore(): HostLocalInferenceRouteAuthorityStore {
  return Object.freeze({
    load: () => null,
    record: () => {
      throw new Error("Managed Hermes Portable Ollama cannot publish host-process authority.");
    },
  });
}

export interface HermesPortableOllamaRuntimeAuthority {
  readonly bundle: RuntimeProviderBundle;
  readonly inferenceStateDir: string;
  readonly network: ReturnType<typeof capturePortableNetworkAuthority>;
  readonly assertTransactionCurrent: () => void;
  readonly assertCurrent: () => void;
}

export interface HermesPortableOllamaRecoveryTimingEvidence {
  readonly entryAuthorityMs: number;
  readonly operatingAuthorityMs: number;
  readonly registryPreparationMs: number;
  readonly privatePublicationMs: number;
  readonly runtimeAuthorityMs: number;
  readonly preparedInferenceAuthorityMs: number;
  readonly exactRuntimeInspectionMs: number;
  readonly preRouteCurrentnessMs: number;
  readonly routeMs: number;
  readonly dependencyMs: number;
  readonly finalCurrentnessMs: number;
  readonly totalMs: number;
  readonly runtimeAction: "reused" | "recovered";
}

export interface HermesPortableOllamaRecoveryTiming {
  readonly now?: () => number;
  readonly onComplete: (evidence: HermesPortableOllamaRecoveryTimingEvidence) => void;
}

type HermesPortableOllamaRecoveryEntryTimingStage =
  | "operatingAuthority"
  | "registryPreparation"
  | "privatePublication"
  | "runtimeAuthority"
  | "preparedInferenceAuthority"
  | "exactRuntimeInspection";

type HermesPortableOllamaRecoveryTimingStage =
  | "preRouteCurrentness"
  | "route"
  | "dependency"
  | "finalCurrentness";

function writeHermesPortableOllamaRecoveryTiming(
  evidence: HermesPortableOllamaRecoveryTimingEvidence,
): void {
  console.log(
    `  Hermes Portable Ollama recovery timing: entryAuthority=${String(evidence.entryAuthorityMs)}ms operatingAuthority=${String(evidence.operatingAuthorityMs)}ms registryPreparation=${String(evidence.registryPreparationMs)}ms privatePublication=${String(evidence.privatePublicationMs)}ms runtimeAuthority=${String(evidence.runtimeAuthorityMs)}ms preparedInferenceAuthority=${String(evidence.preparedInferenceAuthorityMs)}ms exactRuntimeInspection=${String(evidence.exactRuntimeInspectionMs)}ms preRouteCurrentness=${String(evidence.preRouteCurrentnessMs)}ms route=${String(evidence.routeMs)}ms dependency=${String(evidence.dependencyMs)}ms finalCurrentness=${String(evidence.finalCurrentnessMs)}ms total=${String(evidence.totalMs)}ms runtimeAction=${evidence.runtimeAction} result=proved`,
  );
}

function createHermesPortableOllamaRecoveryTimingRecorder(
  timing: HermesPortableOllamaRecoveryTiming,
): {
  readonly finishEntryAuthority: () => void;
  readonly measureEntry: <T>(
    stage: HermesPortableOllamaRecoveryEntryTimingStage,
    operation: () => T,
  ) => T;
  readonly entryTiming: (stage: HermesPortableOllamaRecoveryEntryTimingStage) => {
    readonly now: () => number;
    readonly onComplete: (durationMs: number) => void;
  };
  readonly measure: <T>(stage: HermesPortableOllamaRecoveryTimingStage, operation: () => T) => T;
  readonly finish: (
    runtimeAction: HermesPortableOllamaRecoveryTimingEvidence["runtimeAction"],
  ) => void;
} {
  const now = timing.now ?? (() => performance.now());
  const startedAt = safeTimingNow(now);
  const durations = new Map<
    HermesPortableOllamaRecoveryEntryTimingStage | HermesPortableOllamaRecoveryTimingStage,
    number
  >();
  const activeStages: { childMs: number }[] = [];
  let entryAuthorityMs = 0;
  let entryFinished = false;
  let finished = false;
  const elapsed = (start: number | null, end: number | null): number => {
    if (start === null || end === null) return 0;
    const value = Math.round(end - start);
    return Number.isFinite(value) ? Math.min(9_999_999, Math.max(0, value)) : 0;
  };
  const measureStage = <T>(
    stage: HermesPortableOllamaRecoveryEntryTimingStage | HermesPortableOllamaRecoveryTimingStage,
    operation: () => T,
  ): T => {
    const stageStartedAt = safeTimingNow(now);
    const frame = { childMs: 0 };
    activeStages.push(frame);
    try {
      return operation();
    } finally {
      const duration = elapsed(stageStartedAt, safeTimingNow(now));
      activeStages.pop();
      durations.set(
        stage,
        Math.min(9_999_999, (durations.get(stage) ?? 0) + Math.max(0, duration - frame.childMs)),
      );
      const parent = activeStages.at(-1);
      if (parent) parent.childMs = Math.min(9_999_999, parent.childMs + duration);
    }
  };
  const recordExternalStage = (
    stage: HermesPortableOllamaRecoveryEntryTimingStage,
    durationMs: number,
  ): void => {
    const duration = Math.min(
      9_999_999,
      Math.max(0, Number.isFinite(durationMs) ? Math.round(durationMs) : 0),
    );
    durations.set(stage, Math.min(9_999_999, (durations.get(stage) ?? 0) + duration));
    const parent = activeStages.at(-1);
    if (parent) parent.childMs = Math.min(9_999_999, parent.childMs + duration);
  };
  return Object.freeze({
    finishEntryAuthority(): void {
      if (entryFinished) return;
      entryFinished = true;
      entryAuthorityMs = elapsed(startedAt, safeTimingNow(now));
    },
    measureEntry: measureStage,
    entryTiming: (stage) =>
      Object.freeze({
        now,
        onComplete: (durationMs: number) => recordExternalStage(stage, durationMs),
      }),
    measure: measureStage,
    finish(runtimeAction): void {
      if (finished) return;
      finished = true;
      try {
        timing.onComplete(
          Object.freeze({
            entryAuthorityMs,
            operatingAuthorityMs: durations.get("operatingAuthority") ?? 0,
            registryPreparationMs: durations.get("registryPreparation") ?? 0,
            privatePublicationMs: durations.get("privatePublication") ?? 0,
            runtimeAuthorityMs: durations.get("runtimeAuthority") ?? 0,
            preparedInferenceAuthorityMs: durations.get("preparedInferenceAuthority") ?? 0,
            exactRuntimeInspectionMs: durations.get("exactRuntimeInspection") ?? 0,
            preRouteCurrentnessMs: durations.get("preRouteCurrentness") ?? 0,
            routeMs: durations.get("route") ?? 0,
            dependencyMs: durations.get("dependency") ?? 0,
            finalCurrentnessMs: durations.get("finalCurrentness") ?? 0,
            totalMs: elapsed(startedAt, safeTimingNow(now)),
            runtimeAction,
          }),
        );
      } catch {
        // Timing output must not change published-runtime recovery.
      }
    },
  });
}

function safeTimingNow(now: () => number): number | null {
  try {
    const value = now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeHermesPortablePublishedResumeTiming(
  evidence: PodmanPublishedResumeTimingEvidence,
): void {
  console.log(
    `  Hermes Portable Ollama resume timing: start=${String(evidence.startMs)}ms managedReady=${String(evidence.managedReadyMs)}ms gpuIdentity=${String(evidence.gpuIdentityMs)}ms generatedProof=${String(evidence.generatedProofMs)}ms modelPlacement=${String(evidence.modelPlacementMs)}ms cleanupCurrentness=${String(evidence.cleanupCurrentnessMs)}ms total=${String(evidence.totalMs)}ms runtimeAction=${evidence.runtimeAction} result=proved`,
  );
}

interface PreparedHermesPortableOllamaRecoveryEntry {
  readonly registryRecovery: PreparedPortableRegistryRecovery;
  readonly createRuntimeAuthority: (options: {
    readonly assertForwardAuthority: () => void;
    readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
  }) => HermesPortableOllamaRuntimeAuthority & {
    readonly operation: HostLocalInferenceOperation;
  };
}

function prepareHermesPortableOllamaRecoveryEntry(options: {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly inferenceReceipt: HostLocalInferenceReceipt;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly assertCallerTransactionCurrent: () => void;
}): PreparedHermesPortableOllamaRecoveryEntry {
  if (!("networkId" in options.inferenceReceipt.endpoint)) {
    failRecovery("published Ollama network authority is missing");
  }
  const preparedAuthority = atOllamaRecoveryPhase("REGISTRY_PREPARATION_AUTHORITY", () => {
    const sourceEnv = {
      ...options.env,
      ...buildHermesPortablePodmanEnvironment(options.receipt.runtimeAuthority, options.env),
    };
    const engines = createHermesPortablePodmanOperationEngines(
      options.receipt.podmanExecutableAuthority,
      options.receipt.socketAuthority,
      options.receipt.runtimeAuthority,
      sourceEnv,
    );
    const qualification = Object.freeze({
      expectedVersion: HERMES_PORTABLE_PODMAN_VERSION,
      captureCurrentCdiDevices: () =>
        captureQualifiedGpuDevices(captureCurrentGpuDevices, captureCurrentCdiDevices),
      assertCurrentAuthority: engines.assertTransactionCurrent,
    });
    const operationAuthority = preparePodmanHostLocalInferenceOperationAuthority({
      engine: engines.hostLocalInference,
      env: options.env,
      acceleration: "nvidia-gpu",
      authorityQualification: qualification,
      redactSensitive: redactOnboardDiagnosticText,
    });
    return Object.freeze({ engines, operationAuthority });
  });
  const { engines, operationAuthority } = preparedAuthority;
  let registryRecovery: PreparedPortableRegistryRecovery;
  try {
    registryRecovery = preparePortableRegistryRecovery(
      engines.hostLocalInference,
      options.inferenceReceipt.endpoint.networkAuthoritySha256,
      operationAuthority.assertTransactionCurrent,
      options.assertCallerTransactionCurrent,
      {},
      {
        assertEngineCurrent: operationAuthority.assertTransactionCurrent,
        assertCallerCurrent: options.assertCallerTransactionCurrent,
      },
    );
  } catch (error) {
    rethrowHermesPortableOllamaRegistryRecoveryError(error);
  }
  let runtimeCreated = false;
  return Object.freeze({
    registryRecovery,
    createRuntimeAuthority(runtimeOptions: {
      readonly assertForwardAuthority: () => void;
      readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
    }) {
      if (runtimeCreated) {
        failRecovery("published recovery runtime authority was already created");
      }
      runtimeCreated = true;
      const network = capturePortableNetworkAuthority(engines.hostLocalInference);
      const inferenceStateDir = hermesPortableInferenceStateDir(
        options.stateDir,
        options.receipt.sandboxName,
      );
      const authorityStore = openFilePersistedEngineAuthorityStore(inferenceStateDir);
      const routeAuthorityStore = createUnusedRouteAuthorityStore();
      const operation = operationAuthority.createOperation({
        authorityStore,
        routeAuthorityStore,
        externalNetwork: network,
        hermesPortablePublishedEngineAuthority: {
          intent: "connect-probe-only",
          creationAuthority: options.inferenceReceipt.engineAuthority,
          serializedReceipt: serializeHostLocalInferenceReceipt(options.inferenceReceipt),
          assertForwardAuthority: runtimeOptions.assertForwardAuthority,
        },
        publishedResumeTiming:
          runtimeOptions.publishedResumeTiming ??
          Object.freeze({ onComplete: writeHermesPortablePublishedResumeTiming }),
        onFailureEvidence: (evidence) => {
          const message = redactOnboardDiagnosticText(evidence.message);
          if (message) console.error(`  Podman inference ${evidence.phase}: ${message}`);
        },
      });
      const bundle = createPodmanRuntimeProviderBundle({
        engines: {
          hostDoctor: engines.hostDoctor,
          hostLocalInference: engines.hostLocalInference,
          sandboxLifecycle: engines.sandboxLifecycle,
        },
        hostLocalInference: {
          authorityStore,
          routeAuthorityStore,
          externalNetwork: network,
          hermesPortablePublishedEngineAuthority: {
            intent: "connect-probe-only",
            creationAuthority: options.inferenceReceipt.engineAuthority,
            serializedReceipt: serializeHostLocalInferenceReceipt(options.inferenceReceipt),
            assertForwardAuthority: runtimeOptions.assertForwardAuthority,
          },
          hermesPortablePublishedRecoveryOperation: {
            operation,
            environment: options.env,
          },
          publishedResumeTiming:
            runtimeOptions.publishedResumeTiming ??
            Object.freeze({ onComplete: writeHermesPortablePublishedResumeTiming }),
          onFailureEvidence: (evidence) => {
            const message = redactOnboardDiagnosticText(evidence.message);
            if (message) console.error(`  Podman inference ${evidence.phase}: ${message}`);
          },
          redactSensitive: redactOnboardDiagnosticText,
        },
        preflight: { platform: "linux", architecture: "x64" },
      });
      const assertTransactionCurrent = (): void => {
        runtimeOptions.assertForwardAuthority();
        operationAuthority.assertTransactionCurrent();
        network.assertCurrent();
      };
      const assertCurrent = (): void => {
        runtimeOptions.assertForwardAuthority();
        operationAuthority.assertCurrent();
        network.assertCurrent();
      };
      assertTransactionCurrent();
      return Object.freeze({
        bundle,
        inferenceStateDir,
        network,
        operation,
        assertTransactionCurrent,
        assertCurrent,
      });
    },
  });
}

/** Reconstruct the exact schema-7 Podman inference owner without acquiring images. */
export function createHermesPortableOllamaRuntimeAuthority(options: {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly publishedRecovery?: {
    readonly inferenceReceipt: HostLocalInferenceReceipt;
    readonly assertForwardAuthority: () => void;
  };
  readonly stateDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly podmanAuthorityDeps?: HermesPortablePodmanAuthorityDeps;
  readonly captureGpuDevices?: () => readonly string[];
  readonly captureCdiDevices?: () => readonly string[];
  readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
}): HermesPortableOllamaRuntimeAuthority {
  const sourceEnv = {
    ...(options.env ?? process.env),
    ...buildHermesPortablePodmanEnvironment(
      options.receipt.runtimeAuthority,
      options.env ?? process.env,
    ),
  };
  const engines = createHermesPortablePodmanOperationEngines(
    options.receipt.podmanExecutableAuthority,
    options.receipt.socketAuthority,
    options.receipt.runtimeAuthority,
    sourceEnv,
    options.podmanAuthorityDeps,
  );
  const captureGpuDevices = () =>
    captureQualifiedGpuDevices(
      options.captureGpuDevices ?? captureCurrentGpuDevices,
      options.captureCdiDevices ?? captureCurrentCdiDevices,
    );
  const qualification = Object.freeze({
    expectedVersion: HERMES_PORTABLE_PODMAN_VERSION,
    captureCurrentCdiDevices: () => captureGpuDevices(),
    assertCurrentAuthority: engines.assertTransactionCurrent,
  });
  const authority = qualifyPodmanInferenceAuthority(engines.hostLocalInference, qualification);
  const network = capturePortableNetworkAuthority(engines.hostLocalInference);
  const assertTransactionCurrent = (): void => {
    options.publishedRecovery?.assertForwardAuthority();
    engines.assertTransactionCurrent();
    network.assertCurrent();
  };
  const assertCurrent = (): void => {
    options.publishedRecovery?.assertForwardAuthority();
    revalidatePodmanInferenceAuthority(engines.hostLocalInference, authority, qualification);
    network.assertCurrent();
  };
  const inferenceStateDir = hermesPortableInferenceStateDir(
    options.stateDir,
    options.receipt.sandboxName,
  );
  const bundle = createPodmanRuntimeProviderBundle({
    engines: {
      hostDoctor: engines.hostDoctor,
      hostLocalInference: engines.hostLocalInference,
      sandboxLifecycle: engines.sandboxLifecycle,
    },
    hostLocalInference: {
      authority,
      authorityQualification: qualification,
      ...(options.publishedRecovery
        ? {
            hermesPortablePublishedEngineAuthority: {
              intent: "connect-probe-only",
              creationAuthority: options.publishedRecovery.inferenceReceipt.engineAuthority,
              serializedReceipt: serializeHostLocalInferenceReceipt(
                options.publishedRecovery.inferenceReceipt,
              ),
              assertForwardAuthority: options.publishedRecovery.assertForwardAuthority,
            },
            publishedResumeTiming:
              options.publishedResumeTiming ??
              Object.freeze({ onComplete: writeHermesPortablePublishedResumeTiming }),
          }
        : {}),
      authorityStore: openFilePersistedEngineAuthorityStore(inferenceStateDir),
      routeAuthorityStore: createUnusedRouteAuthorityStore(),
      externalNetwork: network,
      onFailureEvidence: (evidence) => {
        const message = redactOnboardDiagnosticText(evidence.message);
        if (message) console.error(`  Podman inference ${evidence.phase}: ${message}`);
      },
      redactSensitive: redactOnboardDiagnosticText,
    },
    preflight: { platform: "linux", architecture: "x64" },
  });
  assertTransactionCurrent();
  return Object.freeze({
    bundle,
    inferenceStateDir,
    network,
    assertTransactionCurrent,
    assertCurrent,
  });
}

export type HermesPortableOllamaRecoveryResult = "recovered" | "reused";

export type HermesPortableOllamaRecoveryFailure =
  | "authority-drift"
  | "runtime-restoration-unproved"
  | "registry-restoration-unproved";

export type HermesPortableOllamaRecoveryPhase =
  | `REGISTRY_PREPARATION_${PortableRegistryRecoveryPhase}`
  | "REGISTRY_PREPARATION_AUTHORITY"
  | "RUNTIME_AUTHORITY"
  | "LIFECYCLE_AUTHORITY"
  | "PRIVATE_PUBLICATION_AUTHORITY"
  | "EXACT_RUNTIME_INSPECTION";

export class HermesPortableOllamaRecoveryError extends Error {
  constructor(
    readonly failure: HermesPortableOllamaRecoveryFailure,
    message: string,
  ) {
    super(`Hermes Portable managed inference recovery failed: ${message}`);
    this.name = "HermesPortableOllamaRecoveryError";
  }
}

export class HermesPortableOllamaRecoveryPhaseError extends Error {
  constructor(readonly phase: HermesPortableOllamaRecoveryPhase) {
    super("Hermes Portable managed inference recovery stopped at a fixed boundary.");
    this.name = "HermesPortableOllamaRecoveryPhaseError";
  }
}

export function rethrowHermesPortableOllamaRegistryRecoveryError(error: unknown): never {
  if (
    error instanceof HermesPortableOllamaRecoveryError ||
    error instanceof HermesPortableOllamaRecoveryPhaseError
  ) {
    throw error;
  }
  if (error instanceof PortableRegistryRecoveryRestorationError) {
    failRecovery(
      "exact stopped-registry restoration was not proved",
      "registry-restoration-unproved",
    );
  }
  if (error instanceof PortableRegistryRecoveryPhaseError) {
    throw new HermesPortableOllamaRecoveryPhaseError(`REGISTRY_PREPARATION_${error.phase}`);
  }
  throw new HermesPortableOllamaRecoveryPhaseError("REGISTRY_PREPARATION_POSTCONDITION");
}

function atOllamaRecoveryPhase<T>(phase: HermesPortableOllamaRecoveryPhase, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof HermesPortableOllamaRecoveryError ||
      error instanceof HermesPortableOllamaRecoveryPhaseError
    ) {
      throw error;
    }
    throw new HermesPortableOllamaRecoveryPhaseError(phase);
  }
}

export interface HermesPortableOllamaRecoveryInput {
  readonly intent: "connect-probe-only";
  readonly sandboxName: string;
  readonly entry: SandboxEntry;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly runGatewayOpenshell: HermesPortableOllamaGatewayRunner;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
  readonly verifyRoute: () => SandboxEntry;
  readonly prepareProbeDependency?: () => HermesPortableOllamaPreparedProbeDependency;
  readonly assertCallerTransactionCurrent?: () => void;
  readonly assertCallerCurrent?: () => void;
}

export interface HermesPortableOllamaPreparedProbeDependency {
  readonly release: () => void;
  readonly rollback: () => void;
}

interface HermesPortableOllamaRecoveryDeps {
  readonly readReceipt: typeof readHermesPortableLifecycleReceipt;
  readonly qualifyOperatingAuthority: typeof qualifyHermesPortableOperatingAuthority;
  readonly prepareRecoveryEntry: typeof prepareHermesPortableOllamaRecoveryEntry;
  readonly prepareInferenceAuthority: typeof prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority;
  readonly assertPreparedInferenceAuthorityCurrent: typeof assertHermesPortableHostLocalInferencePublishedRecoveryAuthorityCurrent;
  readonly preparePublishedAuthority: typeof prepareHermesPortableOllamaPublishedInferenceAuthority;
  readonly prepareStartup: typeof prepareHermesPortablePublishedHostLocalInferenceStartup;
  readonly recoveryTiming: HermesPortableOllamaRecoveryTiming;
}

const DEFAULT_RECOVERY_DEPS: HermesPortableOllamaRecoveryDeps = Object.freeze({
  readReceipt: readHermesPortableLifecycleReceipt,
  qualifyOperatingAuthority: qualifyHermesPortableOperatingAuthority,
  prepareRecoveryEntry: prepareHermesPortableOllamaRecoveryEntry,
  prepareInferenceAuthority: prepareHermesPortableHostLocalInferencePublishedRecoveryAuthority,
  assertPreparedInferenceAuthorityCurrent:
    assertHermesPortableHostLocalInferencePublishedRecoveryAuthorityCurrent,
  preparePublishedAuthority: prepareHermesPortableOllamaPublishedInferenceAuthority,
  prepareStartup: prepareHermesPortablePublishedHostLocalInferenceStartup,
  recoveryTiming: Object.freeze({ onComplete: writeHermesPortableOllamaRecoveryTiming }),
});

function failRecovery(
  message: string,
  failure: HermesPortableOllamaRecoveryFailure = "authority-drift",
): never {
  throw new HermesPortableOllamaRecoveryError(failure, message);
}

function rethrowNestedHermesPortableRecoveryError(error: unknown): void {
  const prefix = "Hermes Portable managed inference recovery failed: ";
  if (error instanceof HermesPortableOllamaRecoveryError) throw error;
  if (error instanceof Error && error.message.startsWith(prefix)) {
    throw new HermesPortableOllamaRecoveryError(
      "authority-drift",
      error.message.slice(prefix.length),
    );
  }
}

function requireExactRecoveryReceipt(
  expected: string,
  value: HostLocalInferenceReceipt,
  message: string,
): void {
  if (serializeHostLocalInferenceReceipt(value) !== expected) failRecovery(message);
}

type PublishedOllamaRecoveryReceipt = HostLocalInferenceReceipt & {
  readonly service: "ollama";
  readonly endpoint: HostLocalInferenceProofEndpointAuthority & {
    readonly networkListenerIp: string;
  };
  readonly inference: NonNullable<HostLocalInferenceReceipt["inference"]>;
  readonly publication: NonNullable<HostLocalInferenceReceipt["publication"]>;
  readonly runtime: Extract<
    HostLocalInferenceReceipt["runtime"],
    { readonly kind: "container" }
  > & {
    readonly gpu: Extract<
      Extract<HostLocalInferenceReceipt["runtime"], { readonly kind: "container" }>["gpu"],
      { readonly devices: readonly string[] }
    >;
  };
};

function createPublishedResumeRequest(
  receipt: HostLocalInferenceReceipt,
  receiptWriter: HostLocalInferenceReceiptWriter,
): HostLocalInferenceStartupRequest {
  requirePublishedOllamaRecoveryReceipt(receipt);
  return Object.freeze({
    application: "hermes" as const,
    service: "ollama" as const,
    managed: Object.freeze({
      service: "ollama" as const,
      containerName: receipt.runtime.name,
      containerPort: 11_434,
      imageRef: receipt.runtime.imageRef,
      gpuDevices: Object.freeze([...receipt.runtime.gpu.devices]),
      environment: Object.freeze([]),
      ollamaContextLength: 64_000,
      model: receipt.inference!.model,
      requireToolCalling: receipt.inference!.toolCallingRequired,
      networkName: receipt.endpoint.networkName,
      networkId: receipt.endpoint.networkId,
      networkGatewayIp: receipt.endpoint.networkGatewayIp,
      networkListenerIp: receipt.endpoint.networkListenerIp,
      hostPort: receipt.endpoint.port,
      probeImageRef: receipt.runtime.probeImageRef,
    }),
    resumeReceipt: receipt,
    receiptWriter,
  });
}

function requirePublishedOllamaRecoveryReceipt(
  receipt: HostLocalInferenceReceipt,
): asserts receipt is PublishedOllamaRecoveryReceipt {
  if (
    receipt.service !== "ollama" ||
    receipt.runtime.kind !== "container" ||
    !("devices" in receipt.runtime.gpu) ||
    receipt.inference === undefined ||
    receipt.publication === undefined ||
    !("networkId" in receipt.endpoint) ||
    typeof receipt.endpoint.networkListenerIp !== "string"
  ) {
    failRecovery("published Ollama receipt authority is missing or incomplete");
  }
}

function inferenceLifecycleRow(
  entry: SandboxEntry,
  providerId: string,
): HostLocalInferenceLifecycleSandbox {
  if (entry.openshellDriver !== "docker") {
    failRecovery("sandbox registry OpenShell authority is incomplete");
  }
  if (entry.hostLocalInferenceProvenance !== undefined) {
    failRecovery("Ollama registry must not contain llama.cpp provenance");
  }
  return Object.freeze({ ...entry, openshellDriver: providerId });
}

export type HermesPortableOllamaReadinessRuntimeDisposition = Readonly<{
  kind: "running-current" | "stopped";
  assertCurrent: () => void;
}>;

interface HermesPortableOllamaReadinessRuntimeDeps {
  readonly preparePublishedReceiptAuthority: typeof prepareHermesPortableOllamaPublishedReceiptAuthority;
  readonly createInspectionAuthority: typeof createHermesPortablePodmanInferenceInspectionAuthority;
  readonly inspectRuntime: typeof inspectPodmanPublishedOllamaReadinessRuntime;
  readonly openAuthorityStore: typeof openFilePersistedEngineAuthorityStore;
}

const DEFAULT_READINESS_RUNTIME_DEPS: HermesPortableOllamaReadinessRuntimeDeps = Object.freeze({
  preparePublishedReceiptAuthority: prepareHermesPortableOllamaPublishedReceiptAuthority,
  createInspectionAuthority: createHermesPortablePodmanInferenceInspectionAuthority,
  inspectRuntime: inspectPodmanPublishedOllamaReadinessRuntime,
  openAuthorityStore: openFilePersistedEngineAuthorityStore,
});

/** Classify one exact published Ollama runtime without creating recovery authority. */
export function inspectHermesPortableOllamaReadinessRuntime(
  input: {
    readonly intent: "connect-probe-only";
    readonly sandboxName: string;
    readonly entry: SandboxEntry;
    readonly operatingReceipt: HermesPortableConfiguredReceipt;
    readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
    readonly assertCallerCurrent: () => void;
    readonly env?: NodeJS.ProcessEnv;
    readonly stateDir?: string;
  },
  overrides: Partial<HermesPortableOllamaReadinessRuntimeDeps> = {},
): HermesPortableOllamaReadinessRuntimeDisposition {
  if (
    input.intent !== "connect-probe-only" ||
    input.operatingReceipt.phase !== "active" ||
    input.operatingReceipt.sandboxName !== input.sandboxName ||
    input.entry.name !== input.sandboxName ||
    input.entry.agent !== "hermes" ||
    input.entry.provider !== "ollama-local"
  ) {
    failRecovery("readiness runtime authority is incomplete");
  }
  const serializedReceipt = input.entry.hostLocalInferenceReceipt;
  if (typeof serializedReceipt !== "string") {
    failRecovery("sandbox registry host-local inference receipt is missing");
  }
  const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
  requirePublishedOllamaRecoveryReceipt(receipt);
  inferenceLifecycleRow(input.entry, receipt.providerId);
  if (input.entry.model !== receipt.inference.model) {
    failRecovery("sandbox registry model differs from published runtime authority");
  }

  const deps = { ...DEFAULT_READINESS_RUNTIME_DEPS, ...overrides };
  const expectedEntry = structuredClone(input.entry);
  const stateDir = input.stateDir ?? defaultPortableDemoStateDir(input.env ?? process.env);
  const inferenceStateDir = hermesPortableInferenceStateDir(stateDir, input.sandboxName);
  const published = deps.preparePublishedReceiptAuthority({
    directory: inferenceStateDir,
    sandboxName: input.sandboxName,
    credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
  });
  if (published.serializedReceipt !== serializedReceipt) {
    failRecovery("private and registry inference receipts disagree");
  }
  const authorityStore = deps.openAuthorityStore(inferenceStateDir);
  const persisted = authorityStore.load("host-local-inference");
  if (
    persisted === null ||
    serializePersistedEngineAuthority(persisted) !==
      serializePersistedEngineAuthority(receipt.engineAuthority)
  ) {
    failRecovery("persisted and published inference engine authority disagree");
  }
  const inspectionAuthority = deps.createInspectionAuthority(
    input.operatingReceipt.podmanExecutableAuthority,
    input.operatingReceipt.socketAuthority,
    input.operatingReceipt.runtimeAuthority,
    input.env ?? process.env,
  );
  const assertCurrent = (): void => {
    input.assertCallerCurrent();
    if (!isDeepStrictEqual(input.readRegistry(input.sandboxName), expectedEntry)) {
      failRecovery("sandbox registry authority changed during readiness classification");
    }
    published.assertCurrent();
    inspectionAuthority.assertTransactionCurrent();
    const currentPersisted = authorityStore.load("host-local-inference");
    if (
      currentPersisted === null ||
      serializePersistedEngineAuthority(currentPersisted) !==
        serializePersistedEngineAuthority(persisted)
    ) {
      failRecovery("persisted inference engine authority changed during readiness classification");
    }
    input.assertCallerCurrent();
  };
  assertCurrent();
  const inspected = deps.inspectRuntime({
    engine: inspectionAuthority.engine,
    persistedEngineAuthority: persisted,
    serializedReceipt,
    assertCurrent,
  });
  assertCurrent();
  return Object.freeze({
    kind: inspected.running ? "running-current" : "stopped",
    assertCurrent,
  });
}

function restoreStoppedRuntime(
  prepared: HostLocalInferencePreparedStartup,
  serializedReceipt: string,
): void {
  if (prepared.publicationState() !== "unpublished") {
    failRecovery(
      "exact stopped runtime restoration is indeterminate",
      "runtime-restoration-unproved",
    );
  }
  const rollback = prepared.rollback();
  if (
    rollback.priorState !== "stopped" ||
    rollback.status !== hostLocalInferenceRollbackStatus("stopped") ||
    serializeHostLocalInferenceReceipt(rollback.receipt) !== serializedReceipt
  ) {
    failRecovery("rollback returned different runtime authority", "runtime-restoration-unproved");
  }
}

/** Resume and re-prove only the exact published Hermes Portable Ollama runtime. */
export function recoverHermesPortableOllamaInference(
  input: HermesPortableOllamaRecoveryInput,
  overrides: Partial<HermesPortableOllamaRecoveryDeps> = {},
): HermesPortableOllamaRecoveryResult {
  if (input.intent !== "connect-probe-only") {
    failRecovery("recovery is restricted to connect --probe-only");
  }
  const deps = { ...DEFAULT_RECOVERY_DEPS, ...overrides };
  const recoveryTiming = createHermesPortableOllamaRecoveryTimingRecorder(deps.recoveryTiming);
  const env = input.env ?? process.env;
  const stateDir = input.stateDir ?? defaultPortableDemoStateDir(env);
  input.assertCallerCurrent?.();
  const snapshot = deps.readReceipt(input.sandboxName, stateDir);
  if (!snapshot || snapshot.receipt.phase !== "active" || !snapshot.successor) {
    failRecovery("active schema-6 lifecycle authority is missing");
  }
  const operating = recoveryTiming.measureEntry("operatingAuthority", () =>
    deps.qualifyOperatingAuthority(
      snapshot as typeof snapshot & { readonly receipt: HermesPortableConfiguredReceipt },
    ),
  );
  operating.assertTransactionCurrent();
  if (!isDeepStrictEqual(input.readRegistry(input.sandboxName), input.entry)) {
    failRecovery("sandbox registry authority changed before recovery");
  }
  const serializedRegistryReceipt = input.entry.hostLocalInferenceReceipt;
  if (typeof serializedRegistryReceipt !== "string") {
    failRecovery("sandbox registry host-local inference receipt is missing");
  }
  const receipt = parseHostLocalInferenceReceipt(serializedRegistryReceipt);
  requirePublishedOllamaRecoveryReceipt(receipt);
  const providerEntry = inferenceLifecycleRow(input.entry, receipt.providerId);
  const assertCallerCurrent = (): void => {
    input.assertCallerCurrent?.();
    try {
      operating.assertCurrent();
    } catch {
      failRecovery("schema-6 operating authority changed during recovery");
    }
    if (!isDeepStrictEqual(input.readRegistry(input.sandboxName), input.entry)) {
      failRecovery("sandbox registry authority changed during recovery");
    }
    input.assertCallerCurrent?.();
  };
  const assertCallerTransactionCurrent = (): void => {
    input.assertCallerTransactionCurrent?.();
    try {
      operating.assertTransactionCurrent();
    } catch {
      failRecovery("schema-6 operating authority changed during recovery");
    }
    if (!isDeepStrictEqual(input.readRegistry(input.sandboxName), input.entry)) {
      failRecovery("sandbox registry authority changed during recovery");
    }
    input.assertCallerTransactionCurrent?.();
  };
  const recoveryEntry = recoveryTiming.measureEntry("registryPreparation", () =>
    atOllamaRecoveryPhase("REGISTRY_PREPARATION_POSTCONDITION", () =>
      deps.prepareRecoveryEntry({
        receipt: operating.receipt,
        inferenceReceipt: receipt,
        stateDir,
        env,
        assertCallerTransactionCurrent,
      }),
    ),
  );
  const { registryRecovery } = recoveryEntry;
  let ollamaStateRestored = true;
  try {
    const published = recoveryTiming.measureEntry("privatePublication", () =>
      atOllamaRecoveryPhase("PRIVATE_PUBLICATION_AUTHORITY", () => {
        const current = deps.preparePublishedAuthority({
          directory: hermesPortableInferenceStateDir(stateDir, operating.receipt.sandboxName),
          sandboxName: input.sandboxName,
          credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
          runGatewayOpenshell: input.runGatewayOpenshell,
        });
        if (current.serializedReceipt !== serializedRegistryReceipt) {
          failRecovery("private and registry inference receipts disagree");
        }
        return current;
      }),
    );
    const assertForwardAuthority = (): void => {
      assertCallerTransactionCurrent();
      try {
        published.assertTransactionCurrent();
      } catch {
        failRecovery("private publication authority changed during recovery");
      }
      assertCallerTransactionCurrent();
    };
    const runtimeAuthority = recoveryTiming.measureEntry("runtimeAuthority", () =>
      atOllamaRecoveryPhase("RUNTIME_AUTHORITY", () => {
        const current = recoveryEntry.createRuntimeAuthority({ assertForwardAuthority });
        current.assertTransactionCurrent();
        if (current.bundle.identity.id !== receipt.providerId) {
          failRecovery("published runtime provider authority changed");
        }
        return current;
      }),
    );
    const { operation, preparedAuthority, runtime } = atOllamaRecoveryPhase(
      "LIFECYCLE_AUTHORITY",
      () =>
        recoveryTiming.measureEntry("preparedInferenceAuthority", () => {
          const currentPreparedAuthority = deps.prepareInferenceAuthority(
            runtimeAuthority.bundle,
            providerEntry,
            { environment: env },
            recoveryTiming.entryTiming("exactRuntimeInspection"),
            runtimeAuthority.operation,
          );
          if (
            !currentPreparedAuthority ||
            currentPreparedAuthority.serializedReceipt !== serializedRegistryReceipt
          ) {
            failRecovery("published host-local inference authority is missing");
          }
          const currentOperation = currentPreparedAuthority.managedOperation;
          if (!currentOperation) {
            failRecovery("published host-local inference operation authority is missing");
          }
          const currentRuntime = currentOperation.managedRuntime;
          if (!currentRuntime || !currentRuntime.resumeManaged) {
            failRecovery("runtime provider does not support published managed inference resume");
          }
          return Object.freeze({
            operation: currentOperation,
            preparedAuthority: currentPreparedAuthority,
            runtime: currentRuntime,
          });
        }),
    );
    const assertPreparedAuthorityCurrent = (expectedRunning: boolean): void => {
      const currentEntry = input.readRegistry(input.sandboxName);
      if (!currentEntry || !isDeepStrictEqual(currentEntry, input.entry)) {
        failRecovery("sandbox registry authority changed during recovery");
      }
      try {
        const current = deps.assertPreparedInferenceAuthorityCurrent(
          runtimeAuthority.bundle,
          inferenceLifecycleRow(currentEntry, runtimeAuthority.bundle.identity.id),
          preparedAuthority,
        );
        if (current.running !== expectedRunning) {
          failRecovery("published host-local inference runtime state changed during recovery");
        }
      } catch {
        failRecovery("host-local inference authority changed during recovery");
      }
    };
    const requireTransactionCurrent = (expectedRunning: boolean): void => {
      assertCallerTransactionCurrent();
      registryRecovery.assertTransactionCurrent();
      runtimeAuthority.assertTransactionCurrent();
      published.assertTransactionCurrent();
      assertPreparedAuthorityCurrent(expectedRunning);
      assertCallerTransactionCurrent();
    };
    const requireCompletionCurrent = (): void => {
      assertCallerTransactionCurrent();
      registryRecovery.assertTransactionCurrent();
      runtimeAuthority.assertTransactionCurrent();
      published.assertTransactionCurrent();
      assertCallerTransactionCurrent();
      assertCallerCurrent();
      runtimeAuthority.assertCurrent();
      published.assertCurrent();
      assertPreparedAuthorityCurrent(true);
      registryRecovery.assertTransactionCurrent();
      runtimeAuthority.assertTransactionCurrent();
      published.assertTransactionCurrent();
      assertCallerTransactionCurrent();
    };
    const verifyFinalRoute = (): void => {
      const verified = input.verifyRoute();
      if (!isDeepStrictEqual(verified, input.entry)) {
        failRecovery("final route verification returned different registry authority");
      }
    };

    const inspected = atOllamaRecoveryPhase("EXACT_RUNTIME_INSPECTION", () => {
      const current = preparedAuthority.managedInspection;
      if (!current) {
        failRecovery("published runtime entry inspection is missing");
      }
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        current.receipt,
        "runtime inspection changed receipt",
      );
      return current;
    });
    recoveryTiming.finishEntryAuthority();
    if (inspected.running) {
      let preparedDependency: HermesPortableOllamaPreparedProbeDependency | null = null;
      try {
        const validatePublishedResume = runtime.validatePublishedResume;
        if (!validatePublishedResume) {
          failRecovery("runtime provider lacks published resume validation");
        }
        recoveryTiming.measure("preRouteCurrentness", () => {
          requireExactRecoveryReceipt(
            serializedRegistryReceipt,
            validatePublishedResume(receipt),
            "running runtime validation changed receipt",
          );
          requireTransactionCurrent(true);
        });
        recoveryTiming.measure("route", verifyFinalRoute);
        preparedDependency = recoveryTiming.measure(
          "dependency",
          () => input.prepareProbeDependency?.() ?? null,
        );
        recoveryTiming.measure("finalCurrentness", requireCompletionCurrent);
        registryRecovery.release();
        preparedDependency?.release();
        recoveryTiming.finish("reused");
        return "reused";
      } catch (error) {
        if (preparedDependency) {
          try {
            preparedDependency.rollback();
          } catch (rollbackError) {
            throw rollbackError;
          }
        }
        throw error;
      }
    }

    let prepared: HostLocalInferencePreparedStartup;
    ollamaStateRestored = false;
    let preparedDependency: HermesPortableOllamaPreparedProbeDependency | null = null;
    try {
      prepared = recoveryTiming.measure("preRouteCurrentness", () => {
        requireTransactionCurrent(false);
        return deps.prepareStartup(
          operation,
          createPublishedResumeRequest(receipt, published.receiptWriter),
        ).prepared;
      });
    } catch (error) {
      const inspectRestoration = runtime.inspectPublishedRecoveryRestoration;
      if (!inspectRestoration) {
        failRecovery("runtime provider lacks rollback-safe restoration inspection");
      }
      const restored = inspectRestoration(receipt);
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        restored.receipt,
        "failed resume inspection changed receipt",
      );
      if (restored.running) {
        failRecovery("failed resume did not restore the exact stopped runtime");
      }
      ollamaStateRestored = true;
      if (error instanceof PublishedInferenceForwardAuthorityError) {
        failRecovery("published recovery authority changed during recovery");
      }
      throw error;
    }
    try {
      if (prepared.rollbackPriorState !== "stopped") {
        failRecovery("runtime state changed before the exact resume boundary");
      }
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        prepared.receipt,
        "prepared recovery changed receipt",
      );
      recoveryTiming.measure("preRouteCurrentness", () => {
        requireExactRecoveryReceipt(
          serializedRegistryReceipt,
          prepared.validateBeforeCommit(),
          "pre-commit recovery validation changed receipt",
        );
        requireTransactionCurrent(true);
      });
      recoveryTiming.measure("route", verifyFinalRoute);
      preparedDependency = recoveryTiming.measure(
        "dependency",
        () => input.prepareProbeDependency?.() ?? null,
      );
      const finalizePublishedResume = prepared.finalizePublishedResume;
      if (!finalizePublishedResume) {
        failRecovery("runtime provider lacks rollback-safe published resume finalization");
      }
      recoveryTiming.measure("finalCurrentness", () => {
        requireExactRecoveryReceipt(
          serializedRegistryReceipt,
          finalizePublishedResume(requireCompletionCurrent),
          "recovery finalization changed receipt",
        );
      });
      ollamaStateRestored = true;
      registryRecovery.release();
      preparedDependency?.release();
      recoveryTiming.finish("recovered");
      return "recovered";
    } catch (error) {
      let dependencyRollbackError: unknown = null;
      if (preparedDependency) {
        try {
          preparedDependency.rollback();
        } catch (rollbackError) {
          dependencyRollbackError = rollbackError;
        }
      }
      try {
        restoreStoppedRuntime(prepared, serializedRegistryReceipt);
        ollamaStateRestored = true;
      } catch {
        failRecovery(
          "recovery failed and exact stopped-state restoration was not proved",
          "runtime-restoration-unproved",
        );
      }
      if (dependencyRollbackError) throw dependencyRollbackError;
      throw error;
    }
  } catch (error) {
    if (!ollamaStateRestored) {
      failRecovery(
        "recovery failed before dependent runtime restoration was proved",
        "runtime-restoration-unproved",
      );
    }
    try {
      registryRecovery.rollback();
    } catch {
      failRecovery(
        "recovery failed and exact stopped-registry restoration was not proved",
        "registry-restoration-unproved",
      );
    }
    rethrowNestedHermesPortableRecoveryError(error);
    throw error;
  }
}

export function createHermesPortableOllamaInferenceResolver(
  options: HermesPortableOllamaInferenceResolverOptions,
): HostLocalInferenceStartupSelectionResolver {
  return (input: HostLocalInferenceStartupSelectionInput) => {
    if (input.application !== "hermes") return null;
    if (input.provider !== "ollama-local") return null;
    if (!SAFE_CREDENTIAL_ENV.test(options.credentialEnv)) {
      throw new Error("Hermes Portable Ollama gateway credential authority is invalid.");
    }
    if (!options.runtimeContext) {
      if (isPortableExperimentalProfile(process.env)) {
        throw new Error("Hermes Portable inference has no current-user Podman runtime authority.");
      }
      return null;
    }
    const model = requirePortableOllamaModel(input.model);
    if (input.acceleration !== "nvidia-gpu") {
      throw new Error("Hermes Portable Ollama requires NVIDIA GPU acceleration authority.");
    }
    if (input.recover && !input.allowPublishedResume) {
      throw new Error("Hermes Portable Ollama recovery authority is inconsistent.");
    }
    const runtimeContext = options.runtimeContext;
    if (!runtimeContext.environmentScope) {
      throw new Error("Hermes Portable inference has no active environment authority.");
    }
    const sessionId = requireSessionId(options.getReservationSessionId());
    const sourceEnv = runtimeContext.environmentScope.createHermesPortablePodmanSourceEnvironment(
      runtimeContext.authority,
    );
    const socketAuthority = (
      options.captureSocketAuthority ??
      ((socketPath, uid) => capturePodmanSocketAuthority(socketPath, { uid }))
    )(runtimeContext.authority.socketPath, runtimeContext.authority.uid);
    const executableAuthority = captureHermesPortablePodmanExecutableAuthority(
      socketAuthority,
      runtimeContext.authority,
      sourceEnv,
      options.podmanAuthorityDeps,
    );
    const engines = createHermesPortablePodmanOperationEngines(
      executableAuthority,
      socketAuthority,
      runtimeContext.authority,
      sourceEnv,
      options.podmanAuthorityDeps,
    );
    engines.assertCurrent();
    const captureGpuDevices = () =>
      captureQualifiedGpuDevices(
        options.captureGpuDevices ?? captureCurrentGpuDevices,
        options.captureCdiDevices ?? captureCurrentCdiDevices,
      );
    const authorityQualification = Object.freeze({
      expectedVersion: HERMES_PORTABLE_PODMAN_VERSION,
      captureCurrentCdiDevices: () => captureGpuDevices(),
      assertCurrentAuthority: engines.assertCurrent,
    });
    const authority = qualifyPodmanInferenceAuthority(
      engines.hostLocalInference,
      authorityQualification,
    );
    const gpuDevices = authority.cdiDevices;
    const networkAuthority = capturePortableNetworkAuthority(engines.hostLocalInference);
    const assertCurrent = () => {
      engines.assertCurrent();
      networkAuthority.assertCurrent();
      revalidatePodmanInferenceAuthority(
        engines.hostLocalInference,
        authority,
        authorityQualification,
      );
    };

    const sandboxDigest = digest({ sandboxName: input.sandboxName });
    const stateDir = path.join(
      options.stateDir ?? defaultPortableDemoStateDir(sourceEnv),
      "portable-inference",
      sandboxDigest,
    );
    const transactionId = digest({
      kind: "hermes-portable-ollama",
      sessionId,
      sandboxName: input.sandboxName,
      model,
      runtimeAuthority: runtimeContext.authority,
      engineAuthority: authority,
      networkAuthority: networkAuthority.authoritySha256,
    });
    const targetSha256 = digest({
      kind: "hermes-portable-ollama-receipt",
      sandboxName: input.sandboxName,
    });
    const gatewayTransaction = createHermesPortableOllamaGatewayTransaction({
      directory: stateDir,
      transactionId,
      targetSha256,
      sandboxName: input.sandboxName,
      model,
      credentialEnv: options.credentialEnv,
      runGatewayOpenshell: options.runGatewayOpenshell,
    });
    const publishedReceipt = gatewayTransaction.publishedReceipt;
    const requireToolCalling =
      input.requireToolCalling ?? publishedReceipt?.inference?.toolCallingRequired;
    if (typeof requireToolCalling !== "boolean") {
      throw new Error("Hermes Portable Ollama requires explicit tool-calling authority.");
    }
    const containerName = `nemoclaw-portable-ollama-${sandboxDigest.slice(0, 16)}`;
    const recoverInterrupted =
      publishedReceipt === null &&
      hasHermesPortableOllamaRecoveryContainer(
        engines.hostLocalInference,
        containerName,
        assertCurrent,
      );
    const recoverUnpublishedRoute =
      input.allowPublishedResume &&
      gatewayTransaction.recoverUnpublishedRoute &&
      recoverInterrupted;
    if (
      (input.allowPublishedResume && publishedReceipt === null && !recoverUnpublishedRoute) ||
      (!input.allowPublishedResume && publishedReceipt !== null) ||
      (gatewayTransaction.recoverUnpublishedRoute && !recoverInterrupted)
    ) {
      throw new Error("Hermes Portable Ollama publication authority is inconsistent.");
    }
    const bundle = withRetainedImageAcquisition(
      createPodmanRuntimeProviderBundle({
        engines: {
          hostDoctor: engines.hostDoctor,
          hostLocalInference: engines.hostLocalInference,
          sandboxLifecycle: engines.sandboxLifecycle,
        },
        hostLocalInference: {
          authority,
          authorityQualification,
          authorityStore: createFilePersistedEngineAuthorityStore(stateDir),
          routeAuthorityStore: createUnusedRouteAuthorityStore(),
          externalNetwork: networkAuthority,
          onFailureEvidence: (evidence) => {
            const message = redactOnboardDiagnosticText(evidence.message);
            if (message) console.error(`  Podman inference ${evidence.phase}: ${message}`);
          },
          redactSensitive: redactOnboardDiagnosticText,
        },
        preflight: { platform: "linux", architecture: "x64" },
      }),
      engines.hostLocalInference,
      assertCurrent,
      redactOnboardCommandDiagnosticText,
    );
    const selection: HostLocalInferenceStartupSelection = Object.freeze({
      runtimeProviderId: "podman",
      request: Object.freeze({
        application: "hermes" as const,
        service: "ollama" as const,
        managed: Object.freeze({
          service: "ollama" as const,
          containerName,
          containerPort: 11434,
          imageRef: PORTABLE_OLLAMA_IMAGE,
          gpuDevices,
          environment: Object.freeze([]),
          ollamaContextLength: 64_000,
          model,
          requireToolCalling,
          networkName: PORTABLE_DOCKER_NETWORK_NAME,
          networkId: networkAuthority.networkId,
          networkGatewayIp: networkAuthority.gatewayIp,
          networkListenerIp: networkAuthority.listenerIp,
          hostPort: 11434,
          probeImageRef: PORTABLE_PROBE_IMAGE,
        }),
        ...(publishedReceipt
          ? { resumeReceipt: publishedReceipt }
          : recoverInterrupted || recoverUnpublishedRoute
            ? { recover: true }
            : {}),
        receiptWriter: gatewayTransaction.receiptWriter,
      }),
      resolveRuntimeProvider: (sandboxName: string) => {
        if (sandboxName !== input.sandboxName) {
          throw new Error("Hermes Portable inference runtime belongs to another sandbox.");
        }
        assertCurrent();
        return bundle;
      },
      prepareGatewayMutation: gatewayTransaction.prepareGatewayMutation,
    });
    return selection;
  };
}
