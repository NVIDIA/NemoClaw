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
  type HostLocalInferenceProofEndpointAuthority,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceReceiptWriter,
  type HostLocalInferenceRouteAuthorityStore,
  type HostLocalInferenceRuntime,
} from "../runtime-provider/host-local-inference";
import {
  prepareSandboxHostLocalInferenceDestroyAuthority,
  type HostLocalInferenceLifecycleSandbox,
} from "../runtime-provider/host-local-inference-lifecycle";
import type {
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
  HostLocalInferenceStartupSelectionResolver,
  HostLocalInferenceStartupRequest,
} from "../runtime-provider/host-local-inference-routing";
import { prepareHostLocalInferenceStartup } from "../runtime-provider/host-local-inference-routing";
import {
  createFilePersistedEngineAuthorityStore,
  openFilePersistedEngineAuthorityStore,
} from "../runtime-provider/persisted-engine-authority";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
import {
  qualifyPodmanInferenceAuthority,
  revalidatePodmanInferenceAuthority,
} from "../runtime-provider/podman-preflight";
import { requireRuntimeProviderHostLocalInferenceOperation } from "../runtime-provider/registry";
import {
  redactOnboardCommandDiagnosticText,
  redactOnboardDiagnosticText,
} from "../session-bootstrap";
import { PORTABLE_DOCKER_NETWORK_NAME, isPortableExperimentalProfile } from "./portable-profile";
import {
  captureHermesPortablePodmanExecutableAuthority,
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
  PORTABLE_OLLAMA_IMAGE,
  PORTABLE_PROBE_IMAGE,
  type PreparedPortableRegistryRecovery,
  withRetainedImageAcquisition,
} from "./hermes-portable-ollama-authority";
import {
  createHermesPortableOllamaGatewayTransaction,
  hasHermesPortableOllamaRecoveryContainer,
  prepareHermesPortableOllamaPublishedInferenceAuthority,
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
  readonly assertCurrent: () => void;
}

function prepareHermesPortableOllamaRegistryRecovery(options: {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly inferenceReceipt: HostLocalInferenceReceipt;
  readonly env: NodeJS.ProcessEnv;
  readonly assertCallerCurrent: () => void;
}): PreparedPortableRegistryRecovery {
  if (!("networkId" in options.inferenceReceipt.endpoint)) {
    failRecovery("published Ollama network authority is missing");
  }
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
  const captureGpuDevices = () =>
    captureQualifiedGpuDevices(captureCurrentGpuDevices, captureCurrentCdiDevices);
  const qualification = Object.freeze({
    expectedVersion: HERMES_PORTABLE_PODMAN_VERSION,
    captureCurrentCdiDevices: () => captureGpuDevices(),
    assertCurrentAuthority: engines.assertCurrent,
  });
  const authority = qualifyPodmanInferenceAuthority(engines.hostLocalInference, qualification);
  const assertEngineCurrent = (): void => {
    engines.assertCurrent();
    revalidatePodmanInferenceAuthority(engines.hostLocalInference, authority, qualification);
  };
  return preparePortableRegistryRecovery(
    engines.hostLocalInference,
    options.inferenceReceipt.endpoint.networkAuthoritySha256,
    assertEngineCurrent,
    options.assertCallerCurrent,
  );
}

/** Reconstruct the exact schema-5 Podman inference owner without acquiring images. */
export function createHermesPortableOllamaRuntimeAuthority(options: {
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly stateDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly podmanAuthorityDeps?: HermesPortablePodmanAuthorityDeps;
  readonly captureGpuDevices?: () => readonly string[];
  readonly captureCdiDevices?: () => readonly string[];
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
    assertCurrentAuthority: engines.assertCurrent,
  });
  const authority = qualifyPodmanInferenceAuthority(engines.hostLocalInference, qualification);
  const network = capturePortableNetworkAuthority(engines.hostLocalInference);
  const assertCurrent = (): void => {
    engines.assertCurrent();
    network.assertCurrent();
    revalidatePodmanInferenceAuthority(engines.hostLocalInference, authority, qualification);
  };
  const inferenceStateDir = path.join(
    options.stateDir,
    "portable-inference",
    digest({ sandboxName: options.receipt.sandboxName }),
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
  assertCurrent();
  return Object.freeze({ bundle, inferenceStateDir, network, assertCurrent });
}

