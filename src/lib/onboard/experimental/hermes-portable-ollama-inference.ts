// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import { capturePodmanSocketAuthority, type PodmanSocketAuthority } from "../../adapters/podman";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import type { HostLocalInferenceRouteAuthorityStore } from "../runtime-provider/host-local-inference";
import type {
  HostLocalInferenceStartupSelection,
  HostLocalInferenceStartupSelectionInput,
  HostLocalInferenceStartupSelectionResolver,
} from "../runtime-provider/host-local-inference-routing";
import {
  createFilePersistedEngineAuthorityStore,
  openFilePersistedEngineAuthorityStore,
} from "../runtime-provider/persisted-engine-authority";
import { createPodmanRuntimeProviderBundle } from "../runtime-provider/podman";
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
  createHermesPortablePodmanOperationEngines,
  HERMES_PORTABLE_PODMAN_VERSION,
  type HermesPortablePodmanAuthorityDeps,
} from "./hermes-portable-podman-authority";
import { buildHermesPortablePodmanEnvironment } from "./hermes-portable-container";
import type { HermesPortableConfiguredReceipt } from "./hermes-portable-receipt";
import {
  captureCurrentCdiDevices,
  captureCurrentGpuDevices,
  capturePortableNetworkAuthority,
  captureQualifiedGpuDevices,
  PORTABLE_OLLAMA_IMAGE,
  PORTABLE_PROBE_IMAGE,
  withRetainedImageAcquisition,
} from "./hermes-portable-ollama-authority";
import {
  createHermesPortableOllamaGatewayTransaction,
  hasHermesPortableOllamaRecoveryContainer,
  type HermesPortableOllamaGatewayRunner,
} from "./hermes-portable-ollama-gateway-transaction";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";

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
    if (input.requireToolCalling === null) {
      throw new Error("Hermes Portable Ollama requires explicit tool-calling authority.");
    }
    if (input.allowPublishedResume !== input.recover) {
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
          model,
          requireToolCalling: input.requireToolCalling,
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