export type HermesPortableOllamaRecoveryResult = "recovered" | "reused";

export type HermesPortableOllamaRecoveryFailure =
  | "authority-drift"
  | "runtime-restoration-unproved"
  | "registry-restoration-unproved";

export class HermesPortableOllamaRecoveryError extends Error {
  constructor(
    readonly failure: HermesPortableOllamaRecoveryFailure,
    message: string,
  ) {
    super(`Hermes Portable managed inference recovery failed: ${message}`);
    this.name = "HermesPortableOllamaRecoveryError";
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
}

interface HermesPortableOllamaRecoveryDeps {
  readonly readReceipt: typeof readHermesPortableLifecycleReceipt;
  readonly qualifyOperatingAuthority: typeof qualifyHermesPortableOperatingAuthority;
  readonly createRuntimeAuthority: typeof createHermesPortableOllamaRuntimeAuthority;
  readonly prepareInferenceAuthority: typeof prepareSandboxHostLocalInferenceDestroyAuthority;
  readonly requireOperation: typeof requireRuntimeProviderHostLocalInferenceOperation;
  readonly preparePublishedAuthority: typeof prepareHermesPortableOllamaPublishedInferenceAuthority;
  readonly prepareRegistryRecovery: typeof prepareHermesPortableOllamaRegistryRecovery;
  readonly prepareStartup: typeof prepareHostLocalInferenceStartup;
}

const DEFAULT_RECOVERY_DEPS: HermesPortableOllamaRecoveryDeps = Object.freeze({
  readReceipt: readHermesPortableLifecycleReceipt,
  qualifyOperatingAuthority: qualifyHermesPortableOperatingAuthority,
  createRuntimeAuthority: createHermesPortableOllamaRuntimeAuthority,
  prepareInferenceAuthority: prepareSandboxHostLocalInferenceDestroyAuthority,
  requireOperation: requireRuntimeProviderHostLocalInferenceOperation,
  preparePublishedAuthority: prepareHermesPortableOllamaPublishedInferenceAuthority,
  prepareRegistryRecovery: prepareHermesPortableOllamaRegistryRecovery,
  prepareStartup: prepareHostLocalInferenceStartup,
});

function failRecovery(
  message: string,
  failure: HermesPortableOllamaRecoveryFailure = "authority-drift",
): never {
  throw new HermesPortableOllamaRecoveryError(failure, message);
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

function restoreStoppedRuntime(
  prepared: HostLocalInferencePreparedStartup,
  runtime: HostLocalInferenceRuntime,
  receipt: HostLocalInferenceReceipt,
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
  const restored = runtime.inspectManaged(receipt);
  requireExactRecoveryReceipt(
    serializedReceipt,
    restored.receipt,
    "rollback inspection changed receipt",
  );
  if (restored.running) {
    failRecovery(
      "rollback did not restore the exact stopped runtime",
      "runtime-restoration-unproved",
    );
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
  const env = input.env ?? process.env;
  const stateDir = input.stateDir ?? defaultPortableDemoStateDir(env);
  const snapshot = deps.readReceipt(input.sandboxName, stateDir);
  if (!snapshot || snapshot.receipt.phase !== "active" || !snapshot.successor) {
    failRecovery("active schema-6 lifecycle authority is missing");
  }
  const operating = deps.qualifyOperatingAuthority(
    snapshot as typeof snapshot & { readonly receipt: HermesPortableConfiguredReceipt },
  );
  operating.assertCurrent();
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
    operating.assertCurrent();
    if (!isDeepStrictEqual(input.readRegistry(input.sandboxName), input.entry)) {
      failRecovery("sandbox registry authority changed during recovery");
    }
  };
  const registryRecovery = deps.prepareRegistryRecovery({
    receipt: operating.receipt,
    inferenceReceipt: receipt,
    env,
    assertCallerCurrent,
  });
  let ollamaStateRestored = true;
  try {
    const runtimeAuthority = deps.createRuntimeAuthority({
      receipt: operating.receipt,
      stateDir,
      env,
    });
    runtimeAuthority.assertCurrent();
    if (runtimeAuthority.bundle.identity.id !== receipt.providerId) {
      failRecovery("published runtime provider authority changed");
    }
    const preparedAuthority = deps.prepareInferenceAuthority(
      runtimeAuthority.bundle,
      providerEntry,
      { environment: env },
    );
    if (!preparedAuthority || preparedAuthority.serializedReceipt !== serializedRegistryReceipt) {
      failRecovery("published host-local inference authority is missing");
    }
    const operation = deps.requireOperation(runtimeAuthority.bundle, "ollama", {
      env,
      acceleration: "nvidia-gpu",
    });
    const runtime = operation.managedRuntime;
    if (!runtime || !runtime.resumeManaged) {
      failRecovery("runtime provider does not support published managed inference resume");
    }
    const published = deps.preparePublishedAuthority({
      directory: runtimeAuthority.inferenceStateDir,
      sandboxName: input.sandboxName,
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
      runGatewayOpenshell: input.runGatewayOpenshell,
    });
    if (published.serializedReceipt !== serializedRegistryReceipt) {
      failRecovery("private and registry inference receipts disagree");
    }

    const requireCurrent = (): void => {
      registryRecovery.assertCurrent();
      operating.assertCurrent();
      runtimeAuthority.assertCurrent();
      published.assertCurrent();
      const currentEntry = input.readRegistry(input.sandboxName);
      if (!currentEntry || !isDeepStrictEqual(currentEntry, input.entry)) {
        failRecovery("sandbox registry authority changed during recovery");
      }
      const currentPrepared = deps.prepareInferenceAuthority(
        runtimeAuthority.bundle,
        inferenceLifecycleRow(currentEntry, runtimeAuthority.bundle.identity.id),
        { environment: env },
      );
      if (
        !currentPrepared ||
        currentPrepared.serializedReceipt !== preparedAuthority.serializedReceipt ||
        currentPrepared.sandboxAuthoritySha256 !== preparedAuthority.sandboxAuthoritySha256
      ) {
        failRecovery("host-local inference authority changed during recovery");
      }
    };
    const verifyFinalRoute = (): void => {
      const verified = input.verifyRoute();
      if (!isDeepStrictEqual(verified, input.entry)) {
        failRecovery("final route verification returned different registry authority");
      }
    };

    const inspected = runtime.inspectManaged(receipt);
    requireExactRecoveryReceipt(
      serializedRegistryReceipt,
      inspected.receipt,
      "runtime inspection changed receipt",
    );
    if (inspected.running) {
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        runtime.preserveForRebuild(receipt),
        "running runtime validation changed receipt",
      );
      requireCurrent();
      verifyFinalRoute();
      requireCurrent();
      registryRecovery.release();
      return "reused";
    }

    let prepared: HostLocalInferencePreparedStartup;
    ollamaStateRestored = false;
    try {
      prepared = deps.prepareStartup(
        operation,
        createPublishedResumeRequest(receipt, published.receiptWriter),
      ).prepared;
    } catch (error) {
      const restored = runtime.inspectManaged(receipt);
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        restored.receipt,
        "failed resume inspection changed receipt",
      );
      if (restored.running) {
        failRecovery("failed resume did not restore the exact stopped runtime");
      }
      ollamaStateRestored = true;
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
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        prepared.validateBeforeCommit(),
        "pre-commit recovery validation changed receipt",
      );
      requireCurrent();
      verifyFinalRoute();
      const finalizePublishedResume = prepared.finalizePublishedResume;
      if (!finalizePublishedResume) {
        failRecovery("runtime provider lacks rollback-safe published resume finalization");
      }
      requireExactRecoveryReceipt(
        serializedRegistryReceipt,
        finalizePublishedResume(requireCurrent),
        "recovery finalization changed receipt",
      );
      ollamaStateRestored = true;
      registryRecovery.release();
      return "recovered";
    } catch (error) {
      try {
        restoreStoppedRuntime(prepared, runtime, receipt, serializedRegistryReceipt);
        ollamaStateRestored = true;
        requireCurrent();
      } catch {
        failRecovery(
          "recovery failed and exact stopped-state restoration was not proved",
          "runtime-restoration-unproved",
        );
      }
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
