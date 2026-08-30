// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import type { PodmanBoundContainerEngine, PodmanContainerEngine } from "../../adapters/podman";
import {
  HOST_LOCAL_INFERENCE_SANDBOX_HOST,
  type HostLocalInferenceEndpointAuthority,
  type HostLocalInferenceEndpointInput,
  type HostLocalInferenceMount,
  type HostLocalInferenceOperation,
  type HostLocalInferencePreparedStartup,
  type HostLocalInferencePriorRuntimeState,
  type HostLocalInferenceProofAuthority,
  type HostLocalInferenceProofEndpointAuthority,
  type HostLocalInferencePublicationAuthority,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceReceiptWriter,
  type HostLocalInferenceRouteAuthority,
  type HostLocalInferenceRouteAuthorityStore,
  type HostLocalInferenceRuntime,
  type HostLocalInferenceRuntimeAuthority,
  type HostLocalInferenceService,
  type HostLocalManagedInferenceInput,
  type HostLocalManagedInferenceInspection,
  type HostLocalOllamaAccelerationAuthority,
  type HostLocalOllamaInferenceInput,
  normalizeHostLocalInferenceImageRef,
  normalizeHostLocalInferenceReceipt,
  normalizeHostLocalOllamaModelRef,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import {
  createPersistedEngineAuthority,
  normalizePersistedEngineAuthority,
  serializePersistedEngineAuthority,
  type PersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
  requirePersistedEngineAuthority,
} from "./persisted-engine-authority";
import { translatePodmanLocalInferenceArgs } from "./podman-inference-args";
import {
  type PodmanInferenceAuthorityReceipt,
  type PodmanInferenceQualificationOptions,
  qualifyPodmanInferenceAuthority,
  revalidatePodmanInferenceAuthority,
} from "./podman-preflight";

export const PODMAN_INFERENCE_MANAGED_LABEL = "ai.nvidia.nemoclaw.inference.managed";
export const PODMAN_INFERENCE_PROVIDER_LABEL = "ai.nvidia.nemoclaw.inference.provider";
export const PODMAN_INFERENCE_SERVICE_LABEL = "ai.nvidia.nemoclaw.inference.service";
export const PODMAN_INFERENCE_SPEC_LABEL = "ai.nvidia.nemoclaw.inference.spec-sha256";
export const PODMAN_INFERENCE_AUTHORITY_LABEL = "ai.nvidia.nemoclaw.inference.authority-sha256";
export const PODMAN_INFERENCE_TRANSACTION_LABEL = "ai.nvidia.nemoclaw.inference.transaction-sha256";
export const PODMAN_INFERENCE_RECEIPT_TARGET_LABEL =
  "ai.nvidia.nemoclaw.inference.receipt-target-sha256";
export const PODMAN_INFERENCE_PRIOR_STATE_LABEL = "ai.nvidia.nemoclaw.inference.prior-state";
export const PODMAN_INFERENCE_NETWORK_MANAGED_LABEL =
  "ai.nvidia.nemoclaw.inference.network.managed";
export const PODMAN_INFERENCE_NETWORK_PROVIDER_LABEL =
  "ai.nvidia.nemoclaw.inference.network.provider";
export const PODMAN_INFERENCE_NETWORK_ENGINE_AUTHORITY_LABEL =
  "ai.nvidia.nemoclaw.inference.network.engine-authority-sha256";
export const PODMAN_INFERENCE_PROBE_MANAGED_LABEL = "ai.nvidia.nemoclaw.inference.probe.managed";

/** Closed owner signal retained across exact published-runtime rollback. */
export class PublishedInferenceForwardAuthorityError extends Error {
  constructor() {
    super("Published inference forward authority changed.");
    this.name = "PublishedInferenceForwardAuthorityError";
  }
}
export const PODMAN_INFERENCE_PROBE_PHASE_LABEL = "ai.nvidia.nemoclaw.inference.probe.phase";
export const PODMAN_INFERENCE_PROBE_SPEC_LABEL = "ai.nvidia.nemoclaw.inference.probe.spec-sha256";
const PODMAN_INFERENCE_LABEL_PREFIX = "ai.nvidia.nemoclaw.inference.";

const PROVIDER_ID = "podman";
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/u;
const FULL_NETWORK_ID = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SHARED_MEMORY = /^[1-9][0-9]{0,11}(?:[kKmMgGtT][bB]?)?$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/gu;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GPU_UUID = /^GPU-[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/u;
const RESERVED_NETWORK_NAMES = new Set([
  "bridge",
  "container",
  "default",
  "host",
  "none",
  "pasta",
  "podman",
  "slirp4netns",
]);
const AT_REST_STATES = new Set(["configured", "created", "dead", "exited", "stopped"]);
const PROBE_TIMEOUT_MS = 30_000;
const POST_CREATE_PROBE_INSPECT_MAX_ATTEMPTS = 3;
const PROBE_CLEANUP_SETTLEMENT_TIMEOUT_MS = 30_000;
const PROBE_CLEANUP_SETTLEMENT_INTERVAL_MS = 1_000;
const PROBE_CLEANUP_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const INFERENCE_PROBE_TIMEOUT_MS = 150_000;
const READY_PROBE_TIMEOUT_MS = 240_000;
const PROBE_CURL_MAX_TIME_SECONDS = 20;
const INFERENCE_PROBE_CURL_MAX_TIME_SECONDS = 120;
const MUTATION_TIMEOUT_MS = 60_000;
const OLLAMA_MODEL_PULL_TIMEOUT_MS = 30 * 60_000;
const STOP_GRACE_SECONDS = 30;
const SECRET_ENVIRONMENT_BY_SERVICE = Object.freeze({
  ollama: new Set<string>(),
  nim: new Set(["NGC_API_KEY", "NIM_NGC_API_KEY"]),
  // B4-D qualifies only loopback, gateway-controlled, unauthenticated vLLM.
  vllm: new Set<string>(),
});

export interface PodmanProbeCleanupTiming {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
}

export const PODMAN_PUBLISHED_RESUME_TIMING_STAGES = [
  "start",
  "managedReady",
  "gpuIdentity",
  "generatedProof",
  "modelPlacement",
  "cleanupCurrentness",
] as const;

export type PodmanPublishedResumeTimingStage =
  (typeof PODMAN_PUBLISHED_RESUME_TIMING_STAGES)[number];

export interface PodmanPublishedResumeTimingEvidence {
  readonly startMs: number;
  readonly managedReadyMs: number;
  readonly gpuIdentityMs: number;
  readonly generatedProofMs: number;
  readonly modelPlacementMs: number;
  /** Exclusive aggregate across disposable-probe cleanup and currentness checks. */
  readonly cleanupCurrentnessMs: number;
  readonly totalMs: number;
  readonly runtimeAction: "reused" | "started";
}

export interface PodmanPublishedResumeTiming {
  readonly now?: () => number;
  readonly onComplete: (evidence: PodmanPublishedResumeTimingEvidence) => void;
}

type PodmanPublishedResumeTimingRecorder = {
  measure<T>(stage: PodmanPublishedResumeTimingStage, operation: () => T): T;
  finish(runtimeAction: PodmanPublishedResumeTimingEvidence["runtimeAction"]): void;
};

const PODMAN_PUBLISHED_RESUME_TIMING_MAX_MS = 9_999_999;

function createPodmanPublishedResumeTimingRecorder(
  timing: PodmanPublishedResumeTiming | undefined,
): PodmanPublishedResumeTimingRecorder {
  const now = timing?.now ?? (() => performance.now());
  const durations = new Map<PodmanPublishedResumeTimingStage, number>();
  const active: { stage: PodmanPublishedResumeTimingStage; startedAt: number | null }[] = [];
  let finished = false;
  const safeNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const elapsed = (startedAt: number | null, finishedAt: number | null): number => {
    if (startedAt === null || finishedAt === null) return 0;
    const value = Math.round(finishedAt - startedAt);
    if (!Number.isFinite(value)) return 0;
    return Math.min(PODMAN_PUBLISHED_RESUME_TIMING_MAX_MS, Math.max(0, value));
  };
  const add = (stage: PodmanPublishedResumeTimingStage, value: number): void => {
    durations.set(stage, (durations.get(stage) ?? 0) + value);
  };
  const totalStartedAt = safeNow();

  const measure = <T>(stage: PodmanPublishedResumeTimingStage, operation: () => T): T => {
    const enteredAt = safeNow();
    const parent = active.at(-1);
    if (parent) add(parent.stage, elapsed(parent.startedAt, enteredAt));
    active.push({ stage, startedAt: enteredAt });
    try {
      return operation();
    } finally {
      const finishedAt = safeNow();
      const frame = active.pop();
      add(stage, elapsed(frame?.startedAt ?? null, finishedAt));
      const resumed = active.at(-1);
      if (resumed) resumed.startedAt = finishedAt;
    }
  };

  return {
    measure,
    finish(runtimeAction): void {
      if (finished) return;
      finished = true;
      if (!timing) return;
      try {
        timing.onComplete(
          Object.freeze({
            startMs: durations.get("start") ?? 0,
            managedReadyMs: durations.get("managedReady") ?? 0,
            gpuIdentityMs: durations.get("gpuIdentity") ?? 0,
            generatedProofMs: durations.get("generatedProof") ?? 0,
            modelPlacementMs: durations.get("modelPlacement") ?? 0,
            cleanupCurrentnessMs: durations.get("cleanupCurrentness") ?? 0,
            totalMs: elapsed(totalStartedAt, safeNow()),
            runtimeAction,
          }),
        );
      } catch {
        // Timing output must not change published-runtime recovery.
      }
    },
  };
}

export interface PodmanHostLocalInferenceRuntimeOptions {
  readonly engine: PodmanContainerEngine;
  /** Exact operation input environment; values remain memory-only. */
  readonly env: NodeJS.ProcessEnv;
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly routeAuthorityStore: HostLocalInferenceRouteAuthorityStore;
  readonly authority: PodmanInferenceAuthorityReceipt;
  readonly authorityQualification?: PodmanInferenceQualificationOptions;
  /** Immutable creation identity for one product-requalified published runtime. */
  readonly hermesPortablePublishedEngineAuthority?: {
    readonly intent: "connect-probe-only";
    readonly creationAuthority: PersistedEngineAuthority;
    readonly serializedReceipt: string;
    readonly assertForwardAuthority: () => void;
  };
  /** Fixed, credential-free successful-resume timing. Diagnostic failures are fail-open. */
  readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
  readonly probeCleanupTiming?: PodmanProbeCleanupTiming;
  readonly externalNetwork?: PodmanExternalInferenceNetworkAuthority;
  /** Immutable accepted acceleration scope for this one operation. */
  readonly operationAcceleration?: HostLocalOllamaAccelerationAuthority;
  readonly onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void;
  readonly redactSensitive: PodmanInferenceRedactor;
}

export interface PodmanHostLocalInferenceOperationOptions {
  readonly engine: PodmanContainerEngine;
  /** Exact operation input environment; values remain memory-only. */
  readonly env: NodeJS.ProcessEnv;
  /** Accepted acceleration scope for this one operation. */
  readonly acceleration?: HostLocalOllamaAccelerationAuthority;
  /** Prequalified product network whose host listener is not its IPAM gateway. */
  readonly externalNetwork?: PodmanExternalInferenceNetworkAuthority;
  /** Product-specific exact authority when the generic Podman 6 discovery path is unavailable. */
  readonly authority?: PodmanInferenceAuthorityReceipt;
  readonly authorityQualification?: PodmanInferenceQualificationOptions;
  readonly hermesPortablePublishedEngineAuthority?: PodmanHostLocalInferenceRuntimeOptions["hermesPortablePublishedEngineAuthority"];
  readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
  readonly probeCleanupTiming?: PodmanProbeCleanupTiming;
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly routeAuthorityStore: HostLocalInferenceRouteAuthorityStore;
  readonly onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void;
  readonly redactSensitive: PodmanInferenceRedactor;
}

export type PodmanPreparedHostLocalInferenceOperationOptions = Omit<
  PodmanHostLocalInferenceOperationOptions,
  "acceleration" | "authority" | "authorityQualification" | "engine" | "env" | "redactSensitive"
>;

/** One fully qualified Podman authority that can create one operation without recapturing it. */
export interface PreparedPodmanHostLocalInferenceOperationAuthority {
  readonly createOperation: (
    options: PodmanPreparedHostLocalInferenceOperationOptions,
  ) => HostLocalInferenceOperation;
  readonly assertTransactionCurrent: () => void;
  readonly assertCurrent: () => void;
}

export type PodmanInferenceRedactor = (value: string) => string;

export interface PodmanExternalInferenceNetworkAuthority {
  /**
   * The caller's fresh assertion and the pinned identity, addressing, and listener below replace
   * provider-owned network labels as the trust anchor, so assertCurrent must prove them exactly.
   */
  readonly networkId: string;
  readonly name: string;
  readonly subnet: string;
  readonly gatewayIp: string;
  readonly listenerIp: string;
  readonly authoritySha256: string;
  readonly assertCurrent: () => void;
}

function normalizeOperationAcceleration(value: unknown): HostLocalOllamaAccelerationAuthority {
  if (value === undefined) return "nvidia-gpu";
  if (value === "cpu" || value === "nvidia-gpu") return value;
  throw new Error("Podman host-local inference operation acceleration is unsupported.");
}

export interface PodmanInferenceFailureEvidence {
  readonly providerId: "podman";
  readonly phase:
    | "start"
    | "ready"
    | "gpu"
    | "inference"
    | "commit"
    | "stop"
    | "rollback"
    | "cleanup";
  readonly message: string;
}

interface ManagedSpec {
  readonly service: "ollama" | "nim" | "vllm";
  readonly containerName: string;
  readonly containerPort: number;
  readonly imageRef: string;
  readonly gpuDevices: readonly string[];
  readonly environment: readonly string[];
  readonly ollamaContextLength: number | null;
  readonly mounts: readonly Required<HostLocalInferenceMount>[];
  readonly sharedMemory: string;
  readonly ipc: "private";
  readonly command: readonly string[];
  readonly probeImageRef: string;
  readonly endpoint: HostLocalInferenceProofEndpointAuthority;
  readonly model: string;
  readonly requireToolCalling: boolean;
  readonly transactionId: string;
  readonly receiptTargetSha256: string;
  readonly priorState: "absent" | "running" | "stopped";
  readonly engineBindingSha256: string;
  readonly specSha256: string;
  readonly launchSha256: string;
}

interface PodmanInferenceNetworkAuthority {
  readonly id: string;
  readonly name: string;
  readonly gatewayIp: string;
  readonly authoritySha256: string;
}

type ManagedContainerRuntime = Extract<
  HostLocalInferenceRuntimeAuthority,
  { readonly kind: "container" }
> & {
  readonly gpu: { readonly vendor: "nvidia"; readonly devices: readonly string[] };
};

type OllamaHostRuntimeAuthority = Extract<
  HostLocalInferenceRuntimeAuthority,
  { readonly kind: "host" }
>;

type ManagedReceipt = HostLocalInferenceReceipt & {
  readonly service: "ollama" | "nim" | "vllm";
  readonly runtime: ManagedContainerRuntime;
  readonly inference: HostLocalInferenceProofAuthority;
  readonly publication: HostLocalInferencePublicationAuthority;
};

interface ManagedContainer {
  readonly runtimeId: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly status: string;
  readonly createArguments: readonly string[];
  readonly environmentNames: readonly string[];
  readonly ollamaContextLength: number | null;
  readonly ipcMode: string;
  readonly networkId: string;
  readonly networkName: string;
  readonly portBindings: readonly string[];
  readonly restartPolicy: string;
  readonly sharedMemoryBytes: number;
}

interface ProbeSpec {
  readonly service: "ollama" | "nim" | "vllm";
  readonly phase: "ready" | "gpu" | "inference";
  readonly endpoint: HostLocalInferenceProofEndpointAuthority;
  readonly probeImageRef: string;
  readonly transactionId: string;
  readonly receiptTargetSha256: string;
  readonly parentAuthoritySha256: string;
  readonly request: readonly string[];
  readonly name: string;
  readonly specSha256: string;
  readonly launchArguments: readonly string[];
}

interface ProbeSpecSet {
  readonly current: ProbeSpec;
  readonly legacy: readonly ProbeSpec[];
}

interface OllamaModelPlacementAuthority {
  readonly modelDigest: string;
}

interface ProbeContainer {
  readonly runtimeId: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly status: string;
  readonly exitCode: number;
  readonly createArguments: readonly string[];
  readonly environmentNames: readonly string[];
  readonly ipcMode: string;
  readonly networkId: string;
  readonly networkName: string;
  readonly portBindings: readonly string[];
  readonly restartPolicy: string;
  readonly mounts: readonly unknown[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactText(value: unknown, pattern: RegExp, label: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    !pattern.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function exactPort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function exactNetworkName(value: unknown, label: string): string {
  const networkName = exactText(value, SAFE_NAME, label);
  if (RESERVED_NETWORK_NAMES.has(networkName)) {
    throw new Error(`${label} must identify an isolated provider-owned network.`);
  }
  return networkName;
}

function exactIpv4(value: unknown, label: string): string {
  const address = exactText(value, /\S+/u, label);
  if (!isIPv4(address) || address.startsWith("127.")) {
    throw new Error(`${label} must be an exact non-loopback IPv4 address.`);
  }
  return address;
}

function exactContainerId(value: unknown): string {
  const candidate = exactText(value, /\S+/u, "Podman inference container identity").toLowerCase();
  const normalized = candidate.startsWith("sha256:") ? candidate.slice(7) : candidate;
  if (!FULL_CONTAINER_ID.test(normalized)) {
    throw new Error("Podman inference container identity must be a full immutable ID.");
  }
  return normalized;
}

function boundedEvidence(value: string): string {
  return value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim().slice(-240);
}

function requireRedactor(value: PodmanInferenceRedactor): PodmanInferenceRedactor {
  if (typeof value !== "function") {
    throw new Error("Podman host-local inference requires an injected sensitive-data redactor.");
  }
  const sentinel = "nvapi-redactor-self-test-1234567890";
  const output = value(sentinel);
  if (typeof output !== "string" || output.includes(sentinel)) {
    throw new Error("Podman host-local inference sensitive-data redactor failed qualification.");
  }
  return value;
}

function operationSensitiveRedactor(
  base: PodmanInferenceRedactor,
  env: NodeJS.ProcessEnv,
): PodmanInferenceRedactor {
  const exactSecrets = [...SECRET_ENVIRONMENT_BY_SERVICE.nim]
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (value: string) =>
    base(
      exactSecrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), value),
    );
}

function redactEvidence(redactor: PodmanInferenceRedactor, value: string): string {
  return boundedEvidence(redactor(value));
}

function sanitizeFailureResult(
  result: ContainerEngineCommandResult,
  redactor: PodmanInferenceRedactor,
): ContainerEngineCommandResult {
  const failed = result.status !== 0 || result.error !== undefined;
  const error =
    result.error === undefined
      ? undefined
      : Object.assign(new Error(redactEvidence(redactor, result.error.message)), {
          ...((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
            ? { code: "ETIMEDOUT" }
            : {}),
        });
  return Object.freeze({
    status: result.status,
    // Successful stdout remains intact because it carries provider JSON and
    // exact runtime identities. Stderr is never parsed and is always redacted.
    stdout: failed ? redactEvidence(redactor, result.stdout) : result.stdout,
    stderr: redactEvidence(redactor, result.stderr),
    ...(error ? { error } : {}),
  });
}

function redactingEngine(
  engine: PodmanContainerEngine,
  redactor: PodmanInferenceRedactor,
): PodmanContainerEngine {
  const bound = engine as PodmanContainerEngine & { readonly assertAuthority?: () => void };
  return Object.freeze({
    operation: engine.operation,
    engineId: engine.engineId,
    displayName: engine.displayName,
    authorityId: engine.authorityId,
    endpointAuthorityId: engine.endpointAuthorityId,
    ...(bound.assertAuthority ? { assertAuthority: bound.assertAuthority } : {}),
    capture: (args: readonly string[], timeoutMs?: number, input?: Buffer) =>
      sanitizeFailureResult(engine.capture(args, timeoutMs, input), redactor),
    captureHost: (args: readonly string[], timeoutMs?: number) =>
      sanitizeFailureResult(engine.captureHost(args, timeoutMs), redactor),
    ...(engine.captureWithEnvironment
      ? {
          captureWithEnvironment: (
            args: readonly string[],
            environment: Readonly<Record<string, string>>,
            timeoutMs?: number,
            input?: Buffer,
          ) =>
            sanitizeFailureResult(
              engine.captureWithEnvironment?.(args, environment, timeoutMs, input) ?? {
                status: 1,
                stdout: "",
                stderr: "operation-scoped environment capture disappeared",
              },
              redactor,
            ),
        }
      : {}),
  });
}

function commandEvidence(result: ContainerEngineCommandResult): string {
  return boundedEvidence(
    result.stderr || result.stdout || result.error?.message || "unknown failure",
  );
}

function commandTimedOut(result: ContainerEngineCommandResult): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function redactedCommandEvidence(
  redactor: PodmanInferenceRedactor,
  result: ContainerEngineCommandResult,
): string {
  return redactEvidence(redactor, commandEvidence(result));
}

function errorEvidence(redactor: PodmanInferenceRedactor, error: unknown): string {
  return redactEvidence(redactor, error instanceof Error ? error.message : String(error));
}

class PodmanInferenceEvidenceCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanInferenceEvidenceCaptureError";
  }
}

function emitAcknowledgedCommandFailure(
  label: string,
  phase: PodmanInferenceFailureEvidence["phase"],
  result: ContainerEngineCommandResult,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
): void {
  if (result.status === 0 && !result.error) return;
  const message = `${label} returned exit ${String(result.status)} after its exact side effect was proved: ${redactedCommandEvidence(redactor, result)}`;
  try {
    onFailureEvidence(Object.freeze({ providerId: PROVIDER_ID, phase, message }));
  } catch (error) {
    throw new PodmanInferenceEvidenceCaptureError(errorEvidence(redactor, error));
  }
}

function requireSuccess(operation: string, result: ContainerEngineCommandResult): string {
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Podman host-local inference ${operation} failed (exit ${String(result.status)}): ${commandEvidence(result)}`,
    );
  }
  return result.stdout;
}

function normalizedArguments(
  values: readonly string[] | undefined,
  label: string,
): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new Error(`${label} is invalid or exceeds its item limit.`);
  }
  return Object.freeze(
    values.map((value, index) => {
      if (
        typeof value !== "string" ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > 16 * 1024
      ) {
        throw new Error(`${label}[${String(index)}] is invalid.`);
      }
      return value;
    }),
  );
}

function normalizedEnvironment(values: readonly string[] | undefined): readonly string[] {
  const environment = normalizedArguments(values ?? [], "Inference environment names").map(
    (value) => exactText(value, ENVIRONMENT_NAME, "Inference environment name"),
  );
  if (new Set(environment).size !== environment.length) {
    throw new Error("Inference environment names must be unique.");
  }
  return Object.freeze([...environment].sort());
}

function normalizedOllamaContextLength(
  service: HostLocalManagedInferenceInput["service"],
  value: number | undefined,
): number | null {
  if (value === undefined) return null;
  if (service !== "ollama" || value !== 64_000) {
    throw new Error("Podman managed Ollama context length is invalid.");
  }
  return value;
}

function normalizedMounts(
  values: readonly HostLocalInferenceMount[] | undefined,
): readonly Required<HostLocalInferenceMount>[] {
  if (!Array.isArray(values ?? [])) throw new Error("Inference mounts are invalid.");
  if ((values?.length ?? 0) > 0) {
    throw new Error(
      "Podman host-local inference rejects host bind mounts until an exact source authority is injected.",
    );
  }
  return Object.freeze([]);
}

function requireSecretFreeCommand(
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  redactor: PodmanInferenceRedactor,
): void {
  for (const argument of command) {
    if (
      redactor(argument) !== argument ||
      Object.values(environment).some((secret) => secret !== "" && argument.includes(secret))
    ) {
      throw new Error("Inference command arguments must not carry credential material.");
    }
  }
}

function managedOperationEnvironment(
  spec: Pick<ManagedSpec, "environment" | "ollamaContextLength" | "service">,
  operationEnv: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  if (spec.service === "vllm" && spec.environment.length > 0) {
    throw new Error(
      "Podman B4-D vLLM is unauthenticated and rejects VLLM_API_KEY or any serving credential.",
    );
  }
  const allowed = SECRET_ENVIRONMENT_BY_SERVICE[spec.service];
  const resolved: Record<string, string> = Object.create(null);
  for (const name of spec.environment) {
    if (!allowed.has(name)) {
      throw new Error(`Podman ${spec.service} inference does not allow environment '${name}'.`);
    }
    const value = operationEnv[name];
    if (
      typeof value !== "string" ||
      value === "" ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 16 * 1024
    ) {
      throw new Error(`Podman ${spec.service} inference requires environment '${name}'.`);
    }
    resolved[name] = value;
  }
  if (spec.ollamaContextLength !== null) {
    resolved.OLLAMA_CONTEXT_LENGTH = String(spec.ollamaContextLength);
  }
  return Object.freeze(resolved);
}

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

function sortedStringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return Object.freeze({});
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 64) throw new Error(`${label} exceeds its item limit.`);
  const normalized: Record<string, string> = Object.create(null);
  for (const [key, entry] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(key) ||
      typeof entry !== "string" ||
      CONTROL_CHARACTERS.test(entry) ||
      Buffer.byteLength(entry, "utf8") > 1024
    ) {
      throw new Error(`${label} is invalid.`);
    }
    normalized[key] = entry;
  }
  return Object.freeze(normalized);
}

function exactIpv4Subnet(value: unknown): string {
  const subnet = exactText(value, /^[0-9.]+\/[0-9]{1,2}$/u, "Inference network subnet");
  const separator = subnet.lastIndexOf("/");
  const address = subnet.slice(0, separator);
  const prefix = Number(subnet.slice(separator + 1));
  if (!isIPv4(address) || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
    throw new Error("Inference network subnet is invalid.");
  }
  return subnet;
}

function inspectProviderNetwork(
  engine: ContainerEngine,
  authority: PodmanInferenceAuthorityReceipt,
  expected: Pick<
    HostLocalInferenceEndpointInput,
    "networkGatewayIp" | "networkId" | "networkListenerIp" | "networkName"
  > & {
    readonly networkAuthoritySha256?: string;
  },
  external?: PodmanExternalInferenceNetworkAuthority,
): PodmanInferenceNetworkAuthority {
  if (!external && expected.networkListenerIp !== undefined) {
    throw new Error("Podman inference listener requires exact external network authority.");
  }
  const expectedId = exactText(expected.networkId, FULL_NETWORK_ID, "Inference network identity");
  const expectedName = exactNetworkName(expected.networkName, "Inference network name");
  const expectedGateway = exactIpv4(expected.networkGatewayIp, "Inference network gateway");
  const output = requireSuccess(
    "provider network inspection",
    engine.capture(["network", "inspect", expectedId], PROBE_TIMEOUT_MS),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Podman inference network inspection returned malformed JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Podman inference network inspection is missing or ambiguous.");
  }
  const network = record(parsed[0], "Podman inference network inspection");
  const id = exactText(network.id, FULL_NETWORK_ID, "Inspected inference network identity");
  const name = exactNetworkName(network.name, "Inspected inference network name");
  if (id !== expectedId || name !== expectedName) {
    throw new Error("Podman inference network identity or name changed after qualification.");
  }
  if (network.driver !== "bridge" || exactBoolean(network.internal, "Inference network mode")) {
    throw new Error("Podman inference requires a non-internal provider-owned bridge network.");
  }
  if (exactBoolean(network.ipv6_enabled, "Inference network IPv6 mode")) {
    throw new Error("Podman inference provider network must be IPv4-only.");
  }
  const dnsEnabled = exactBoolean(network.dns_enabled, "Inference network DNS mode");
  if (!Array.isArray(network.subnets) || network.subnets.length !== 1) {
    throw new Error("Podman inference network must expose one exact IPv4 subnet.");
  }
  const subnet = record(network.subnets[0], "Podman inference network subnet");
  const gatewayIp = exactIpv4(subnet.gateway, "Inspected inference network gateway");
  const subnetCidr = exactIpv4Subnet(subnet.subnet);
  const externalListenerIp = external
    ? exactIpv4(external.listenerIp, "External inference listener")
    : null;
  if (externalListenerIp !== null) {
    const toNumber = (address: string): number =>
      address
        .split(".")
        .map(Number)
        .reduce((total, octet) => (total * 256 + octet) >>> 0, 0);
    const separator = subnetCidr.lastIndexOf("/");
    const subnetAddress = subnetCidr.slice(0, separator);
    const prefix = Number(subnetCidr.slice(separator + 1));
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    const listener = toNumber(externalListenerIp);
    const network = (toNumber(subnetAddress) & mask) >>> 0;
    const firstOctet = Number(externalListenerIp.slice(0, externalListenerIp.indexOf(".")));
    if (firstOctet === 0 || firstOctet >= 224 || (listener & mask) >>> 0 === network) {
      throw new Error(
        "External inference listener must be an exact unicast host address outside the qualified sandbox subnet.",
      );
    }
  }
  const externalNetwork = external
    ? Object.freeze({
        networkId: exactText(external.networkId, FULL_NETWORK_ID, "External network identity"),
        name: exactNetworkName(external.name, "External inference network name"),
        subnet: exactIpv4Subnet(external.subnet),
        gatewayIp: exactIpv4(external.gatewayIp, "External inference network gateway"),
        listenerIp: externalListenerIp!,
        authoritySha256: exactText(
          external.authoritySha256,
          SHA256,
          "External inference network authority digest",
        ),
      })
    : null;
  external?.assertCurrent();
  if (
    externalNetwork
      ? externalNetwork.networkId !== expectedId ||
        externalNetwork.name !== expectedName ||
        externalNetwork.subnet !== subnetCidr ||
        externalNetwork.gatewayIp !== gatewayIp ||
        expectedGateway !== gatewayIp
      : gatewayIp !== expectedGateway
  ) {
    throw new Error("Podman inference network gateway changed after qualification.");
  }
  if (
    externalNetwork &&
    externalNetwork.listenerIp !==
      exactIpv4(expected.networkListenerIp, "Inference network listener")
  ) {
    throw new Error("Podman inference network listener changed after qualification.");
  }
  const labels = sortedStringRecord(network.labels, "Inference network labels");
  if (
    !externalNetwork &&
    (labels[PODMAN_INFERENCE_NETWORK_MANAGED_LABEL] !== "true" ||
      labels[PODMAN_INFERENCE_NETWORK_PROVIDER_LABEL] !== PROVIDER_ID ||
      labels[PODMAN_INFERENCE_NETWORK_ENGINE_AUTHORITY_LABEL] !== authority.receiptSha256)
  ) {
    throw new Error("Podman inference network lacks exact provider ownership authority.");
  }
  const networkInterface = exactText(
    network.network_interface,
    SAFE_NAME,
    "Inference network interface",
  );
  const canonical = Object.freeze({
    id,
    name,
    driver: "bridge",
    internal: false,
    ipv6Enabled: false,
    dnsEnabled,
    networkInterface,
    subnet: Object.freeze({ subnet: subnetCidr, gateway: gatewayIp }),
    labels,
    ipamOptions: sortedStringRecord(network.ipam_options, "Inference network IPAM options"),
    options: sortedStringRecord(network.options, "Inference network options"),
    ...(externalNetwork ? { external: externalNetwork } : {}),
  });
  const authoritySha256 = externalNetwork?.authoritySha256 ?? digest(canonical);
  if (
    expected.networkAuthoritySha256 !== undefined &&
    exactText(expected.networkAuthoritySha256, SHA256, "Inference network authority digest") !==
      authoritySha256
  ) {
    throw new Error("Podman inference network authority changed after qualification.");
  }
  return Object.freeze({
    id,
    name,
    gatewayIp,
    authoritySha256,
  });
}

function requireProofEndpoint(
  endpoint: HostLocalInferenceEndpointAuthority,
): HostLocalInferenceProofEndpointAuthority {
  if (
    !("networkId" in endpoint) ||
    !("networkGatewayIp" in endpoint) ||
    !("networkAuthoritySha256" in endpoint)
  ) {
    throw new Error("Podman inference receipt lacks exact network authority.");
  }
  return endpoint;
}

function requireWriter(value: HostLocalInferenceReceiptWriter): HostLocalInferenceReceiptWriter {
  if (
    typeof value !== "object" ||
    value === null ||
    !SHA256.test(value.transactionId) ||
    !SHA256.test(value.targetSha256) ||
    typeof value.writeExact !== "function"
  ) {
    throw new Error("Podman inference receipt writer authority is invalid.");
  }
  return value;
}

function writeReceipt(
  writer: HostLocalInferenceReceiptWriter,
  receipt: HostLocalInferenceReceipt,
  redactor: PodmanInferenceRedactor,
): HostLocalInferenceReceipt {
  if (
    receipt.publication?.transactionId !== writer.transactionId ||
    receipt.publication.targetSha256 !== writer.targetSha256
  ) {
    throw new Error("Podman inference receipt differs from its publication authority.");
  }
  const serialized = serializeHostLocalInferenceReceipt(receipt);
  let firstFailure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const committed = writer.writeExact(serialized);
      if (committed !== serialized) {
        throw new Error("receipt target returned different canonical authority");
      }
      return receipt;
    } catch (error) {
      if (firstFailure === undefined) {
        firstFailure = error;
        continue;
      }
      throw new Error(
        `Podman inference receipt publication remains indeterminate after retry: ${errorEvidence(redactor, firstFailure)}; retry: ${errorEvidence(redactor, error)}`,
      );
    }
  }
  throw new Error("Podman inference receipt publication did not complete.");
}

function normalizeManagedSpec(
  input: HostLocalManagedInferenceInput,
  writerValue: HostLocalInferenceReceiptWriter,
  authority: PodmanInferenceAuthorityReceipt,
  network: PodmanInferenceNetworkAuthority,
  priorState: "absent" | "running" | "stopped",
  engineBindingSha256 = authority.receiptSha256,
): ManagedSpec {
  if (input.service !== "ollama" && input.service !== "nim" && input.service !== "vllm") {
    throw new Error("Podman managed inference supports Ollama, NIM, or vLLM containers.");
  }
  const writer = requireWriter(writerValue);
  const containerName = exactText(input.containerName, SAFE_NAME, "Inference container name");
  const networkName = exactNetworkName(input.networkName, "Inference network name");
  if (
    network.id !== input.networkId ||
    network.name !== networkName ||
    network.gatewayIp !== input.networkGatewayIp
  ) {
    throw new Error("Podman inference input differs from inspected network authority.");
  }
  const hostPort = exactPort(input.hostPort, "Inference host port");
  const containerPort = exactPort(input.containerPort, "Inference container port");
  const imageRef = normalizeHostLocalInferenceImageRef(input.imageRef);
  const probeImageRef = normalizeHostLocalInferenceImageRef(input.probeImageRef);
  const requestedDevices = normalizedArguments(input.gpuDevices, "Inference GPU devices").map(
    (device) => (device.startsWith("nvidia.com/gpu=") ? device : `nvidia.com/gpu=${device}`),
  );
  if (requestedDevices.length === 0 || new Set(requestedDevices).size !== requestedDevices.length) {
    throw new Error("Inference GPU devices must identify at least one unique CDI device.");
  }
  if (requestedDevices.some((device) => !GPU_UUID.test(device.slice("nvidia.com/gpu=".length)))) {
    throw new Error(
      "Podman managed inference requires explicit physical NVIDIA GPU UUID CDI authority.",
    );
  }
  const available = new Set(authority.cdiDevices);
  for (const device of requestedDevices) {
    if (!available.has(device)) {
      throw new Error(`Podman inference authority does not advertise CDI device '${device}'.`);
    }
  }
  const gpuDevices = Object.freeze([...requestedDevices].sort());
  const environment = normalizedEnvironment(input.environment);
  const ollamaContextLength = normalizedOllamaContextLength(
    input.service,
    input.ollamaContextLength,
  );
  const mounts = normalizedMounts(input.mounts);
  const sharedMemory = exactText(
    input.sharedMemory ?? "64m",
    SHARED_MEMORY,
    "Inference shared-memory size",
  ).toLowerCase();
  const ipc = input.ipc ?? "private";
  if (ipc !== "private") {
    throw new Error("Podman host-local inference requires a private IPC namespace.");
  }
  const command = normalizedArguments(input.command ?? [], "Inference command arguments");
  const model =
    input.service === "ollama"
      ? normalizeHostLocalOllamaModelRef(input.model)
      : exactText(input.model, /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$/u, "Inference model");
  if (typeof input.requireToolCalling !== "boolean") {
    throw new Error("Inference tool-calling requirement must be a boolean.");
  }
  const endpoint = Object.freeze({
    host: HOST_LOCAL_INFERENCE_SANDBOX_HOST,
    port: hostPort,
    networkName,
    networkId: network.id,
    networkGatewayIp: network.gatewayIp,
    ...(input.networkListenerIp ? { networkListenerIp: input.networkListenerIp } : {}),
    networkAuthoritySha256: network.authoritySha256,
  });
  const canonical = {
    service: input.service,
    containerName,
    containerPort,
    imageRef,
    gpuDevices,
    environment,
    ollamaContextLength,
    mounts,
    sharedMemory,
    ipc,
    command,
    probeImageRef,
    endpoint,
    model,
    requireToolCalling: input.requireToolCalling,
    transactionId: writer.transactionId,
    receiptTargetSha256: writer.targetSha256,
    priorState,
    engineBindingSha256,
  };
  const spec: ManagedSpec = {
    ...canonical,
    specSha256: digest(canonical),
    launchSha256: "",
  };
  return Object.freeze({
    ...spec,
    launchSha256: launchArgumentsSha256(translatedRunArguments(spec, authority)),
  });
}

function managedAuthorityDigest(input: {
  readonly service: "ollama" | "nim" | "vllm";
  readonly endpoint: HostLocalInferenceEndpointAuthority;
  readonly name: string;
  readonly imageRef: string;
  readonly probeImageRef: string;
  readonly specSha256: string;
  readonly gpuDevices: readonly string[];
  readonly model: string;
  readonly requireToolCalling: boolean;
  readonly transactionId: string;
  readonly receiptTargetSha256: string;
  readonly priorState: "absent" | "running" | "stopped";
  readonly engineBindingSha256: string;
}): string {
  return digest({
    providerId: PROVIDER_ID,
    service: input.service,
    endpoint: input.endpoint,
    name: input.name,
    imageRef: input.imageRef,
    probeImageRef: input.probeImageRef,
    specSha256: input.specSha256,
    gpu: { vendor: "nvidia", devices: input.gpuDevices },
    inference: {
      protocol: "openai-chat-completions",
      model: input.model,
      toolCallingRequired: input.requireToolCalling,
    },
    publication: {
      transactionId: input.transactionId,
      targetSha256: input.receiptTargetSha256,
      priorState: input.priorState,
    },
    engineBindingSha256: input.engineBindingSha256,
  });
}

function managedSpecAuthorityDigest(spec: ManagedSpec): string {
  return managedAuthorityDigest({
    service: spec.service,
    endpoint: spec.endpoint,
    name: spec.containerName,
    imageRef: spec.imageRef,
    probeImageRef: spec.probeImageRef,
    specSha256: spec.specSha256,
    gpuDevices: spec.gpuDevices,
    model: spec.model,
    requireToolCalling: spec.requireToolCalling,
    transactionId: spec.transactionId,
    receiptTargetSha256: spec.receiptTargetSha256,
    priorState: spec.priorState,
    engineBindingSha256: spec.engineBindingSha256,
  });
}

function managedReceiptAuthorityDigest(receipt: HostLocalInferenceReceipt): string {
  if (
    receipt.runtime.kind !== "container" ||
    (receipt.service !== "ollama" && receipt.service !== "nim" && receipt.service !== "vllm") ||
    receipt.inference === undefined ||
    receipt.publication === undefined ||
    !("devices" in receipt.runtime.gpu)
  ) {
    throw new Error("Podman managed inference authority requires a container receipt.");
  }
  return managedAuthorityDigest({
    service: receipt.service,
    endpoint: receipt.endpoint,
    name: receipt.runtime.name,
    imageRef: receipt.runtime.imageRef,
    probeImageRef: receipt.runtime.probeImageRef,
    specSha256: receipt.runtime.specSha256,
    gpuDevices: receipt.runtime.gpu.devices,
    model: receipt.inference.model,
    requireToolCalling: receipt.inference.toolCallingRequired,
    transactionId: receipt.publication.transactionId,
    receiptTargetSha256: receipt.publication.targetSha256,
    priorState:
      receipt.publication.priorState === "absent" ||
      receipt.publication.priorState === "running" ||
      receipt.publication.priorState === "stopped"
        ? receipt.publication.priorState
        : (() => {
            throw new Error("Podman managed receipt has invalid prior-state authority.");
          })(),
    engineBindingSha256: receipt.engineAuthority.bindingSha256,
  });
}

function managedSpecProbeParent(spec: ManagedSpec): ProbeParentAuthority {
  return Object.freeze({
    transactionId: spec.transactionId,
    receiptTargetSha256: spec.receiptTargetSha256,
    parentAuthoritySha256: managedSpecAuthorityDigest(spec),
  });
}

function receiptProbeParent(receipt: HostLocalInferenceReceipt): ProbeParentAuthority {
  if (receipt.publication === undefined) {
    throw new Error("Podman inference probe requires exact publication authority.");
  }
  return Object.freeze({
    transactionId: receipt.publication.transactionId,
    receiptTargetSha256: receipt.publication.targetSha256,
    parentAuthoritySha256:
      receipt.service === "ollama" && receipt.runtime.kind === "host"
        ? ollamaRouteAuthority(receipt).receiptSha256
        : managedReceiptAuthorityDigest(receipt),
  });
}

function ollamaQualificationProbeParent(input: {
  readonly engineAuthority: PersistedEngineAuthority;
  readonly endpoint: HostLocalInferenceProofEndpointAuthority;
  readonly inference: HostLocalInferenceProofAuthority;
  readonly publication: HostLocalInferencePublicationAuthority;
  readonly runtime: Omit<OllamaHostRuntimeAuthority, "modelDigest">;
}): ProbeParentAuthority {
  return Object.freeze({
    transactionId: input.publication.transactionId,
    receiptTargetSha256: input.publication.targetSha256,
    parentAuthoritySha256: digest({
      schemaVersion: 2,
      providerId: PROVIDER_ID,
      service: "ollama",
      engineAuthority: input.engineAuthority,
      endpoint: input.endpoint,
      inference: input.inference,
      publication: input.publication,
      runtime: input.runtime,
    }),
  });
}

function parseLabels(value: unknown): Readonly<Record<string, string>> {
  const source = record(value, "Podman inference labels");
  const result: Record<string, string> = Object.create(null);
  for (const [key, candidate] of Object.entries(source)) {
    if (typeof candidate !== "string" || CONTROL_CHARACTERS.test(candidate)) {
      throw new Error(`Podman inference label '${key}' is invalid.`);
    }
    result[key] = candidate;
  }
  return Object.freeze(result);
}

function exactStringArray(value: unknown, label: string, maximum = 512): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is invalid or exceeds its item limit.`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (
        typeof entry !== "string" ||
        entry.includes("\0") ||
        Buffer.byteLength(entry, "utf8") > 16 * 1024
      ) {
        throw new Error(`${label}[${String(index)}] is invalid.`);
      }
      return entry;
    }),
  );
}

function inspectedCreateArguments(value: unknown): readonly string[] {
  const command = exactStringArray(value, "Podman inference create command");
  const runIndex = command.indexOf("run");
  if (runIndex < 0) {
    throw new Error("Podman inference inspection lacks its exact create command.");
  }
  return Object.freeze(command.slice(runIndex));
}

function inspectedEnvironmentNames(value: unknown): readonly string[] {
  return Object.freeze(
    exactStringArray(value ?? [], "Podman inference environment", 1024)
      .map((entry) => entry.slice(0, Math.max(0, entry.indexOf("="))))
      .filter((name) => ENVIRONMENT_NAME.test(name))
      .sort(),
  );
}

function inspectedOllamaContextLength(value: unknown): number | null {
  const entries = exactStringArray(value ?? [], "Podman inference environment", 1024).filter(
    (entry) => entry.startsWith("OLLAMA_CONTEXT_LENGTH="),
  );
  if (entries.length === 0) return null;
  if (entries.length !== 1) {
    throw new Error("Podman managed Ollama context length authority is ambiguous.");
  }
  const parsed = Number(entries[0]!.slice("OLLAMA_CONTEXT_LENGTH=".length));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_048_576) {
    throw new Error("Podman managed Ollama context length authority is invalid.");
  }
  return parsed;
}

function inspectedPortBindings(value: unknown): readonly string[] {
  const bindings = record(value, "Podman inference port bindings");
  const normalized: string[] = [];
  for (const [containerPort, rawEntries] of Object.entries(bindings)) {
    if (!/^\d{1,5}\/tcp$/u.test(containerPort) || !Array.isArray(rawEntries)) {
      throw new Error("Podman inference port bindings are invalid.");
    }
    for (const rawEntry of rawEntries) {
      const entry = record(rawEntry, "Podman inference port binding");
      const hostIp = exactText(entry.HostIp, /\S+/u, "Podman inference listener address");
      if (!isIPv4(hostIp)) throw new Error("Podman inference listener address is invalid.");
      const hostPort = exactPort(
        typeof entry.HostPort === "string" ? Number(entry.HostPort) : entry.HostPort,
        "Podman inference listener port",
      );
      normalized.push(`${hostIp}:${String(hostPort)}:${containerPort}`);
    }
  }
  return Object.freeze(normalized.sort());
}

function inspectContainer(engine: ContainerEngine, runtimeId: string): ManagedContainer {
  const output = requireSuccess(
    "container inspection",
    engine.capture(["container", "inspect", runtimeId], PROBE_TIMEOUT_MS),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Podman inference container inspection returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Podman inference inspection must identify exactly one container.");
  }
  const entry = record(parsed[0], "Podman inference inspection entry");
  const config = record(entry.Config, "Podman inference inspection configuration");
  const state = record(entry.State, "Podman inference inspection state");
  const hostConfig = record(entry.HostConfig, "Podman inference host configuration");
  const restartPolicy = record(hostConfig.RestartPolicy, "Podman inference restart configuration");
  const networkSettings = record(entry.NetworkSettings, "Podman inference network settings");
  const networks = record(networkSettings.Networks, "Podman inference network attachments");
  const networkEntries = Object.entries(networks);
  if (networkEntries.length !== 1) {
    throw new Error("Podman inference runtime must have one exact network attachment.");
  }
  const [networkName, rawNetwork] = networkEntries[0] ?? [];
  const attachedNetwork = record(rawNetwork, "Podman inference network attachment");
  if (typeof state.Running !== "boolean") {
    throw new Error("Podman inference inspection must report a boolean running state.");
  }
  return Object.freeze({
    runtimeId: exactContainerId(entry.Id),
    name: exactText(entry.Name, SAFE_NAME, "Podman inference container name"),
    imageRef: normalizeHostLocalInferenceImageRef(entry.ImageName ?? config.Image),
    labels: parseLabels(config.Labels),
    running: state.Running,
    status: exactText(state.Status, SAFE_NAME, "Podman inference container state").toLowerCase(),
    createArguments: inspectedCreateArguments(config.CreateCommand),
    environmentNames: inspectedEnvironmentNames(config.Env),
    ollamaContextLength: inspectedOllamaContextLength(config.Env),
    ipcMode: exactText(hostConfig.IpcMode, SAFE_NAME, "Podman inference IPC mode"),
    networkId: exactText(
      attachedNetwork.NetworkID ?? attachedNetwork.NetworkId,
      FULL_NETWORK_ID,
      "Podman inference attached network identity",
    ),
    networkName: exactNetworkName(networkName, "Podman inference attached network name"),
    portBindings: inspectedPortBindings(hostConfig.PortBindings),
    restartPolicy: exactText(restartPolicy.Name, SAFE_NAME, "Podman inference restart policy"),
    sharedMemoryBytes: (() => {
      if (!Number.isSafeInteger(hostConfig.ShmSize) || Number(hostConfig.ShmSize) < 1) {
        throw new Error("Podman inference shared-memory authority is invalid.");
      }
      return Number(hostConfig.ShmSize);
    })(),
  });
}

function parseProbeContainerInspection(output: string): ProbeContainer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Podman inference probe inspection returned unreadable JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Podman inference probe inspection must identify exactly one container.");
  }
  const entry = record(parsed[0], "Podman inference probe inspection entry");
  const config = record(entry.Config, "Podman inference probe configuration");
  const state = record(entry.State, "Podman inference probe state");
  const hostConfig = record(entry.HostConfig, "Podman inference probe host configuration");
  const restartPolicy = record(
    hostConfig.RestartPolicy,
    "Podman inference probe restart configuration",
  );
  const networkSettings = record(entry.NetworkSettings, "Podman inference probe network settings");
  const networks = record(networkSettings.Networks, "Podman inference probe networks");
  const networkEntries = Object.entries(networks);
  if (networkEntries.length !== 1) {
    throw new Error("Podman inference probe must have one exact network attachment.");
  }
  const [networkName, rawNetwork] = networkEntries[0] ?? [];
  const attachedNetwork = record(rawNetwork, "Podman inference probe network attachment");
  if (typeof state.Running !== "boolean") {
    throw new Error("Podman inference probe inspection lacks running state authority.");
  }
  if (
    !Number.isSafeInteger(state.ExitCode) ||
    Number(state.ExitCode) < 0 ||
    Number(state.ExitCode) > 255
  ) {
    throw new Error("Podman inference probe inspection lacks exact exit-code authority.");
  }
  if (!Array.isArray(entry.Mounts)) {
    throw new Error("Podman inference probe inspection lacks mount authority.");
  }
  return Object.freeze({
    runtimeId: exactContainerId(entry.Id),
    name: exactText(entry.Name, SAFE_NAME, "Podman inference probe name"),
    imageRef: normalizeHostLocalInferenceImageRef(entry.ImageName ?? config.Image),
    labels: parseLabels(config.Labels),
    running: state.Running,
    status: exactText(state.Status, SAFE_NAME, "Podman inference probe state").toLowerCase(),
    exitCode: Number(state.ExitCode),
    createArguments: inspectedCreateArguments(config.CreateCommand),
    environmentNames: inspectedEnvironmentNames(config.Env),
    ipcMode: exactText(hostConfig.IpcMode, SAFE_NAME, "Podman inference probe IPC mode"),
    networkId: exactText(
      attachedNetwork.NetworkID ?? attachedNetwork.NetworkId,
      FULL_NETWORK_ID,
      "Podman inference probe network identity",
    ),
    networkName: exactNetworkName(networkName, "Podman inference probe network name"),
    portBindings: inspectedPortBindings(hostConfig.PortBindings),
    restartPolicy: exactText(
      restartPolicy.Name,
      /^(?:no|)$/u,
      "Podman inference probe restart policy",
    ),
    mounts: Object.freeze([...entry.Mounts]),
  });
}

function inspectProbeContainer(
  engine: ContainerEngine,
  runtimeId: string,
  maxAttempts = 1,
  beforeAttempt: () => void = () => undefined,
): ProbeContainer {
  const args = ["container", "inspect", runtimeId] as const;
  beforeAttempt();
  let result = engine.capture(args, PROBE_TIMEOUT_MS);
  for (let attempt = 1; attempt < maxAttempts && commandTimedOut(result); attempt += 1) {
    beforeAttempt();
    result = engine.capture(args, PROBE_TIMEOUT_MS);
  }
  return parseProbeContainerInspection(requireSuccess("probe container inspection", result));
}

function exactContainerExists(engine: ContainerEngine, runtimeId: string): boolean {
  const result = engine.capture(["container", "exists", runtimeId], PROBE_TIMEOUT_MS);
  if (result.error) {
    throw new Error(
      `Podman inference container existence check failed: ${commandEvidence(result)}`,
    );
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Podman inference container existence check failed: ${commandEvidence(result)}`);
}

function parseContainerLookup(output: string, containerName: string): string | null {
  const rows = output
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error(`Podman inference name '${containerName}' resolved to multiple containers.`);
  }
  const fields = rows[0]?.split("\t") ?? [];
  if (fields.length !== 2 || fields[1] !== containerName) {
    throw new Error(`Podman inference name '${containerName}' resolved to another identity.`);
  }
  return exactContainerId(fields[0]);
}

function containerLookupArgs(containerName: string): readonly string[] {
  return Object.freeze([
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `name=^${containerName}$`,
    "--format",
    "{{.ID}}\t{{.Names}}",
  ]);
}

function lookupContainerId(engine: ContainerEngine, containerName: string): string | null {
  return parseContainerLookup(
    requireSuccess(
      "container lookup",
      engine.capture(containerLookupArgs(containerName), PROBE_TIMEOUT_MS),
    ),
    containerName,
  );
}

function requireManagedIdentity(
  container: ManagedContainer,
  expected: {
    readonly runtimeId: string;
    readonly name: string;
    readonly imageRef: string;
    readonly service: "ollama" | "nim" | "vllm";
    readonly specSha256: string;
    readonly authoritySha256: string;
    readonly transactionId: string;
    readonly receiptTargetSha256: string;
    readonly priorState: "absent" | "running" | "stopped";
    readonly endpoint: HostLocalInferenceProofEndpointAuthority;
    readonly launchSha256: string;
  },
  exactControlledLabels = true,
): ManagedContainer {
  const expectedLabels: Readonly<Record<string, string>> = Object.freeze({
    [PODMAN_INFERENCE_MANAGED_LABEL]: "true",
    [PODMAN_INFERENCE_PROVIDER_LABEL]: PROVIDER_ID,
    [PODMAN_INFERENCE_SERVICE_LABEL]: expected.service,
    [PODMAN_INFERENCE_SPEC_LABEL]: expected.specSha256,
    [PODMAN_INFERENCE_AUTHORITY_LABEL]: expected.authoritySha256,
    [PODMAN_INFERENCE_TRANSACTION_LABEL]: expected.transactionId,
    [PODMAN_INFERENCE_RECEIPT_TARGET_LABEL]: expected.receiptTargetSha256,
    [PODMAN_INFERENCE_PRIOR_STATE_LABEL]: expected.priorState,
  });
  const actualControlledLabels = Object.fromEntries(
    Object.entries(container.labels).filter(([key]) =>
      key.startsWith(PODMAN_INFERENCE_LABEL_PREFIX),
    ),
  );
  const expectedLabelKeys = Object.keys(expectedLabels).sort();
  const actualLabelKeys = Object.keys(actualControlledLabels).sort();
  if (
    container.runtimeId !== expected.runtimeId ||
    container.name !== expected.name ||
    container.imageRef !== expected.imageRef ||
    (exactControlledLabels && actualLabelKeys.join("\n") !== expectedLabelKeys.join("\n")) ||
    expectedLabelKeys.some((key) => actualControlledLabels[key] !== expectedLabels[key])
  ) {
    throw new Error("Podman inference container does not match its exact managed authority.");
  }
  requireLaunchIdentity(container, expected.endpoint, expected.launchSha256);
  return container;
}

function requireSpecIdentity(container: ManagedContainer, spec: ManagedSpec): ManagedContainer {
  return requireManagedIdentity(container, {
    runtimeId: container.runtimeId,
    name: spec.containerName,
    imageRef: spec.imageRef,
    service: spec.service,
    specSha256: spec.specSha256,
    authoritySha256: managedSpecAuthorityDigest(spec),
    transactionId: spec.transactionId,
    receiptTargetSha256: spec.receiptTargetSha256,
    priorState: spec.priorState,
    endpoint: spec.endpoint,
    launchSha256: spec.launchSha256,
  });
}

function requireAcknowledgedSpecCleanupIdentity(
  container: ManagedContainer,
  spec: ManagedSpec,
  runtimeId: string,
): ManagedContainer {
  return requireManagedIdentity(
    container,
    {
      runtimeId,
      name: spec.containerName,
      imageRef: spec.imageRef,
      service: spec.service,
      specSha256: spec.specSha256,
      authoritySha256: managedSpecAuthorityDigest(spec),
      transactionId: spec.transactionId,
      receiptTargetSha256: spec.receiptTargetSha256,
      priorState: spec.priorState,
      endpoint: spec.endpoint,
      launchSha256: spec.launchSha256,
    },
    false,
  );
}

function requireReceiptIdentity(
  container: ManagedContainer,
  receipt: HostLocalInferenceReceipt,
): ManagedContainer {
  if (
    receipt.runtime.kind !== "container" ||
    (receipt.service !== "ollama" && receipt.service !== "nim" && receipt.service !== "vllm")
  ) {
    throw new Error("Podman managed inference requires a container receipt.");
  }
  return requireManagedIdentity(container, {
    runtimeId: receipt.runtime.runtimeId,
    name: receipt.runtime.name,
    imageRef: receipt.runtime.imageRef,
    service: receipt.service,
    specSha256: receipt.runtime.specSha256,
    authoritySha256: managedReceiptAuthorityDigest(receipt),
    transactionId: exactText(
      receipt.publication?.transactionId,
      SHA256,
      "Podman inference transaction identity",
    ),
    receiptTargetSha256: exactText(
      receipt.publication?.targetSha256,
      SHA256,
      "Podman inference receipt target identity",
    ),
    priorState:
      receipt.publication?.priorState === "absent" ||
      receipt.publication?.priorState === "running" ||
      receipt.publication?.priorState === "stopped"
        ? receipt.publication.priorState
        : (() => {
            throw new Error("Podman managed receipt has invalid prior-state authority.");
          })(),
    endpoint: requireProofEndpoint(receipt.endpoint),
    launchSha256: exactText(
      receipt.runtime.launchSha256,
      SHA256,
      "Podman inference launch authority",
    ),
  });
}

/** Inspect one exact published Ollama runtime without creating a lifecycle operation. */
export function inspectPodmanPublishedOllamaReadinessRuntime(options: {
  readonly engine: PodmanContainerEngine;
  readonly persistedEngineAuthority: PersistedEngineAuthority;
  readonly serializedReceipt: string;
  readonly assertCurrent: () => void;
}): HostLocalManagedInferenceInspection {
  const receipt = parseHostLocalInferenceReceipt(options.serializedReceipt);
  if (
    serializeHostLocalInferenceReceipt(receipt) !== options.serializedReceipt ||
    receipt.providerId !== PROVIDER_ID ||
    receipt.service !== "ollama" ||
    receipt.runtime.kind !== "container" ||
    receipt.inference === undefined ||
    receipt.publication === undefined ||
    !("devices" in receipt.runtime.gpu)
  ) {
    throw new Error("Podman published readiness requires an exact Ollama container receipt.");
  }
  if (
    serializePersistedEngineAuthority(options.persistedEngineAuthority) !==
    serializePersistedEngineAuthority(receipt.engineAuthority)
  ) {
    throw new Error("Podman published readiness engine authority changed.");
  }
  if (
    options.persistedEngineAuthority.providerId !== PROVIDER_ID ||
    options.persistedEngineAuthority.operation !== "host-local-inference" ||
    options.persistedEngineAuthority.engineId !== PROVIDER_ID ||
    options.engine.operation !== options.persistedEngineAuthority.operation ||
    options.engine.engineId !== options.persistedEngineAuthority.engineId
  ) {
    throw new Error("Podman published readiness engine authority is invalid.");
  }
  options.assertCurrent();
  let inspected: ManagedContainer | undefined;
  let failure: unknown;
  try {
    inspected = requireReceiptIdentity(
      inspectContainer(options.engine, receipt.runtime.runtimeId),
      receipt,
    );
  } catch (error) {
    failure = error;
  }
  options.assertCurrent();
  if (failure !== undefined) throw failure;
  return Object.freeze({ running: inspected!.running, receipt });
}

function receiptFor(
  authority: PersistedEngineAuthority,
  spec: ManagedSpec,
  runtimeId: string,
  modelDigest?: string,
): HostLocalInferenceReceipt {
  return normalizeHostLocalInferenceReceipt({
    schemaVersion: 2,
    providerId: PROVIDER_ID,
    service: spec.service,
    engineAuthority: authority,
    endpoint: spec.endpoint,
    inference: {
      protocol: "openai-chat-completions",
      model: spec.model,
      toolCallingRequired: spec.requireToolCalling,
    },
    publication: {
      transactionId: spec.transactionId,
      targetSha256: spec.receiptTargetSha256,
      priorState: spec.priorState,
    },
    runtime: {
      kind: "container",
      runtimeId,
      name: spec.containerName,
      imageRef: spec.imageRef,
      probeImageRef: spec.probeImageRef,
      specSha256: spec.specSha256,
      launchSha256: spec.launchSha256,
      ...(spec.service === "ollama"
        ? {
            modelDigest: exactText(
              modelDigest,
              SHA256_DIGEST,
              "Podman managed Ollama model digest",
            ),
          }
        : {}),
      gpu: { vendor: "nvidia", devices: spec.gpuDevices },
    },
  });
}

function runArguments(spec: ManagedSpec): readonly string[] {
  const listenerIp = spec.endpoint.networkListenerIp ?? spec.endpoint.networkGatewayIp;
  const args = [
    "run",
    "--detach",
    "--pull=never",
    "--init",
    "--restart",
    "unless-stopped",
    "--name",
    spec.containerName,
    "--label",
    `${PODMAN_INFERENCE_MANAGED_LABEL}=true`,
    "--label",
    `${PODMAN_INFERENCE_PROVIDER_LABEL}=${PROVIDER_ID}`,
    "--label",
    `${PODMAN_INFERENCE_SERVICE_LABEL}=${spec.service}`,
    "--label",
    `${PODMAN_INFERENCE_SPEC_LABEL}=${spec.specSha256}`,
    "--label",
    `${PODMAN_INFERENCE_AUTHORITY_LABEL}=${managedSpecAuthorityDigest(spec)}`,
    "--label",
    `${PODMAN_INFERENCE_TRANSACTION_LABEL}=${spec.transactionId}`,
    "--label",
    `${PODMAN_INFERENCE_RECEIPT_TARGET_LABEL}=${spec.receiptTargetSha256}`,
    "--label",
    `${PODMAN_INFERENCE_PRIOR_STATE_LABEL}=${spec.priorState}`,
    "--network",
    spec.endpoint.networkName,
    "--publish",
    `127.0.0.1:${String(spec.endpoint.port)}:${String(spec.containerPort)}`,
    "--publish",
    `${listenerIp}:${String(spec.endpoint.port)}:${String(spec.containerPort)}`,
  ];
  for (const device of spec.gpuDevices) args.push("--device", device);
  for (const name of spec.environment) args.push("--env", name);
  if (spec.ollamaContextLength !== null) {
    args.push("--env", "OLLAMA_CONTEXT_LENGTH");
  }
  args.push("--shm-size", spec.sharedMemory);
  args.push("--ipc", spec.ipc);
  args.push(spec.imageRef, ...spec.command);
  return Object.freeze(args);
}

function translatedRunArguments(
  spec: ManagedSpec,
  authority: PodmanInferenceAuthorityReceipt,
): readonly string[] {
  return translatePodmanLocalInferenceArgs(runArguments(spec), authority, {
    allowedPublishAddresses: [spec.endpoint.networkListenerIp ?? spec.endpoint.networkGatewayIp],
  });
}

function launchArgumentsSha256(args: readonly string[]): string {
  return digest({ arguments: args });
}

function repeatedOptionValues(args: readonly string[], option: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== option) continue;
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Podman inference launch lacks ${option} value.`);
    values.push(value);
    index += 1;
  }
  return Object.freeze(values);
}

function sharedMemoryBytes(value: string): number {
  const match = /^([1-9][0-9]{0,11})([kmgt]?)(?:b)?$/iu.exec(value);
  if (!match) throw new Error("Podman inference shared-memory launch value is invalid.");
  const amount = Number(match[1]);
  const factor =
    match[2]?.toLowerCase() === "k"
      ? 1024
      : match[2]?.toLowerCase() === "m"
        ? 1024 ** 2
        : match[2]?.toLowerCase() === "g"
          ? 1024 ** 3
          : match[2]?.toLowerCase() === "t"
            ? 1024 ** 4
            : 1;
  const bytes = amount * factor;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error("Podman inference shared-memory launch value is invalid.");
  }
  return bytes;
}

function requireLaunchIdentity(
  container: ManagedContainer,
  endpoint: HostLocalInferenceProofEndpointAuthority,
  launchSha256: string,
): void {
  if (launchArgumentsSha256(container.createArguments) !== launchSha256) {
    throw new Error("Podman inference runtime launch arguments drifted from durable authority.");
  }
  const publishes = repeatedOptionValues(container.createArguments, "--publish");
  const expectedListeners = [
    "127.0.0.1",
    endpoint.networkListenerIp ?? endpoint.networkGatewayIp,
  ].sort();
  const parsedPublishes = publishes.map((mapping) => {
    const fields = mapping.split(":");
    if (fields.length !== 3) throw new Error("Podman inference launch publish mapping is invalid.");
    return { address: fields[0] ?? "", hostPort: fields[1] ?? "", containerPort: fields[2] ?? "" };
  });
  if (
    parsedPublishes.length !== 2 ||
    parsedPublishes
      .map(({ address }) => address)
      .sort()
      .join("\n") !== expectedListeners.join("\n") ||
    parsedPublishes.some(({ hostPort }) => hostPort !== String(endpoint.port)) ||
    new Set(parsedPublishes.map(({ containerPort }) => containerPort)).size !== 1
  ) {
    throw new Error("Podman inference runtime listener authority drifted from its receipt.");
  }
  const expectedPortBindings = parsedPublishes
    .map(({ address, hostPort, containerPort }) => `${address}:${hostPort}:${containerPort}/tcp`)
    .sort();
  const controlledEnvironmentNames = new Set(["NGC_API_KEY", "NIM_NGC_API_KEY", "VLLM_API_KEY"]);
  const expectedEnvironmentNames = repeatedOptionValues(container.createArguments, "--env")
    .filter((name) => controlledEnvironmentNames.has(name))
    .sort();
  const actualEnvironmentNames = container.environmentNames
    .filter((name) => controlledEnvironmentNames.has(name))
    .sort();
  const ollamaContextArguments = repeatedOptionValues(container.createArguments, "--env").filter(
    (name) => name === "OLLAMA_CONTEXT_LENGTH",
  );
  const expectedOllamaContextLength =
    ollamaContextArguments.length === 0
      ? null
      : ollamaContextArguments.length === 1
        ? 64_000
        : Number.NaN;
  const sharedMemory = repeatedOptionValues(container.createArguments, "--shm-size");
  if (
    container.networkId !== endpoint.networkId ||
    container.networkName !== endpoint.networkName ||
    container.portBindings.join("\n") !== expectedPortBindings.join("\n") ||
    container.restartPolicy !== "unless-stopped" ||
    container.ipcMode !== "private" ||
    expectedEnvironmentNames.join("\n") !== actualEnvironmentNames.join("\n") ||
    container.ollamaContextLength !== expectedOllamaContextLength ||
    sharedMemory.length !== 1 ||
    container.sharedMemoryBytes !== sharedMemoryBytes(sharedMemory[0] ?? "")
  ) {
    throw new Error("Podman inference runtime configuration drifted from exact launch authority.");
  }
}

interface ProbeParentAuthority {
  readonly transactionId: string;
  readonly receiptTargetSha256: string;
  readonly parentAuthoritySha256: string;
}

class PodmanInferenceIndeterminateCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanInferenceIndeterminateCleanupError";
  }
}

class PodmanInferenceCapturedFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanInferenceCapturedFailureError";
  }
}

function emitProviderFailure(
  phase: PodmanInferenceFailureEvidence["phase"],
  message: string,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
): void {
  try {
    onFailureEvidence(
      Object.freeze({ providerId: PROVIDER_ID, phase, message: errorEvidence(redactor, message) }),
    );
  } catch (error) {
    throw new PodmanInferenceEvidenceCaptureError(errorEvidence(redactor, error));
  }
}

function createProbeSpec(
  service: "ollama" | "nim" | "vllm",
  phase: "ready" | "gpu" | "inference",
  endpoint: HostLocalInferenceProofEndpointAuthority,
  probeImageRef: string,
  parent: ProbeParentAuthority,
  request: readonly string[],
  authority: PodmanInferenceAuthorityReceipt,
  legacyRequests: readonly (readonly string[])[] = [],
): ProbeSpecSet {
  const curlMaxTimeSeconds =
    phase === "inference" ? INFERENCE_PROBE_CURL_MAX_TIME_SECONDS : PROBE_CURL_MAX_TIME_SECONDS;
  const normalizedImage = normalizeHostLocalInferenceImageRef(probeImageRef);
  const normalizedRequest = normalizedArguments(request, "Podman inference probe request");
  const transactionId = exactText(
    parent.transactionId,
    SHA256,
    "Podman inference probe transaction",
  );
  const receiptTargetSha256 = exactText(
    parent.receiptTargetSha256,
    SHA256,
    "Podman inference probe receipt target",
  );
  const parentAuthoritySha256 = exactText(
    parent.parentAuthoritySha256,
    SHA256,
    "Podman inference probe parent authority",
  );
  // Temporary compatibility for retained probes from pre-fix PR #9906 qualification runs.
  // Remove when no preserved qualification host can resume a pre-timeout probe.
  const legacyCanonical = (legacyRequest: readonly string[]) =>
    Object.freeze({
      providerId: PROVIDER_ID,
      service,
      phase,
      endpoint,
      probeImageRef: normalizedImage,
      transactionId,
      receiptTargetSha256,
      parentAuthoritySha256,
      request: legacyRequest,
    });
  const canonical = Object.freeze({
    providerId: PROVIDER_ID,
    service,
    phase,
    endpoint,
    probeImageRef: normalizedImage,
    transactionId,
    receiptTargetSha256,
    parentAuthoritySha256,
    curlMaxTimeSeconds,
    request: normalizedRequest,
  });
  const buildSpec = (
    identity: typeof canonical | ReturnType<typeof legacyCanonical>,
  ): ProbeSpec => {
    const maxTimeSeconds =
      "curlMaxTimeSeconds" in identity ? identity.curlMaxTimeSeconds : PROBE_CURL_MAX_TIME_SECONDS;
    const specSha256 = digest(identity);
    const name = `nemoclaw-inference-probe-${phase}-${specSha256.slice(0, 16)}`;
    const source = Object.freeze([
      "run",
      "--detach",
      "--pull=never",
      "--name",
      name,
      "--label",
      `${PODMAN_INFERENCE_PROBE_MANAGED_LABEL}=true`,
      "--label",
      `${PODMAN_INFERENCE_PROVIDER_LABEL}=${PROVIDER_ID}`,
      "--label",
      `${PODMAN_INFERENCE_SERVICE_LABEL}=${service}`,
      "--label",
      `${PODMAN_INFERENCE_AUTHORITY_LABEL}=${identity.parentAuthoritySha256}`,
      "--label",
      `${PODMAN_INFERENCE_TRANSACTION_LABEL}=${identity.transactionId}`,
      "--label",
      `${PODMAN_INFERENCE_RECEIPT_TARGET_LABEL}=${identity.receiptTargetSha256}`,
      "--label",
      `${PODMAN_INFERENCE_PROBE_PHASE_LABEL}=${phase}`,
      "--label",
      `${PODMAN_INFERENCE_PROBE_SPEC_LABEL}=${specSha256}`,
      "--network",
      endpoint.networkName,
      "--read-only",
      "--ipc",
      "private",
      normalizedImage,
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "3",
      "--max-time",
      String(maxTimeSeconds),
      ...identity.request,
    ]);
    return Object.freeze({
      service,
      phase,
      endpoint,
      probeImageRef: normalizedImage,
      transactionId: identity.transactionId,
      receiptTargetSha256: identity.receiptTargetSha256,
      parentAuthoritySha256: identity.parentAuthoritySha256,
      request: identity.request,
      name,
      specSha256,
      launchArguments: translatePodmanLocalInferenceArgs(source, authority),
    });
  };
  const normalizedLegacyRequests = legacyRequests.map((legacyRequest) =>
    normalizedArguments(legacyRequest, "Podman inference legacy probe request"),
  );
  const legacy = [
    buildSpec(legacyCanonical(normalizedRequest)),
    ...normalizedLegacyRequests.flatMap((legacyRequest) => [
      buildSpec(Object.freeze({ ...canonical, request: legacyRequest })),
      buildSpec(legacyCanonical(legacyRequest)),
    ]),
  ].filter(
    (spec, index, specs) =>
      spec.name !== buildSpec(canonical).name &&
      specs.findIndex((candidate) => candidate.name === spec.name) === index,
  );
  return Object.freeze({
    current: buildSpec(canonical),
    legacy: Object.freeze(legacy),
  });
}

function probeLabels(spec: ProbeSpec): Readonly<Record<string, string>> {
  return Object.freeze({
    [PODMAN_INFERENCE_PROBE_MANAGED_LABEL]: "true",
    [PODMAN_INFERENCE_PROVIDER_LABEL]: PROVIDER_ID,
    [PODMAN_INFERENCE_SERVICE_LABEL]: spec.service,
    [PODMAN_INFERENCE_AUTHORITY_LABEL]: spec.parentAuthoritySha256,
    [PODMAN_INFERENCE_TRANSACTION_LABEL]: spec.transactionId,
    [PODMAN_INFERENCE_RECEIPT_TARGET_LABEL]: spec.receiptTargetSha256,
    [PODMAN_INFERENCE_PROBE_PHASE_LABEL]: spec.phase,
    [PODMAN_INFERENCE_PROBE_SPEC_LABEL]: spec.specSha256,
  });
}

function requireProbeIdentity(
  container: ProbeContainer,
  spec: ProbeSpec,
  expectedRuntimeId: string,
): ProbeContainer {
  if (container.runtimeId !== expectedRuntimeId) {
    throw new Error(
      "Podman inference probe inspect returned a container ID other than the queried full container ID.",
    );
  }
  const expectedLabels = probeLabels(spec);
  const actualControlledLabels = Object.fromEntries(
    Object.entries(container.labels).filter(([key]) =>
      key.startsWith(PODMAN_INFERENCE_LABEL_PREFIX),
    ),
  );
  const actualLabelKeys = Object.keys(actualControlledLabels).sort();
  const expectedLabelKeys = Object.keys(expectedLabels).sort();
  const controlledEnvironmentNames = new Set(["NGC_API_KEY", "NIM_NGC_API_KEY", "VLLM_API_KEY"]);
  if (
    container.name !== spec.name ||
    container.imageRef !== spec.probeImageRef ||
    actualLabelKeys.join("\n") !== expectedLabelKeys.join("\n") ||
    expectedLabelKeys.some((key) => actualControlledLabels[key] !== expectedLabels[key]) ||
    digest({ arguments: container.createArguments }) !==
      digest({ arguments: spec.launchArguments }) ||
    container.networkName !== spec.endpoint.networkName ||
    container.networkId !== spec.endpoint.networkId ||
    container.portBindings.length !== 0 ||
    container.restartPolicy !== "no" ||
    container.ipcMode !== "private" ||
    container.mounts.length !== 0 ||
    container.environmentNames.some((name) => controlledEnvironmentNames.has(name))
  ) {
    throw new Error("Podman inference probe does not match its exact disposable authority.");
  }
  return container;
}

type ProbeCleanupObservation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly container: ProbeContainer }
  | { readonly kind: "retry" };

function defaultProbeCleanupSleep(milliseconds: number): void {
  if (milliseconds > 0) {
    Atomics.wait(PROBE_CLEANUP_SLEEP_BUFFER, 0, 0, milliseconds);
  }
}

function monotonicProbeCleanupNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function probeCleanupClock(now: () => number): () => number {
  let previous: number | undefined;
  return () => {
    const current = now();
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      (previous !== undefined && current < previous)
    ) {
      throw new Error("Podman inference probe cleanup clock is invalid.");
    }
    previous = current;
    return current;
  };
}

function observeProbeCleanup(
  engine: ContainerEngine,
  runtimeId: string,
  spec: ProbeSpec,
  assertAuthority: () => void,
  mode: "owned" | "retained-legacy",
): ProbeCleanupObservation {
  assertAuthority();
  const exists = engine.capture(["container", "exists", runtimeId], PROBE_TIMEOUT_MS);
  if (commandTimedOut(exists)) return Object.freeze({ kind: "retry" });
  if (exists.error || (exists.status !== 0 && exists.status !== 1)) {
    throw new Error(`Podman inference probe existence check failed: ${commandEvidence(exists)}`);
  }

  let current: ProbeContainer | null = null;
  if (exists.status === 0) {
    assertAuthority();
    const inspection = engine.capture(["container", "inspect", runtimeId], PROBE_TIMEOUT_MS);
    if (commandTimedOut(inspection)) return Object.freeze({ kind: "retry" });
    current = requireProbeIdentity(
      parseProbeContainerInspection(requireSuccess("probe container inspection", inspection)),
      spec,
      runtimeId,
    );
    if (current.running || !AT_REST_STATES.has(current.status)) {
      throw new Error(
        mode === "retained-legacy"
          ? "retained legacy probe is not in an exact at-rest state"
          : "Podman inference probe cleanup requires an exact at-rest identity.",
      );
    }
  }

  assertAuthority();
  const lookup = engine.capture(containerLookupArgs(spec.name), PROBE_TIMEOUT_MS);
  if (commandTimedOut(lookup)) return Object.freeze({ kind: "retry" });
  const nameId = parseContainerLookup(requireSuccess("container lookup", lookup), spec.name);
  if (current !== null) {
    if (nameId !== null && nameId !== runtimeId) {
      throw new Error("Podman inference probe name is owned by another container.");
    }
    return Object.freeze({ kind: "present", container: current });
  }
  if (nameId === null) return Object.freeze({ kind: "absent" });
  if (nameId === runtimeId) return Object.freeze({ kind: "retry" });
  throw new Error("Podman inference probe name was reused by another container.");
}

function settleProbeBeforeRemoval(
  engine: ContainerEngine,
  runtimeId: string,
  spec: ProbeSpec,
  assertAuthority: () => void,
  mode: "owned" | "retained-legacy",
): ProbeContainer | null {
  for (let attempt = 0; attempt < POST_CREATE_PROBE_INSPECT_MAX_ATTEMPTS; attempt += 1) {
    const observation = observeProbeCleanup(engine, runtimeId, spec, assertAuthority, mode);
    if (observation.kind === "present") return observation.container;
    if (observation.kind === "absent") {
      assertAuthority();
      return null;
    }
  }
  throw new Error("Podman inference probe cleanup could not establish its pre-remove state.");
}

function settleProbeRemoval(
  engine: ContainerEngine,
  runtimeId: string,
  spec: ProbeSpec,
  assertAuthority: () => void,
  mode: "owned" | "retained-legacy",
  timing: PodmanProbeCleanupTiming,
): void {
  const now = probeCleanupClock(timing.now ?? monotonicProbeCleanupNow);
  const sleep = timing.sleep ?? defaultProbeCleanupSleep;
  const startedAt = now();
  const deadline = startedAt + PROBE_CLEANUP_SETTLEMENT_TIMEOUT_MS;
  if (!Number.isFinite(deadline)) {
    throw new Error("Podman inference probe cleanup deadline is invalid.");
  }
  for (;;) {
    const observation = observeProbeCleanup(engine, runtimeId, spec, assertAuthority, mode);
    const observedAt = now();
    if (observedAt > deadline) {
      throw new Error("Podman inference probe removal exceeded its settlement deadline.");
    }
    if (observation.kind === "absent") {
      assertAuthority();
      if (now() > deadline) {
        throw new Error("Podman inference probe removal exceeded its settlement deadline.");
      }
      return;
    }
    const remaining = deadline - observedAt;
    if (remaining <= 0) {
      throw new Error("Podman inference probe removal did not settle into exact absence.");
    }
    const delay = Math.min(PROBE_CLEANUP_SETTLEMENT_INTERVAL_MS, remaining);
    sleep(delay);
    if (now() <= observedAt) {
      throw new Error("Podman inference probe cleanup clock did not advance.");
    }
  }
}

function cleanupExactProbe(
  engine: ContainerEngine,
  assertAuthority: () => void,
  container: Pick<ProbeContainer, "runtimeId">,
  spec: ProbeSpec,
  phase: PodmanInferenceFailureEvidence["phase"],
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
  timing: PodmanProbeCleanupTiming,
  mode: "owned" | "retained-legacy" = "owned",
): void {
  let current: ProbeContainer | null;
  try {
    current = settleProbeBeforeRemoval(engine, container.runtimeId, spec, assertAuthority, mode);
  } catch (error) {
    emitProviderFailure(
      phase,
      `Podman inference probe cleanup lost exact identity: ${errorEvidence(redactor, error)}`,
      onFailureEvidence,
      redactor,
    );
    throw new PodmanInferenceIndeterminateCleanupError(
      `Podman inference probe cleanup lost exact identity: ${errorEvidence(redactor, error)}`,
    );
  }
  if (current === null) return;
  assertAuthority();
  const removal = engine.capture(
    mode === "owned" ? ["rm", "--force", current.runtimeId] : ["rm", current.runtimeId],
    MUTATION_TIMEOUT_MS,
  );
  if (removal.status !== 0 || removal.error) {
    emitProviderFailure(
      phase,
      `Podman inference probe removal returned exit ${String(removal.status)}: ${redactedCommandEvidence(redactor, removal)}`,
      onFailureEvidence,
      redactor,
    );
  }
  try {
    settleProbeRemoval(engine, current.runtimeId, spec, assertAuthority, mode, timing);
  } catch (error) {
    emitProviderFailure(
      phase,
      `Podman inference probe cleanup is indeterminate: ${errorEvidence(redactor, error)}`,
      onFailureEvidence,
      redactor,
    );
    throw new PodmanInferenceIndeterminateCleanupError(
      `Podman inference probe cleanup is indeterminate: ${errorEvidence(redactor, error)}`,
    );
  }
}

function executeExactProbe(
  engine: ContainerEngine,
  authority: PodmanInferenceAuthorityReceipt,
  assertAuthority: () => void,
  specs: ProbeSpecSet,
  timeoutMs: number,
  validateOutput: (output: string) => void,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
  timing: PodmanProbeCleanupTiming,
  publishedResumeTiming?: PodmanPublishedResumeTimingRecorder,
): string {
  const spec = specs.current;
  const phase = spec.phase;
  const measureCleanupCurrentness = <T>(operation: () => T): T =>
    publishedResumeTiming
      ? publishedResumeTiming.measure("cleanupCurrentness", operation)
      : operation();
  const captureFailure = (error: unknown) =>
    emitProviderFailure(phase, errorEvidence(redactor, error), onFailureEvidence, redactor);
  measureCleanupCurrentness(assertAuthority);
  for (const legacy of specs.legacy) {
    let legacyId: string | null;
    try {
      legacyId = lookupContainerId(engine, legacy.name);
    } catch (error) {
      captureFailure(error);
      throw new PodmanInferenceIndeterminateCleanupError(
        "Podman inference legacy probe name lookup is indeterminate.",
      );
    }
    if (legacyId !== null) {
      measureCleanupCurrentness(() =>
        cleanupExactProbe(
          engine,
          assertAuthority,
          { runtimeId: legacyId },
          legacy,
          phase,
          onFailureEvidence,
          redactor,
          timing,
          "retained-legacy",
        ),
      );
      measureCleanupCurrentness(assertAuthority);
    }
  }
  let existingId: string | null;
  try {
    existingId = lookupContainerId(engine, spec.name);
  } catch (error) {
    captureFailure(error);
    throw new PodmanInferenceIndeterminateCleanupError(
      "Podman inference probe name lookup is indeterminate.",
    );
  }
  if (existingId !== null) {
    try {
      requireProbeIdentity(inspectProbeContainer(engine, existingId), spec, existingId);
    } catch (error) {
      captureFailure(error);
      throw new PodmanInferenceIndeterminateCleanupError(
        "Podman inference probe name is occupied by unproven authority.",
      );
    }
    captureFailure(
      "Podman inference probe name is already occupied without durable exact-ID cleanup authority.",
    );
    throw new PodmanInferenceIndeterminateCleanupError(
      "Podman inference probe residue requires exact durable cleanup authority.",
    );
  }

  measureCleanupCurrentness(assertAuthority);
  const run = engine.capture(spec.launchArguments, PROBE_TIMEOUT_MS);
  if (run.status !== 0 || run.error) {
    captureFailure(
      `Podman inference probe create returned exit ${String(run.status)}: ${redactedCommandEvidence(redactor, run)}`,
    );
  }
  let runtimeId: string | null = null;
  let acknowledgementFailure: Error | null = null;
  if (run.status === 0 && !run.error) {
    try {
      runtimeId = exactContainerId(run.stdout.trim());
    } catch (error) {
      acknowledgementFailure =
        error instanceof Error ? error : new Error(errorEvidence(redactor, error));
    }
  }
  if (runtimeId === null) {
    try {
      runtimeId = lookupContainerId(engine, spec.name);
    } catch (error) {
      captureFailure(error);
      throw new PodmanInferenceIndeterminateCleanupError(
        "Podman inference probe identity lookup failed after create.",
      );
    }
  }
  if (runtimeId === null) {
    throw new Error(
      `Podman inference probe create left exact absence: ${redactedCommandEvidence(redactor, run)}`,
    );
  }
  let container: ProbeContainer;
  try {
    container = requireProbeIdentity(
      inspectProbeContainer(engine, runtimeId, POST_CREATE_PROBE_INSPECT_MAX_ATTEMPTS),
      spec,
      runtimeId,
    );
  } catch (error) {
    captureFailure(error);
    throw new PodmanInferenceIndeterminateCleanupError(
      "Podman inference probe identity is indeterminate after create.",
    );
  }
  let failure: Error | null = null;
  if (acknowledgementFailure !== null) {
    captureFailure(acknowledgementFailure);
    failure = acknowledgementFailure;
  }

  const wait = engine.capture(["wait", container.runtimeId], timeoutMs);
  if (wait.status !== 0 || wait.error) {
    failure = new Error(
      `Podman inference probe wait failed: ${redactedCommandEvidence(redactor, wait)}`,
    );
    captureFailure(failure);
    try {
      container = requireProbeIdentity(
        inspectProbeContainer(engine, container.runtimeId),
        spec,
        container.runtimeId,
      );
      if (container.running) {
        const stop = engine.capture(
          ["stop", "--time", String(STOP_GRACE_SECONDS), container.runtimeId],
          MUTATION_TIMEOUT_MS,
        );
        if (stop.status !== 0 || stop.error) {
          captureFailure(
            `Podman inference probe stop returned exit ${String(stop.status)}: ${redactedCommandEvidence(redactor, stop)}`,
          );
        }
        container = requireProbeIdentity(
          inspectProbeContainer(engine, container.runtimeId),
          spec,
          container.runtimeId,
        );
        if (container.running || !AT_REST_STATES.has(container.status)) {
          throw new Error("probe stop did not prove an exact at-rest state");
        }
      }
    } catch (error) {
      captureFailure(error);
      throw new PodmanInferenceIndeterminateCleanupError(
        "Podman inference probe timeout cleanup could not prove an at-rest identity.",
      );
    }
  } else {
    const exitText = wait.stdout.trim();
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(exitText) || Number(exitText) > 255) {
      failure = new Error("Podman inference probe wait returned malformed exit authority.");
      captureFailure(failure);
    }
    try {
      container = requireProbeIdentity(
        inspectProbeContainer(engine, container.runtimeId),
        spec,
        container.runtimeId,
      );
      if (
        container.running ||
        !AT_REST_STATES.has(container.status) ||
        (failure === null && container.exitCode !== Number(exitText))
      ) {
        throw new Error("Podman inference probe exit state differs from wait authority");
      }
    } catch (error) {
      captureFailure(error);
      throw new PodmanInferenceIndeterminateCleanupError(
        "Podman inference probe exit identity is indeterminate.",
      );
    }
  }

  const logs = engine.capture(["logs", container.runtimeId], PROBE_TIMEOUT_MS);
  if (logs.status !== 0 || logs.error) {
    const logsFailure = new Error(
      `Podman inference probe logs failed: ${redactedCommandEvidence(redactor, logs)}`,
    );
    if (failure === null) failure = logsFailure;
    captureFailure(logsFailure);
  }
  if (Buffer.byteLength(logs.stdout, "utf8") > 1024 * 1024) {
    const oversized = new Error("Podman inference probe response exceeds its 1 MiB limit.");
    if (failure === null) failure = oversized;
    captureFailure(oversized);
  }
  if (container.exitCode !== 0) {
    const exitFailure = new Error(
      `Podman inference probe exited ${String(container.exitCode)}: ${redactEvidence(redactor, logs.stderr || logs.stdout)}`,
    );
    if (failure === null) failure = exitFailure;
    captureFailure(exitFailure);
  }
  if (failure === null) {
    try {
      validateOutput(logs.stdout);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      captureFailure(failure);
    }
  }
  measureCleanupCurrentness(() =>
    cleanupExactProbe(
      engine,
      assertAuthority,
      container,
      spec,
      phase,
      onFailureEvidence,
      redactor,
      timing,
    ),
  );
  try {
    measureCleanupCurrentness(assertAuthority);
  } catch (error) {
    captureFailure(error);
    throw new PodmanInferenceCapturedFailureError(errorEvidence(redactor, error));
  }
  if (failure !== null) {
    throw new PodmanInferenceCapturedFailureError(errorEvidence(redactor, failure));
  }
  return logs.stdout;
}

function parseJsonResponse(output: string, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${label} returned unreadable JSON.`);
  }
  return record(parsed, `${label} response`);
}

function probeOllamaReady(
  engine: ContainerEngine,
  authorityReceipt: PodmanInferenceAuthorityReceipt,
  assertAuthority: () => void,
  endpoint: HostLocalInferenceProofEndpointAuthority,
  probeImageRef: string,
  parent: ProbeParentAuthority,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
  timing: PodmanProbeCleanupTiming,
): void {
  const spec = createProbeSpec(
    "ollama",
    "ready",
    endpoint,
    probeImageRef,
    parent,
    [
      `http://${endpoint.networkListenerIp ?? endpoint.networkGatewayIp}:${String(endpoint.port)}/api/tags`,
    ],
    authorityReceipt,
  );
  executeExactProbe(
    engine,
    authorityReceipt,
    assertAuthority,
    spec,
    READY_PROBE_TIMEOUT_MS,
    (output) => {
      const response = parseJsonResponse(output, "Ollama Ready probe");
      if (!Array.isArray(response.models)) {
        throw new Error("Ollama Ready probe did not return its provider-native model list.");
      }
    },
    onFailureEvidence,
    redactor,
    timing,
  );
}

function probeOllamaAcceleration(
  engine: ContainerEngine,
  authorityReceipt: PodmanInferenceAuthorityReceipt,
  assertAuthority: () => void,
  endpoint: HostLocalInferenceProofEndpointAuthority,
  probeImageRef: string,
  model: string,
  acceleration: HostLocalOllamaAccelerationAuthority,
  expectedModelDigest: string | null,
  parent: ProbeParentAuthority,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
  timing: PodmanProbeCleanupTiming,
  publishedResumeTiming?: PodmanPublishedResumeTimingRecorder,
): OllamaModelPlacementAuthority {
  const spec = createProbeSpec(
    "ollama",
    "gpu",
    endpoint,
    probeImageRef,
    parent,
    [
      `http://${endpoint.networkListenerIp ?? endpoint.networkGatewayIp}:${String(endpoint.port)}/api/ps`,
    ],
    authorityReceipt,
  );
  let observed: OllamaModelPlacementAuthority | null = null;
  executeExactProbe(
    engine,
    authorityReceipt,
    assertAuthority,
    spec,
    PROBE_TIMEOUT_MS,
    (output) => {
      const response = parseJsonResponse(output, "Ollama acceleration probe");
      if (!Array.isArray(response.models) || response.models.length > 1024) {
        throw new Error(
          "Ollama acceleration probe did not return a bounded provider-native model list.",
        );
      }
      // Ollama may expose tag aliases in this list. Both provider-native
      // identity fields must equal the selected receipt model literally.
      const exactModels = response.models
        .map((entry) => record(entry, "Ollama running model"))
        .filter((entry) => entry.name === model && entry.model === model);
      if (exactModels.length !== 1) {
        throw new Error("Ollama acceleration probe did not return exactly one exact-model entry.");
      }
      const size = exactModels[0]?.size;
      const sizeVram = exactModels[0]?.size_vram;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
        throw new Error("Ollama acceleration probe returned malformed size authority.");
      }
      if (typeof sizeVram !== "number" || !Number.isSafeInteger(sizeVram) || sizeVram < 0) {
        throw new Error("Ollama acceleration probe returned malformed size_vram authority.");
      }
      const digestValue = exactModels[0]?.digest;
      if (typeof digestValue !== "string" || !SHA256.test(digestValue)) {
        throw new Error("Ollama acceleration probe returned malformed model digest authority.");
      }
      const modelDigest = `sha256:${digestValue}`;
      if (!SHA256_DIGEST.test(modelDigest)) {
        throw new Error("Ollama acceleration probe returned malformed model digest authority.");
      }
      if (expectedModelDigest !== null && modelDigest !== expectedModelDigest) {
        throw new Error("Ollama acceleration probe detected model digest drift.");
      }
      if (acceleration === "nvidia-gpu") {
        if (
          authorityReceipt.cdiDevices.length === 0 ||
          authorityReceipt.cdiDevices.some((device) => !device.startsWith("nvidia.com/gpu="))
        ) {
          throw new Error("Ollama acceleration probe lacks exact NVIDIA CDI authority.");
        }
        if (sizeVram !== size) {
          throw new Error(
            "Ollama acceleration probe did not prove complete provider-native NVIDIA GPU offload.",
          );
        }
      }
      if (acceleration === "cpu" && sizeVram !== 0) {
        throw new Error("Ollama acceleration probe detected GPU use for a CPU route.");
      }
      observed = Object.freeze({ modelDigest });
    },
    onFailureEvidence,
    redactor,
    timing,
    publishedResumeTiming,
  );
  if (observed === null) {
    throw new Error("Ollama acceleration probe did not return placement authority.");
  }
  return observed;
}

function probeManagedReady(
  engine: ContainerEngine,
  authorityReceipt: PodmanInferenceAuthorityReceipt,
  assertAuthority: () => void,
  spec: Pick<ManagedSpec, "endpoint" | "probeImageRef" | "service">,
  parent: ProbeParentAuthority,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
  timing: PodmanProbeCleanupTiming,
  publishedResumeTiming?: PodmanPublishedResumeTimingRecorder,
): void {
  const healthPath =
    spec.service === "ollama"
      ? "/api/tags"
      : spec.service === "nim"
        ? "/v1/health/ready"
        : "/health";
  const probe = createProbeSpec(
    spec.service,
    "ready",
    spec.endpoint,
    spec.probeImageRef,
    parent,
    [
      "--retry",
      "120",
      "--retry-delay",
      "2",
      "--retry-max-time",
      "220",
      "--retry-connrefused",
      `http://${spec.endpoint.networkListenerIp ?? spec.endpoint.networkGatewayIp}:${String(spec.endpoint.port)}${healthPath}`,
    ],
    authorityReceipt,
  );
  executeExactProbe(
    engine,
    authorityReceipt,
    assertAuthority,
    probe,
    READY_PROBE_TIMEOUT_MS,
    () => undefined,
    onFailureEvidence,
    redactor,
    timing,
    publishedResumeTiming,
  );
}

function proveManagedGpu(
  engine: ContainerEngine,
  authority: () => void,
  runtimeId: string,
  requestedDevices: readonly string[],
): void {
  authority();
  const output = requireSuccess(
    "managed GPU proof",
    engine.capture(
      ["exec", runtimeId, "nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"],
      PROBE_TIMEOUT_MS,
    ),
  );
  authority();
  const identities = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (identities.length === 0 || identities.some((value) => !GPU_UUID.test(value))) {
    throw new Error("Podman managed GPU proof did not return exact NVIDIA GPU identities.");
  }
  const requestedIds = requestedDevices.map((device) => device.slice("nvidia.com/gpu=".length));
  if (
    new Set(identities).size !== identities.length ||
    identities.length !== requestedIds.length ||
    [...identities].sort().join("\n") !== [...requestedIds].sort().join("\n")
  ) {
    throw new Error("Podman managed GPU proof differs from the requested CDI UUID authority.");
  }
}

function pullManagedOllamaModel(
  engine: ContainerEngine,
  authority: () => void,
  runtimeId: string,
  model: string,
): void {
  authority();
  const result = engine.capture(
    ["exec", runtimeId, "ollama", "pull", normalizeHostLocalOllamaModelRef(model)],
    OLLAMA_MODEL_PULL_TIMEOUT_MS,
  );
  requireSuccess("managed Ollama model acquisition", result);
  authority();
}

function probeOpenAiInference(
  engine: ContainerEngine,
  authorityReceipt: PodmanInferenceAuthorityReceipt,
  assertAuthority: () => void,
  endpoint: HostLocalInferenceEndpointAuthority,
  probeImageRef: string,
  model: string,
  requireToolCalling: boolean,
  service: "ollama" | "nim" | "vllm",
  parent: ProbeParentAuthority,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
  timing: PodmanProbeCleanupTiming,
  publishedResumeTiming?: PodmanPublishedResumeTimingRecorder,
): void {
  const completionRequest = (maxTokens: number, deterministic: boolean) => ({
    model,
    messages: [{ role: "user", content: "Use the probe tool when it is available." }],
    max_tokens: maxTokens,
    stream: false,
    ...(requireToolCalling
      ? {
          tools: [
            {
              type: "function",
              function: {
                name: "nemoclaw_probe",
                description: "Return one host-local inference proof.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
              },
            },
          ],
          tool_choice: "required",
          ...(deterministic ? { temperature: 0 } : {}),
        }
      : {}),
  });
  const body = JSON.stringify(completionRequest(requireToolCalling ? 4096 : 512, true));
  const proofEndpoint = requireProofEndpoint(endpoint);
  const requestEndpoint = `http://${proofEndpoint.networkListenerIp ?? proofEndpoint.networkGatewayIp}:${String(proofEndpoint.port)}/v1/chat/completions`;
  const requestArguments = (payload: string) => [
    "--header",
    "Content-Type: application/json",
    "--data-binary",
    payload,
    requestEndpoint,
  ];
  const probe = createProbeSpec(
    service,
    "inference",
    proofEndpoint,
    probeImageRef,
    parent,
    requestArguments(body),
    authorityReceipt,
    requireToolCalling ? [requestArguments(JSON.stringify(completionRequest(512, false)))] : [],
  );
  executeExactProbe(
    engine,
    authorityReceipt,
    assertAuthority,
    probe,
    INFERENCE_PROBE_TIMEOUT_MS,
    (output) => {
      const response = parseJsonResponse(output, `${service} inference proof`);
      if (response.model !== model) {
        throw new Error(`${service} inference proof returned a different model identity.`);
      }
      const choices = response.choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const normalizedChoice =
        typeof first === "object" && first !== null ? record(first, "choice") : null;
      if (
        typeof normalizedChoice?.finish_reason !== "string" ||
        normalizedChoice.finish_reason === "length"
      ) {
        throw new Error(`${service} inference proof did not return a complete completion.`);
      }
      const message = normalizedChoice.message;
      const normalizedMessage =
        typeof message === "object" && message !== null
          ? record(message, "inference message")
          : null;
      if (requireToolCalling) {
        const toolCalls = normalizedMessage?.tool_calls;
        const firstToolCall = Array.isArray(toolCalls) ? toolCalls[0] : null;
        const toolFunction =
          typeof firstToolCall === "object" && firstToolCall !== null
            ? record(firstToolCall, "inference tool call").function
            : null;
        const toolName =
          typeof toolFunction === "object" && toolFunction !== null
            ? record(toolFunction, "inference tool function").name
            : null;
        const toolArguments =
          typeof toolFunction === "object" && toolFunction !== null
            ? record(toolFunction, "inference tool function").arguments
            : null;
        let decodedToolArguments: unknown = null;
        if (
          typeof toolArguments === "string" &&
          Buffer.byteLength(toolArguments, "utf8") <= 16 * 1024
        ) {
          try {
            decodedToolArguments = JSON.parse(toolArguments);
          } catch {
            decodedToolArguments = null;
          }
        }
        if (
          toolName !== "nemoclaw_probe" ||
          typeof decodedToolArguments !== "object" ||
          decodedToolArguments === null ||
          Array.isArray(decodedToolArguments) ||
          Object.keys(decodedToolArguments).length !== 0
        ) {
          throw new Error(`${service} inference proof did not return the required tool call.`);
        }
        return;
      }
      if (
        typeof normalizedMessage?.content !== "string" ||
        normalizedMessage.content.trim() === ""
      ) {
        throw new Error(`${service} inference proof did not return generated content.`);
      }
    },
    onFailureEvidence,
    redactor,
    timing,
    publishedResumeTiming,
  );
}

function ollamaRouteAuthority(
  receipt: HostLocalInferenceReceipt,
): HostLocalInferenceRouteAuthority {
  if (receipt.service !== "ollama" || receipt.runtime.kind !== "host") {
    throw new Error("Podman Ollama route authority requires a host-process receipt.");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    providerId: receipt.providerId,
    service: "ollama" as const,
    authorityId: receipt.engineAuthority.authorityId,
    receiptSha256: digest({
      providerId: receipt.providerId,
      service: receipt.service,
      engineAuthority: receipt.engineAuthority,
      endpoint: receipt.endpoint,
      inference: receipt.inference,
      publication: receipt.publication,
      runtime: receipt.runtime,
    }),
  });
}

function requireOllamaRouteAuthority(
  actual: HostLocalInferenceRouteAuthority | null,
  expected: HostLocalInferenceRouteAuthority,
): HostLocalInferenceRouteAuthority {
  if (
    actual?.schemaVersion !== 1 ||
    actual.providerId !== expected.providerId ||
    actual.service !== expected.service ||
    actual.authorityId !== expected.authorityId ||
    actual.receiptSha256 !== expected.receiptSha256
  ) {
    throw new Error("Podman Ollama route does not match its protected provider authority.");
  }
  return actual;
}

function removeExact(
  engine: ContainerEngine,
  container: ManagedContainer,
  requireIdentity: (container: ManagedContainer) => ManagedContainer,
  phase: "rollback" | "cleanup",
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
): void {
  const current = requireIdentity(inspectContainer(engine, container.runtimeId));
  const removal = engine.capture(["rm", "--force", current.runtimeId], MUTATION_TIMEOUT_MS);
  const stillExists = exactContainerExists(engine, current.runtimeId);
  const nameAfter = lookupContainerId(engine, current.name);
  if (stillExists) {
    throw new Error(
      `Podman inference exact cleanup left runtime '${current.runtimeId}' present: ${redactedCommandEvidence(redactor, removal)}`,
    );
  }
  if (nameAfter !== null) {
    throw new Error(
      `Podman inference cleanup found name '${current.name}' reused by '${nameAfter}'.`,
    );
  }
  emitAcknowledgedCommandFailure(
    "Podman inference exact cleanup",
    phase,
    removal,
    onFailureEvidence,
    redactor,
  );
}

function restoreExact(
  engine: ContainerEngine,
  container: ManagedContainer,
  wasRunning: boolean,
  requireIdentity: (container: ManagedContainer) => ManagedContainer,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
): void {
  const current = requireIdentity(inspectContainer(engine, container.runtimeId));
  if (wasRunning) {
    if (current.running) return;
    if (!AT_REST_STATES.has(current.status)) {
      throw new Error("Podman inference rollback found an indeterminate prior runtime state.");
    }
    const start = engine.capture(["start", current.runtimeId], MUTATION_TIMEOUT_MS);
    const restored = requireIdentity(inspectContainer(engine, current.runtimeId));
    if (!restored.running) {
      throw new Error(
        `Podman inference rollback did not restore the prior running runtime: ${redactedCommandEvidence(redactor, start)}`,
      );
    }
    emitAcknowledgedCommandFailure(
      "Podman inference rollback start",
      "rollback",
      start,
      onFailureEvidence,
      redactor,
    );
    return;
  }
  if (current.running) {
    const stop = engine.capture(
      ["stop", "--time", String(STOP_GRACE_SECONDS), current.runtimeId],
      MUTATION_TIMEOUT_MS,
    );
    const stopped = requireIdentity(inspectContainer(engine, current.runtimeId));
    if (stopped.running || !AT_REST_STATES.has(stopped.status)) {
      throw new Error(
        `Podman inference rollback did not restore the prior stopped runtime: ${redactedCommandEvidence(redactor, stop)}`,
      );
    }
    emitAcknowledgedCommandFailure(
      "Podman inference rollback stop",
      "rollback",
      stop,
      onFailureEvidence,
      redactor,
    );
    return;
  }
  if (!AT_REST_STATES.has(current.status)) {
    throw new Error("Podman inference rollback found an indeterminate prior runtime state.");
  }
}

function restoreExisting(
  engine: ContainerEngine,
  container: ManagedContainer,
  wasRunning: boolean,
  spec: ManagedSpec,
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
): void {
  restoreExact(
    engine,
    container,
    wasRunning,
    (candidate) => requireSpecIdentity(candidate, spec),
    onFailureEvidence,
    redactor,
  );
}

function withRollback<T>(
  action: () => T,
  rollback: () => void,
  phase: () => PodmanInferenceFailureEvidence["phase"],
  onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void,
  redactor: PodmanInferenceRedactor,
): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof PublishedInferenceForwardAuthorityError) {
      try {
        rollback();
      } catch (rollbackError) {
        throw new Error(
          `Published inference forward authority changed. Exact prior-runtime restoration also failed: ${errorEvidence(redactor, rollbackError)}`,
        );
      }
      throw error;
    }
    if (error instanceof PodmanInferenceIndeterminateCleanupError) {
      try {
        rollback();
      } catch (rollbackError) {
        throw new Error(
          `${error.message} Exact prior-runtime restoration also failed: ${errorEvidence(redactor, rollbackError)}`,
        );
      }
      throw error;
    }
    if (error instanceof PodmanInferenceEvidenceCaptureError) {
      throw new Error(`Provider failure evidence capture failed before rollback: ${error.message}`);
    }
    if (error instanceof PodmanInferenceCapturedFailureError) {
      try {
        rollback();
      } catch (rollbackError) {
        throw new Error(
          `${error.message} Exact prior-runtime restoration also failed: ${errorEvidence(redactor, rollbackError)}`,
        );
      }
      throw error;
    }
    const failure = errorEvidence(redactor, error);
    try {
      onFailureEvidence(
        Object.freeze({ providerId: PROVIDER_ID, phase: phase(), message: failure }),
      );
    } catch (captureError) {
      throw new Error(
        `${failure} Provider failure evidence capture failed before rollback: ${errorEvidence(redactor, captureError)}`,
      );
    }
    try {
      rollback();
    } catch (rollbackError) {
      throw new Error(
        `${failure} Exact prior-runtime restoration also failed: ${errorEvidence(redactor, rollbackError)}`,
      );
    }
    throw new Error(failure);
  }
}

function createPreparedStartup(options: {
  readonly receipt: HostLocalInferenceReceipt;
  readonly writer: HostLocalInferenceReceiptWriter;
  readonly priorState: HostLocalInferencePriorRuntimeState;
  readonly validate: () => void;
  /** Pure authority validation that must complete before publication can begin. */
  readonly validatePublication?: () => void;
  readonly onCommitValidationFailure: (error: unknown) => void;
  /** First external publication side effect; failures after entry are indeterminate. */
  readonly beforeWrite?: () => void;
  /** The durable receipt already exists and must be verified, not written again. */
  readonly publishedResume?: boolean;
  /** Successful published-resume observation after the final authority assertion. */
  readonly onPublishedResumeFinalized?: () => void;
  readonly rollback: () => "removed" | "restored" | "retained";
  readonly redactor: PodmanInferenceRedactor;
}): HostLocalInferencePreparedStartup {
  let state:
    | "prepared"
    | "validated"
    | "committing"
    | "committed"
    | "rolling-back"
    | "rolled-back"
    | "indeterminate" = "prepared";
  const requireRollbackSafe = (operation: string) => {
    if (state !== "prepared" && state !== "validated") {
      throw new Error(
        `Podman inference startup cannot ${operation} from terminal state '${state}'.`,
      );
    }
  };
  return Object.freeze({
    receipt: options.receipt,
    rollbackPriorState: options.priorState,
    publicationState() {
      if (state === "committed") return "published" as const;
      if (state === "prepared" || state === "validated" || state === "rolled-back") {
        return "unpublished" as const;
      }
      return "indeterminate" as const;
    },
    validateBeforeCommit() {
      requireRollbackSafe("validate before commit");
      state = "prepared";
      try {
        options.validate();
        state = "validated";
        return options.receipt;
      } catch (error) {
        if (error instanceof PodmanInferenceIndeterminateCleanupError) {
          state = "prepared";
          throw error;
        }
        if (error instanceof PodmanInferenceCapturedFailureError) {
          state = "prepared";
          throw error;
        }
        state = "prepared";
        try {
          options.onCommitValidationFailure(error);
        } catch (captureError) {
          state = "indeterminate";
          throw captureError;
        }
        throw error;
      }
    },
    commit() {
      if (options.publishedResume) {
        throw new Error(
          "Podman inference startup must finalize a published resume without rewriting its receipt.",
        );
      }
      if (state !== "validated") {
        throw new Error(
          `Podman inference startup cannot commit without fresh validation from state '${state}'.`,
        );
      }
      try {
        options.validatePublication?.();
      } catch (error) {
        try {
          options.onCommitValidationFailure(error);
        } catch (captureError) {
          state = "indeterminate";
          throw captureError;
        }
        // No external writer or route-authority store has been entered yet, so
        // the exact prior runtime remains rollback-safe.
        throw error;
      }
      state = "committing";
      try {
        options.beforeWrite?.();
        const receipt = writeReceipt(options.writer, options.receipt, options.redactor);
        state = "committed";
        return receipt;
      } catch (error) {
        state = "indeterminate";
        try {
          options.onCommitValidationFailure(error);
        } catch (captureError) {
          throw new Error(
            `${errorEvidence(options.redactor, error)} Publication failure evidence capture also failed: ${errorEvidence(options.redactor, captureError)}`,
          );
        }
        throw error;
      }
    },
    ...(options.publishedResume
      ? {
          finalizePublishedResume(assertPublishedAuthority: () => void) {
            if (state !== "validated") {
              throw new Error(
                `Podman inference startup cannot finalize a published resume without fresh validation from state '${state}'.`,
              );
            }
            try {
              options.validatePublication?.();
              assertPublishedAuthority();
            } catch (error) {
              try {
                options.onCommitValidationFailure(error);
              } catch (captureError) {
                throw new Error(
                  `${errorEvidence(options.redactor, error)} Published-resume failure evidence capture also failed: ${errorEvidence(options.redactor, captureError)}`,
                );
              }
              throw error;
            }
            state = "committed";
            options.onPublishedResumeFinalized?.();
            return options.receipt;
          },
        }
      : {}),
    rollback() {
      requireRollbackSafe("roll back");
      state = "rolling-back";
      try {
        const status = options.rollback();
        state = "rolled-back";
        return Object.freeze({ status, priorState: options.priorState, receipt: options.receipt });
      } catch (error) {
        state = "indeterminate";
        throw error;
      }
    },
  });
}

export function createPodmanHostLocalInferenceRuntime(
  options: PodmanHostLocalInferenceRuntimeOptions,
): HostLocalInferenceRuntime {
  const operationAcceleration = normalizeOperationAcceleration(options.operationAcceleration);
  const operationEnv = Object.freeze(
    Object.assign(
      Object.create(null) as NodeJS.ProcessEnv,
      Object.fromEntries(
        ["NGC_API_KEY", "NIM_NGC_API_KEY"].flatMap((name) => {
          const value = options.env[name];
          return typeof value === "string" ? [[name, value] as const] : [];
        }),
      ),
    ),
  );
  const sensitiveRedactor = operationSensitiveRedactor(
    requireRedactor(options.redactSensitive),
    operationEnv,
  );
  const engine = redactingEngine(options.engine, sensitiveRedactor);
  const {
    authorityStore,
    routeAuthorityStore,
    authority,
    authorityQualification,
    onFailureEvidence,
  } = options;
  const publishedEngineAuthority = options.hermesPortablePublishedEngineAuthority
    ? Object.freeze({
        intent: options.hermesPortablePublishedEngineAuthority.intent,
        creationAuthority: normalizePersistedEngineAuthority(
          options.hermesPortablePublishedEngineAuthority.creationAuthority,
        ),
        serializedReceipt: (() => {
          const supplied = options.hermesPortablePublishedEngineAuthority!.serializedReceipt;
          parseHostLocalInferenceReceipt(supplied);
          return supplied;
        })(),
        assertForwardAuthority:
          options.hermesPortablePublishedEngineAuthority.assertForwardAuthority,
      })
    : undefined;
  const assertBoundEngineTransactionCurrent = (): void => {
    const candidate = options.engine as PodmanContainerEngine & {
      readonly assertAuthority?: () => void;
    };
    if (!publishedEngineAuthority || !candidate.assertAuthority) {
      throw new Error("Podman published inference lacks bound executable and socket currentness.");
    }
    candidate.assertAuthority();
  };
  if (
    publishedEngineAuthority &&
    (publishedEngineAuthority.intent !== "connect-probe-only" ||
      publishedEngineAuthority.creationAuthority.providerId !== PROVIDER_ID ||
      publishedEngineAuthority.creationAuthority.operation !== "host-local-inference" ||
      publishedEngineAuthority.creationAuthority.engineId !== PROVIDER_ID)
  ) {
    throw new Error("Podman published inference has invalid creation engine authority.");
  }
  const probeCleanupTiming = options.probeCleanupTiming ?? Object.freeze({});
  const inspectNetwork = (
    expected: Parameters<typeof inspectProviderNetwork>[2],
  ): PodmanInferenceNetworkAuthority =>
    inspectProviderNetwork(engine, authority, expected, options.externalNetwork);
  if (engine.operation !== "host-local-inference" || engine.engineId !== PROVIDER_ID) {
    throw new Error("Podman host-local inference requires an operation-scoped Podman engine.");
  }
  if (
    !routeAuthorityStore ||
    typeof routeAuthorityStore.load !== "function" ||
    typeof routeAuthorityStore.record !== "function"
  ) {
    throw new Error("Podman host-local inference requires a protected route-authority store.");
  }
  if (typeof onFailureEvidence !== "function") {
    throw new Error("Podman host-local inference requires a provider failure evidence sink.");
  }
  if (
    authority.providerId !== PROVIDER_ID ||
    authority.operation !== "host-local-inference" ||
    authority.engineId !== PROVIDER_ID ||
    authority.authorityId !== engine.authorityId
  ) {
    throw new Error("Podman host-local inference has mismatched provider authority.");
  }

  const requireAccelerationAuthority = (
    refreshed: PodmanInferenceAuthorityReceipt,
  ): PodmanInferenceAuthorityReceipt => {
    if (operationAcceleration === "nvidia-gpu" && refreshed.cdiDevices.length === 0) {
      throw new Error(
        "Podman NVIDIA GPU operation authority requires at least one discovered NVIDIA CDI device.",
      );
    }
    return refreshed;
  };
  requireAccelerationAuthority(authority);

  const assertAuthority = () => {
    requireAccelerationAuthority(
      revalidatePodmanInferenceAuthority(engine, authority, authorityQualification),
    );
  };
  const currentAuthority = () =>
    createPersistedEngineAuthority(PROVIDER_ID, engine, authority.receiptSha256);
  type PublishedRecoveryAuthorityMode = "forward" | "rollback";
  const authorize = (
    recordIfMissing: boolean,
    publishedMode: PublishedRecoveryAuthorityMode = "forward",
  ): PersistedEngineAuthority => {
    assertAuthority();
    if (publishedEngineAuthority) {
      if (recordIfMissing) {
        throw new Error(
          "Podman published inference execution authority cannot create new durable state.",
        );
      }
      if (publishedMode === "forward") {
        try {
          publishedEngineAuthority.assertForwardAuthority();
        } catch {
          throw new PublishedInferenceForwardAuthorityError();
        }
      }
      const persisted = authorityStore.load("host-local-inference");
      if (
        persisted === null ||
        serializePersistedEngineAuthority(persisted) !==
          serializePersistedEngineAuthority(publishedEngineAuthority.creationAuthority)
      ) {
        throw new Error(
          "Podman published inference creation authority differs from its persisted record.",
        );
      }
      if (publishedMode === "forward") {
        try {
          publishedEngineAuthority.assertForwardAuthority();
        } catch {
          throw new PublishedInferenceForwardAuthorityError();
        }
      }
      return persisted;
    }
    const current = currentAuthority();
    const persisted = authorityStore.load("host-local-inference");
    if (persisted === null) {
      if (!recordIfMissing) {
        throw new Error("Podman host-local inference has no persisted engine authority.");
      }
      return requirePersistedEngineAuthority(
        authorityStore.record(current),
        PROVIDER_ID,
        engine,
        authority.receiptSha256,
      );
    }
    return requirePersistedEngineAuthority(persisted, PROVIDER_ID, engine, authority.receiptSha256);
  };
  const assertReceiptExecutionAuthority = (
    publishedMode: PublishedRecoveryAuthorityMode = "forward",
  ): void => {
    if (publishedEngineAuthority) {
      authorize(false, publishedMode);
      return;
    }
    assertAuthority();
  };
  const authorizeReceipt = (
    receipt: HostLocalInferenceReceipt,
    requireRouteAuthority = true,
    publishedMode: PublishedRecoveryAuthorityMode = "forward",
  ): HostLocalInferenceReceipt => {
    const normalized = normalizeHostLocalInferenceReceipt(receipt);
    if (
      publishedEngineAuthority &&
      (normalized.service !== "ollama" ||
        serializeHostLocalInferenceReceipt(normalized) !==
          publishedEngineAuthority.serializedReceipt)
    ) {
      throw new Error(
        "Podman published inference operation differs from its exact recovery receipt.",
      );
    }
    if (normalized.providerId !== PROVIDER_ID) {
      throw new Error("Host-local inference receipt belongs to another runtime provider.");
    }
    if (normalized.runtime.kind === "container" && operationAcceleration !== "nvidia-gpu") {
      throw new Error("Podman managed inference services require NVIDIA GPU operation authority.");
    }
    if (
      normalized.runtime.kind === "host" &&
      normalized.runtime.acceleration !== operationAcceleration
    ) {
      throw new Error("Ollama receipt acceleration differs from its operation authority.");
    }
    if (normalized.endpoint.host !== HOST_LOCAL_INFERENCE_SANDBOX_HOST) {
      throw new Error("Host-local inference receipt does not use the provider's canonical host.");
    }
    const endpoint = requireProofEndpoint(normalized.endpoint);
    const persisted = authorize(false, publishedMode);
    if (publishedEngineAuthority) {
      if (
        serializePersistedEngineAuthority(normalized.engineAuthority) !==
        serializePersistedEngineAuthority(persisted)
      ) {
        throw new Error(
          "Podman published inference receipt differs from its immutable creation authority.",
        );
      }
    } else {
      requirePersistedEngineAuthority(
        normalized.engineAuthority,
        PROVIDER_ID,
        engine,
        authority.receiptSha256,
      );
    }
    if (
      normalized.service === "ollama" &&
      normalized.runtime.kind === "host" &&
      requireRouteAuthority
    ) {
      requireOllamaRouteAuthority(
        routeAuthorityStore.load("ollama"),
        ollamaRouteAuthority(normalized),
      );
    }
    inspectNetwork(endpoint);
    return normalized;
  };
  const inspectReceipt = (
    receipt: HostLocalInferenceReceipt,
    publishedMode: PublishedRecoveryAuthorityMode = "forward",
  ) => {
    const normalized = authorizeReceipt(receipt, true, publishedMode);
    if (
      normalized.runtime.kind !== "container" ||
      (normalized.service !== "ollama" &&
        normalized.service !== "nim" &&
        normalized.service !== "vllm") ||
      normalized.inference === undefined ||
      normalized.publication === undefined ||
      !("devices" in normalized.runtime.gpu)
    ) {
      throw new Error("Podman managed inference requires a container receipt.");
    }
    const container = requireReceiptIdentity(
      inspectContainer(engine, normalized.runtime.runtimeId),
      normalized,
    );
    return { receipt: normalized as ManagedReceipt, container };
  };
  const requirePublishedResumeTransactionCurrent = (
    receipt: HostLocalInferenceReceipt,
  ): ManagedReceipt => {
    if (!publishedEngineAuthority) {
      throw new Error("Podman published inference transaction authority is unavailable.");
    }
    const normalized = normalizeHostLocalInferenceReceipt(receipt);
    if (
      normalized.service !== "ollama" ||
      normalized.runtime.kind !== "container" ||
      normalized.inference === undefined ||
      normalized.publication === undefined ||
      !("devices" in normalized.runtime.gpu) ||
      serializeHostLocalInferenceReceipt(normalized) !== publishedEngineAuthority.serializedReceipt
    ) {
      throw new Error("Podman published inference transaction differs from its exact receipt.");
    }
    try {
      publishedEngineAuthority.assertForwardAuthority();
    } catch {
      throw new PublishedInferenceForwardAuthorityError();
    }
    assertBoundEngineTransactionCurrent();
    const persisted = authorityStore.load("host-local-inference");
    if (
      persisted === null ||
      serializePersistedEngineAuthority(persisted) !==
        serializePersistedEngineAuthority(publishedEngineAuthority.creationAuthority) ||
      serializePersistedEngineAuthority(normalized.engineAuthority) !==
        serializePersistedEngineAuthority(persisted)
    ) {
      throw new Error(
        "Podman published inference transaction differs from its persisted engine authority.",
      );
    }
    return normalized as ManagedReceipt;
  };
  const inspectPublishedResumeTransaction = (
    receipt: HostLocalInferenceReceipt,
  ): { readonly receipt: ManagedReceipt; readonly container: ManagedContainer } => {
    const normalized = requirePublishedResumeTransactionCurrent(receipt);
    inspectNetwork(requireProofEndpoint(normalized.endpoint));
    const container = requireReceiptIdentity(
      inspectContainer(engine, normalized.runtime.runtimeId),
      normalized,
    );
    requirePublishedResumeTransactionCurrent(normalized);
    return Object.freeze({ receipt: normalized as ManagedReceipt, container });
  };
  const validatePublishedResumeReceipt = (
    receipt: HostLocalInferenceReceipt,
    timing: PodmanPublishedResumeTimingRecorder,
  ): HostLocalInferenceReceipt => {
    const inspected = inspectPublishedResumeTransaction(receipt);
    if (!inspected.container.running) {
      throw new Error("Podman published inference validation requires a running runtime.");
    }
    let gpuFailure: unknown;
    try {
      timing.measure("gpuIdentity", () =>
        proveManagedGpu(
          engine,
          () => requirePublishedResumeTransactionCurrent(inspected.receipt),
          inspected.container.runtimeId,
          inspected.receipt.runtime.gpu.devices,
        ),
      );
    } catch (error) {
      gpuFailure = error;
    }
    timing.measure("cleanupCurrentness", () => {
      const current = inspectPublishedResumeTransaction(inspected.receipt);
      if (!current.container.running) {
        throw new Error("Podman published inference runtime stopped before final currentness.");
      }
    });
    if (gpuFailure !== undefined) {
      throw gpuFailure;
    }
    return inspected.receipt;
  };
  const validateReceipt = (
    receipt: HostLocalInferenceReceipt,
    requireRouteAuthority = true,
    publishedResumeTiming?: PodmanPublishedResumeTimingRecorder,
  ): HostLocalInferenceReceipt => {
    const normalized = authorizeReceipt(receipt, requireRouteAuthority);
    const endpoint = requireProofEndpoint(normalized.endpoint);
    const assertReceiptAuthority = () => {
      assertReceiptExecutionAuthority();
      inspectNetwork(endpoint);
    };
    if (normalized.inference === undefined) {
      throw new Error("Podman inference receipt lacks real-inference authority.");
    }
    if (normalized.runtime.kind === "host") {
      probeOllamaReady(
        engine,
        authority,
        assertReceiptAuthority,
        endpoint,
        normalized.runtime.probeImageRef,
        receiptProbeParent(normalized),
        onFailureEvidence,
        sensitiveRedactor,
        probeCleanupTiming,
      );
      assertAuthority();
      probeOpenAiInference(
        engine,
        authority,
        assertReceiptAuthority,
        endpoint,
        normalized.runtime.probeImageRef,
        normalized.inference.model,
        normalized.inference.toolCallingRequired,
        "ollama",
        receiptProbeParent(normalized),
        onFailureEvidence,
        sensitiveRedactor,
        probeCleanupTiming,
      );
      probeOllamaAcceleration(
        engine,
        authority,
        assertReceiptAuthority,
        endpoint,
        normalized.runtime.probeImageRef,
        normalized.inference.model,
        normalized.runtime.acceleration,
        normalized.runtime.modelDigest,
        receiptProbeParent(normalized),
        onFailureEvidence,
        sensitiveRedactor,
        probeCleanupTiming,
      );
      assertReceiptAuthority();
      return normalized;
    }
    const inspected = inspectReceipt(normalized);
    if (!inspected.container.running) {
      throw new Error("Podman managed inference validation requires a running runtime.");
    }
    const service = inspected.receipt.service;
    if (service !== "ollama" && service !== "nim" && service !== "vllm") {
      throw new Error("Podman managed inference validation has an unsupported service.");
    }
    const spec = {
      endpoint: requireProofEndpoint(inspected.receipt.endpoint),
      probeImageRef: inspected.receipt.runtime.probeImageRef,
      service,
      model: normalized.inference.model,
      requireToolCalling: normalized.inference.toolCallingRequired,
    } as const;
    const measurePublishedResumeStage = <T>(
      stage: PodmanPublishedResumeTimingStage,
      operation: () => T,
    ): T => (publishedResumeTiming ? publishedResumeTiming.measure(stage, operation) : operation());
    measurePublishedResumeStage("managedReady", () =>
      probeManagedReady(
        engine,
        authority,
        assertReceiptAuthority,
        spec,
        receiptProbeParent(inspected.receipt),
        onFailureEvidence,
        sensitiveRedactor,
        probeCleanupTiming,
        publishedResumeTiming,
      ),
    );
    if (!("devices" in inspected.receipt.runtime.gpu)) {
      throw new Error("Podman managed inference receipt lacks exact CDI device authority.");
    }
    measurePublishedResumeStage("gpuIdentity", () =>
      proveManagedGpu(
        engine,
        assertReceiptAuthority,
        inspected.container.runtimeId,
        inspected.receipt.runtime.gpu.devices,
      ),
    );
    // A published resume remains in flight until its caller proves the final
    // route and dependent forwards, finalizes this prepared startup, and
    // releases the registry transaction. Creation and explicit deep
    // validation retain the generated/tool and model-placement attestation.
    measurePublishedResumeStage("generatedProof", () =>
      probeOpenAiInference(
        engine,
        authority,
        assertReceiptAuthority,
        spec.endpoint,
        spec.probeImageRef,
        spec.model,
        spec.requireToolCalling,
        spec.service,
        receiptProbeParent(inspected.receipt),
        onFailureEvidence,
        sensitiveRedactor,
        probeCleanupTiming,
        publishedResumeTiming,
      ),
    );
    if (service === "ollama") {
      measurePublishedResumeStage("modelPlacement", () =>
        probeOllamaAcceleration(
          engine,
          authority,
          assertReceiptAuthority,
          spec.endpoint,
          spec.probeImageRef,
          spec.model,
          "nvidia-gpu",
          inspected.receipt.runtime.modelDigest ?? null,
          receiptProbeParent(inspected.receipt),
          onFailureEvidence,
          sensitiveRedactor,
          probeCleanupTiming,
          publishedResumeTiming,
        ),
      );
    }
    measurePublishedResumeStage("cleanupCurrentness", assertReceiptAuthority);
    return normalized;
  };

  const start = (
    input: HostLocalManagedInferenceInput,
    writerValue: HostLocalInferenceReceiptWriter,
    recoveryOnly: boolean,
  ): HostLocalInferencePreparedStartup => {
    if (operationAcceleration !== "nvidia-gpu") {
      throw new Error("Podman managed inference services require NVIDIA GPU operation authority.");
    }
    const writer = requireWriter(writerValue);
    const persisted = authorize(true);
    const network = inspectNetwork(input);
    const containerName = exactText(input.containerName, SAFE_NAME, "Inference container name");
    const existingId = lookupContainerId(engine, containerName);
    if (existingId === null && recoveryOnly) {
      throw new Error("Podman inference recovery found no exact managed runtime.");
    }
    if (existingId !== null && !recoveryOnly) {
      throw new Error(
        "Podman inference start found an existing runtime; exact same-transaction recovery is required.",
      );
    }
    let priorState: "absent" | "running" | "stopped" = "absent";
    if (existingId !== null) {
      const priorLabel = inspectContainer(engine, existingId).labels[
        PODMAN_INFERENCE_PRIOR_STATE_LABEL
      ];
      if (priorLabel !== "absent" && priorLabel !== "running" && priorLabel !== "stopped") {
        throw new Error("Podman inference runtime lacks exact prior-state authority.");
      }
      priorState = priorLabel;
    }
    const spec = normalizeManagedSpec(input, writer, authority, network, priorState);
    const assertSpecAuthority = () => {
      assertAuthority();
      inspectNetwork(spec.endpoint);
    };
    const operationEnvironment = managedOperationEnvironment(spec, operationEnv);
    requireSecretFreeCommand(spec.command, operationEnvironment, sensitiveRedactor);
    let phase: PodmanInferenceFailureEvidence["phase"] = "start";
    if (existingId !== null) {
      let container = requireSpecIdentity(inspectContainer(engine, existingId), spec);
      const rollbackExisting = () => {
        if (spec.priorState === "absent") {
          removeExact(
            engine,
            container,
            (candidate) => requireSpecIdentity(candidate, spec),
            "rollback",
            onFailureEvidence,
            sensitiveRedactor,
          );
          return "removed" as const;
        }
        restoreExisting(
          engine,
          container,
          spec.priorState === "running",
          spec,
          onFailureEvidence,
          sensitiveRedactor,
        );
        return "restored" as const;
      };
      const receipt = withRollback(
        () => {
          if (!container.running) {
            if (!AT_REST_STATES.has(container.status)) {
              throw new Error(
                `Podman inference container state '${container.status}' cannot be started.`,
              );
            }
            phase = "start";
            assertSpecAuthority();
            const result = engine.capture(["start", container.runtimeId], MUTATION_TIMEOUT_MS);
            container = requireSpecIdentity(inspectContainer(engine, container.runtimeId), spec);
            if (!container.running) {
              throw new Error(
                `Podman inference start did not leave the exact runtime running: ${redactedCommandEvidence(sensitiveRedactor, result)}`,
              );
            }
            emitAcknowledgedCommandFailure(
              "Podman inference container start",
              "start",
              result,
              onFailureEvidence,
              sensitiveRedactor,
            );
          }
          phase = "ready";
          probeManagedReady(
            engine,
            authority,
            assertSpecAuthority,
            spec,
            managedSpecProbeParent(spec),
            onFailureEvidence,
            sensitiveRedactor,
            probeCleanupTiming,
          );
          if (spec.service === "ollama") {
            pullManagedOllamaModel(engine, assertSpecAuthority, container.runtimeId, spec.model);
          }
          phase = "gpu";
          proveManagedGpu(engine, assertSpecAuthority, container.runtimeId, spec.gpuDevices);
          phase = "inference";
          probeOpenAiInference(
            engine,
            authority,
            assertSpecAuthority,
            spec.endpoint,
            spec.probeImageRef,
            spec.model,
            spec.requireToolCalling,
            spec.service,
            managedSpecProbeParent(spec),
            onFailureEvidence,
            sensitiveRedactor,
            probeCleanupTiming,
          );
          const placement =
            spec.service === "ollama"
              ? probeOllamaAcceleration(
                  engine,
                  authority,
                  assertSpecAuthority,
                  spec.endpoint,
                  spec.probeImageRef,
                  spec.model,
                  "nvidia-gpu",
                  null,
                  managedSpecProbeParent(spec),
                  onFailureEvidence,
                  sensitiveRedactor,
                  probeCleanupTiming,
                )
              : null;
          assertSpecAuthority();
          return receiptFor(persisted, spec, container.runtimeId, placement?.modelDigest);
        },
        () => {
          rollbackExisting();
        },
        () => phase,
        onFailureEvidence,
        sensitiveRedactor,
      );
      return createPreparedStartup({
        receipt,
        writer,
        priorState: spec.priorState,
        validate: () => {
          validateReceipt(receipt);
        },
        onCommitValidationFailure: (error) => {
          onFailureEvidence(
            Object.freeze({
              providerId: PROVIDER_ID,
              phase: "commit",
              message: errorEvidence(sensitiveRedactor, error),
            }),
          );
        },
        validatePublication: assertSpecAuthority,
        rollback: rollbackExisting,
        redactor: sensitiveRedactor,
      });
    }

    let created: ManagedContainer | null = null;
    let acknowledgedCleanupCandidate: ManagedContainer | null = null;
    const receipt = withRollback(
      () => {
        phase = "start";
        assertSpecAuthority();
        const translatedArgs = translatedRunArguments(spec, authority);
        const result =
          spec.environment.length === 0 && spec.ollamaContextLength === null
            ? engine.capture(translatedArgs, MUTATION_TIMEOUT_MS)
            : (engine.captureWithEnvironment?.(
                translatedArgs,
                operationEnvironment,
                MUTATION_TIMEOUT_MS,
              ) ??
              (() => {
                throw new Error(
                  "Podman managed inference requires operation-scoped environment capture.",
                );
              })());
        const foundId = lookupContainerId(engine, spec.containerName);
        if (foundId === null) {
          throw new Error(
            `Podman host-local inference container start failed without an owned runtime: ${redactedCommandEvidence(sensitiveRedactor, result)}`,
          );
        }
        const inspected = inspectContainer(engine, foundId);
        acknowledgedCleanupCandidate = requireAcknowledgedSpecCleanupIdentity(
          inspected,
          spec,
          foundId,
        );
        if (result.status === 0 && !result.error) {
          const reportedId = exactContainerId(result.stdout.trim());
          if (reportedId !== foundId) {
            throw new Error("Podman inference create result disagrees with exact name inspection.");
          }
        }
        created = requireSpecIdentity(inspected, spec);
        acknowledgedCleanupCandidate ??= created;
        if (!created.running) {
          throw new Error(
            `Podman inference create did not leave the exact runtime running: ${redactedCommandEvidence(sensitiveRedactor, result)}`,
          );
        }
        emitAcknowledgedCommandFailure(
          "Podman inference container run",
          "start",
          result,
          onFailureEvidence,
          sensitiveRedactor,
        );
        phase = "ready";
        probeManagedReady(
          engine,
          authority,
          assertSpecAuthority,
          spec,
          managedSpecProbeParent(spec),
          onFailureEvidence,
          sensitiveRedactor,
          probeCleanupTiming,
        );
        if (spec.service === "ollama") {
          pullManagedOllamaModel(engine, assertSpecAuthority, created.runtimeId, spec.model);
        }
        phase = "gpu";
        proveManagedGpu(engine, assertSpecAuthority, created.runtimeId, spec.gpuDevices);
        phase = "inference";
        probeOpenAiInference(
          engine,
          authority,
          assertSpecAuthority,
          spec.endpoint,
          spec.probeImageRef,
          spec.model,
          spec.requireToolCalling,
          spec.service,
          managedSpecProbeParent(spec),
          onFailureEvidence,
          sensitiveRedactor,
          probeCleanupTiming,
        );
        const placement =
          spec.service === "ollama"
            ? probeOllamaAcceleration(
                engine,
                authority,
                assertSpecAuthority,
                spec.endpoint,
                spec.probeImageRef,
                spec.model,
                "nvidia-gpu",
                null,
                managedSpecProbeParent(spec),
                onFailureEvidence,
                sensitiveRedactor,
                probeCleanupTiming,
              )
            : null;
        assertSpecAuthority();
        return receiptFor(persisted, spec, created.runtimeId, placement?.modelDigest);
      },
      () => {
        if (created !== null) {
          removeExact(
            engine,
            created,
            (candidate) => requireSpecIdentity(candidate, spec),
            "rollback",
            onFailureEvidence,
            sensitiveRedactor,
          );
        } else if (acknowledgedCleanupCandidate !== null) {
          const cleanupCandidate = acknowledgedCleanupCandidate;
          removeExact(
            engine,
            cleanupCandidate,
            (candidate) =>
              requireAcknowledgedSpecCleanupIdentity(candidate, spec, cleanupCandidate.runtimeId),
            "rollback",
            onFailureEvidence,
            sensitiveRedactor,
          );
        }
        const residue = lookupContainerId(engine, spec.containerName);
        if (residue !== null) {
          throw new Error(`Podman inference rollback left name '${spec.containerName}' present.`);
        }
      },
      () => phase,
      onFailureEvidence,
      sensitiveRedactor,
    );
    if (created === null) {
      throw new Error("Podman inference prepared startup lost its exact runtime identity.");
    }
    const exactCreated = created;
    return createPreparedStartup({
      receipt,
      writer,
      priorState: "absent",
      validate: () => {
        validateReceipt(receipt);
      },
      onCommitValidationFailure: (error) => {
        onFailureEvidence(
          Object.freeze({
            providerId: PROVIDER_ID,
            phase: "commit",
            message: errorEvidence(sensitiveRedactor, error),
          }),
        );
      },
      validatePublication: assertSpecAuthority,
      rollback: () => {
        removeExact(
          engine,
          exactCreated,
          (candidate) => requireSpecIdentity(candidate, spec),
          "rollback",
          onFailureEvidence,
          sensitiveRedactor,
        );
        return "removed";
      },
      redactor: sensitiveRedactor,
    });
  };

  const resumePublished = (
    input: HostLocalManagedInferenceInput,
    receiptValue: HostLocalInferenceReceipt,
    writerValue: HostLocalInferenceReceiptWriter,
  ): HostLocalInferencePreparedStartup => {
    const writer = requireWriter(writerValue);
    const normalizedReceipt = authorizeReceipt(receiptValue);
    if (
      normalizedReceipt.runtime.kind !== "container" ||
      (normalizedReceipt.service !== "ollama" &&
        normalizedReceipt.service !== "nim" &&
        normalizedReceipt.service !== "vllm") ||
      normalizedReceipt.inference === undefined ||
      normalizedReceipt.publication === undefined ||
      !("devices" in normalizedReceipt.runtime.gpu)
    ) {
      throw new Error("Podman published resume requires an exact managed receipt.");
    }
    const receipt = normalizedReceipt as ManagedReceipt;
    const endpoint = requireProofEndpoint(receipt.endpoint);
    const network = inspectNetwork(input);
    const originalPriorState = receipt.publication.priorState;
    if (
      originalPriorState !== "absent" &&
      originalPriorState !== "running" &&
      originalPriorState !== "stopped"
    ) {
      throw new Error("Podman published resume receipt has invalid prior-state authority.");
    }
    const requestedSpec = normalizeManagedSpec(
      input,
      writer,
      authority,
      network,
      originalPriorState,
      publishedEngineAuthority?.creationAuthority.bindingSha256,
    );
    if (
      input.service !== receipt.service ||
      exactText(input.containerName, SAFE_NAME, "Inference container name") !==
        receipt.runtime.name ||
      normalizeHostLocalInferenceImageRef(input.imageRef) !== receipt.runtime.imageRef ||
      normalizeHostLocalInferenceImageRef(input.probeImageRef) !== receipt.runtime.probeImageRef ||
      exactPort(input.hostPort, "Inference host port") !== endpoint.port ||
      exactNetworkName(input.networkName, "Inference network name") !== endpoint.networkName ||
      input.networkId !== endpoint.networkId ||
      input.networkGatewayIp !== endpoint.networkGatewayIp ||
      input.networkListenerIp !== endpoint.networkListenerIp ||
      network.authoritySha256 !== endpoint.networkAuthoritySha256 ||
      input.model !== receipt.inference.model ||
      input.requireToolCalling !== receipt.inference.toolCallingRequired ||
      requestedSpec.gpuDevices.join("\n") !== [...receipt.runtime.gpu.devices].sort().join("\n") ||
      requestedSpec.specSha256 !== receipt.runtime.specSha256 ||
      requestedSpec.launchSha256 !== receipt.runtime.launchSha256 ||
      writer.transactionId !== receipt.publication.transactionId ||
      writer.targetSha256 !== receipt.publication.targetSha256
    ) {
      throw new Error("Podman published resume request differs from durable receipt authority.");
    }
    const resolvedId = lookupContainerId(engine, receipt.runtime.name);
    if (resolvedId === null || resolvedId !== receipt.runtime.runtimeId) {
      throw new Error("Podman published resume found missing or name-reused runtime authority.");
    }
    let container = requireReceiptIdentity(inspectContainer(engine, resolvedId), receipt);
    const wasRunning = container.running;
    if (!wasRunning && !AT_REST_STATES.has(container.status)) {
      throw new Error(
        `Podman published resume found indeterminate runtime state '${container.status}'.`,
      );
    }
    const priorState = wasRunning ? ("running" as const) : ("stopped" as const);
    const assertReceiptAuthority = () => {
      assertReceiptExecutionAuthority();
      inspectNetwork(endpoint);
      container = requireReceiptIdentity(
        inspectContainer(engine, receipt.runtime.runtimeId),
        receipt,
      );
    };
    const assertReceiptTransactionAuthority = () => {
      const current = inspectPublishedResumeTransaction(receipt);
      container = current.container;
    };
    const assertResumeForwardAuthority = publishedEngineAuthority
      ? assertReceiptTransactionAuthority
      : assertReceiptAuthority;
    const assertRollbackReceiptAuthority = () => {
      assertReceiptExecutionAuthority("rollback");
      inspectNetwork(endpoint);
      container = requireReceiptIdentity(
        inspectContainer(engine, receipt.runtime.runtimeId),
        receipt,
      );
    };
    const rollback = () => {
      assertRollbackReceiptAuthority();
      restoreExact(
        engine,
        container,
        wasRunning,
        (candidate) => requireReceiptIdentity(candidate, receipt),
        onFailureEvidence,
        sensitiveRedactor,
      );
      assertRollbackReceiptAuthority();
      return "restored" as const;
    };
    const resumeTiming = createPodmanPublishedResumeTimingRecorder(options.publishedResumeTiming);
    let phase: PodmanInferenceFailureEvidence["phase"] = "start";
    withRollback(
      () => {
        resumeTiming.measure("start", () => {
          if (!container.running) {
            assertResumeForwardAuthority();
            const result = engine.capture(["start", container.runtimeId], MUTATION_TIMEOUT_MS);
            container = requireReceiptIdentity(
              inspectContainer(engine, container.runtimeId),
              receipt,
            );
            if (!container.running) {
              throw new Error(
                `Podman published resume did not leave the exact runtime running: ${redactedCommandEvidence(sensitiveRedactor, result)}`,
              );
            }
            emitAcknowledgedCommandFailure(
              "Podman published resume start",
              "start",
              result,
              onFailureEvidence,
              sensitiveRedactor,
            );
            assertResumeForwardAuthority();
          }
        });
        if (!publishedEngineAuthority) {
          phase = "ready";
          resumeTiming.measure("managedReady", () =>
            probeManagedReady(
              engine,
              authority,
              assertReceiptAuthority,
              {
                endpoint,
                probeImageRef: receipt.runtime.probeImageRef,
                service: receipt.service,
              },
              receiptProbeParent(receipt),
              onFailureEvidence,
              sensitiveRedactor,
              probeCleanupTiming,
              resumeTiming,
            ),
          );
          phase = "gpu";
          resumeTiming.measure("gpuIdentity", () =>
            proveManagedGpu(
              engine,
              assertReceiptAuthority,
              container.runtimeId,
              receipt.runtime.gpu.devices,
            ),
          );
          phase = "inference";
          resumeTiming.measure("generatedProof", () =>
            probeOpenAiInference(
              engine,
              authority,
              assertReceiptAuthority,
              endpoint,
              receipt.runtime.probeImageRef,
              receipt.inference.model,
              receipt.inference.toolCallingRequired,
              receipt.service,
              receiptProbeParent(receipt),
              onFailureEvidence,
              sensitiveRedactor,
              probeCleanupTiming,
              resumeTiming,
            ),
          );
          if (receipt.service === "ollama") {
            resumeTiming.measure("modelPlacement", () =>
              probeOllamaAcceleration(
                engine,
                authority,
                assertReceiptAuthority,
                endpoint,
                receipt.runtime.probeImageRef,
                receipt.inference.model,
                "nvidia-gpu",
                receipt.runtime.modelDigest ?? null,
                receiptProbeParent(receipt),
                onFailureEvidence,
                sensitiveRedactor,
                probeCleanupTiming,
                resumeTiming,
              ),
            );
          }
        }
        resumeTiming.measure(
          "cleanupCurrentness",
          publishedEngineAuthority ? assertReceiptTransactionAuthority : assertReceiptAuthority,
        );
      },
      () => {
        rollback();
      },
      () => phase,
      onFailureEvidence,
      sensitiveRedactor,
    );
    return createPreparedStartup({
      receipt,
      writer,
      priorState,
      validate: () => {
        if (publishedEngineAuthority) {
          validatePublishedResumeReceipt(receipt, resumeTiming);
        } else {
          validateReceipt(receipt, true, resumeTiming);
        }
      },
      validatePublication: assertReceiptAuthority,
      publishedResume: true,
      onPublishedResumeFinalized: () => {
        resumeTiming.finish(wasRunning ? "reused" : "started");
      },
      onCommitValidationFailure: (error) => {
        onFailureEvidence(
          Object.freeze({
            providerId: PROVIDER_ID,
            phase: "commit",
            message: errorEvidence(sensitiveRedactor, error),
          }),
        );
      },
      rollback,
      redactor: sensitiveRedactor,
    });
  };

  return Object.freeze({
    providerId: PROVIDER_ID,
    authorityId: engine.authorityId,
    services: publishedEngineAuthority
      ? Object.freeze(["ollama"] as const)
      : operationAcceleration === "nvidia-gpu"
        ? Object.freeze(["ollama", "nim", "vllm"] as const)
        : Object.freeze(["ollama"] as const),
    translateContainerArgs(args: readonly string[]) {
      if (publishedEngineAuthority) {
        throw new Error("Hermes Portable published recovery cannot translate new runtime input.");
      }
      authorize(true);
      return translatePodmanLocalInferenceArgs(args, authority, {
        acceleration: operationAcceleration,
      });
    },
    qualifyOllama(
      input: HostLocalOllamaInferenceInput,
      writerValue: HostLocalInferenceReceiptWriter,
    ) {
      if (publishedEngineAuthority) {
        throw new Error("Hermes Portable published recovery cannot qualify a new Ollama runtime.");
      }
      if (input.acceleration !== "cpu" && input.acceleration !== "nvidia-gpu") {
        throw new Error("Ollama acceleration selection is unsupported.");
      }
      if (input.acceleration !== operationAcceleration) {
        throw new Error("Ollama acceleration differs from its operation authority.");
      }
      const writer = requireWriter(writerValue);
      const persisted = authorize(true);
      const network = inspectNetwork(input);
      if (typeof input.requireToolCalling !== "boolean") {
        throw new Error("Ollama tool-calling requirement must be a boolean.");
      }
      const endpoint = Object.freeze({
        host: HOST_LOCAL_INFERENCE_SANDBOX_HOST,
        port: exactPort(input.hostPort, "Ollama host port"),
        networkName: network.name,
        networkId: network.id,
        networkGatewayIp: network.gatewayIp,
        networkAuthoritySha256: network.authoritySha256,
      });
      const inference = Object.freeze({
        protocol: "openai-chat-completions" as const,
        model: normalizeHostLocalOllamaModelRef(input.model),
        toolCallingRequired: input.requireToolCalling,
      });
      const publication = Object.freeze({
        transactionId: writer.transactionId,
        targetSha256: writer.targetSha256,
        priorState: "host-process" as const,
      });
      const candidateRuntime = Object.freeze({
        kind: "host" as const,
        probeImageRef: normalizeHostLocalInferenceImageRef(input.probeImageRef),
        acceleration: input.acceleration,
      });
      const qualificationParent = ollamaQualificationProbeParent({
        engineAuthority: persisted,
        endpoint,
        inference,
        publication,
        runtime: candidateRuntime,
      });
      const assertOllamaAuthority = () => {
        assertAuthority();
        inspectNetwork(endpoint);
      };
      let phase: PodmanInferenceFailureEvidence["phase"] = "ready";
      let placement: OllamaModelPlacementAuthority;
      try {
        probeOllamaReady(
          engine,
          authority,
          assertOllamaAuthority,
          endpoint,
          candidateRuntime.probeImageRef,
          qualificationParent,
          onFailureEvidence,
          sensitiveRedactor,
          probeCleanupTiming,
        );
        phase = "inference";
        probeOpenAiInference(
          engine,
          authority,
          assertOllamaAuthority,
          endpoint,
          candidateRuntime.probeImageRef,
          inference.model,
          inference.toolCallingRequired,
          "ollama",
          qualificationParent,
          onFailureEvidence,
          sensitiveRedactor,
          probeCleanupTiming,
        );
        phase = "gpu";
        placement = probeOllamaAcceleration(
          engine,
          authority,
          assertOllamaAuthority,
          endpoint,
          candidateRuntime.probeImageRef,
          inference.model,
          candidateRuntime.acceleration,
          null,
          qualificationParent,
          onFailureEvidence,
          sensitiveRedactor,
          probeCleanupTiming,
        );
        assertOllamaAuthority();
      } catch (error) {
        if (
          !(error instanceof PodmanInferenceCapturedFailureError) &&
          !(error instanceof PodmanInferenceIndeterminateCleanupError) &&
          !(error instanceof PodmanInferenceEvidenceCaptureError)
        ) {
          emitProviderFailure(
            phase,
            errorEvidence(sensitiveRedactor, error),
            onFailureEvidence,
            sensitiveRedactor,
          );
        }
        throw error;
      }
      const receipt = normalizeHostLocalInferenceReceipt({
        schemaVersion: 2,
        providerId: PROVIDER_ID,
        service: "ollama",
        engineAuthority: persisted,
        endpoint,
        inference,
        publication,
        runtime: { ...candidateRuntime, modelDigest: placement.modelDigest },
      });
      if (receipt.runtime.kind !== "host" || receipt.inference === undefined) {
        throw new Error("Ollama receipt normalization failed.");
      }
      const routeAuthority = ollamaRouteAuthority(receipt);
      return createPreparedStartup({
        receipt,
        writer,
        priorState: "host-process",
        validate: () => {
          validateReceipt(receipt, false);
        },
        onCommitValidationFailure: (error) => {
          onFailureEvidence(
            Object.freeze({
              providerId: PROVIDER_ID,
              phase: "commit",
              message: errorEvidence(sensitiveRedactor, error),
            }),
          );
        },
        validatePublication: assertOllamaAuthority,
        beforeWrite: () => {
          requireOllamaRouteAuthority(routeAuthorityStore.record(routeAuthority), routeAuthority);
        },
        rollback: () => "retained",
        redactor: sensitiveRedactor,
      });
    },
    startManaged(input: HostLocalManagedInferenceInput, writer: HostLocalInferenceReceiptWriter) {
      if (publishedEngineAuthority) {
        throw new Error("Hermes Portable published recovery cannot start a new managed runtime.");
      }
      return start(input, writer, false);
    },
    recoverManaged(input: HostLocalManagedInferenceInput, writer: HostLocalInferenceReceiptWriter) {
      if (publishedEngineAuthority) {
        throw new Error(
          "Hermes Portable published recovery cannot recover an unpublished runtime.",
        );
      }
      return start(input, writer, true);
    },
    resumeManaged: resumePublished,
    ...(publishedEngineAuthority
      ? {
          preparePublishedRecoveryEntry(
            receipt: HostLocalInferenceReceipt,
          ): HostLocalManagedInferenceInspection {
            const current = inspectPublishedResumeTransaction(receipt);
            return Object.freeze({
              running: current.container.running,
              receipt: current.receipt,
            });
          },
          inspectPublishedRecoveryCurrent(
            receipt: HostLocalInferenceReceipt,
          ): HostLocalManagedInferenceInspection {
            const current = inspectPublishedResumeTransaction(receipt);
            return Object.freeze({
              running: current.container.running,
              receipt: current.receipt,
            });
          },
          inspectPublishedRecoveryRestoration(
            receipt: HostLocalInferenceReceipt,
          ): HostLocalManagedInferenceInspection {
            const inspected = inspectReceipt(receipt, "rollback");
            if (!inspected.container.running && !AT_REST_STATES.has(inspected.container.status)) {
              throw new Error(
                `Podman published inference restoration found indeterminate runtime state '${inspected.container.status}'.`,
              );
            }
            return Object.freeze({
              running: inspected.container.running,
              receipt: inspected.receipt,
            });
          },
        }
      : {}),
    inspectManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection {
      const inspected = inspectReceipt(receipt);
      return Object.freeze({ running: inspected.container.running, receipt: inspected.receipt });
    },
    ...(publishedEngineAuthority
      ? {
          validatePublishedResume(receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt {
            const resumeTiming = createPodmanPublishedResumeTimingRecorder(
              options.publishedResumeTiming,
            );
            const validated = validatePublishedResumeReceipt(receipt, resumeTiming);
            resumeTiming.finish("reused");
            return validated;
          },
        }
      : {}),
    stopManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection {
      if (publishedEngineAuthority) {
        throw new Error(
          "Hermes Portable published recovery cannot stop through a public lifecycle.",
        );
      }
      let inspected = inspectReceipt(receipt);
      if (!inspected.container.running) {
        if (!AT_REST_STATES.has(inspected.container.status)) {
          throw new Error(
            `Podman inference container state '${inspected.container.status}' cannot be stopped.`,
          );
        }
        return Object.freeze({ running: false, receipt: inspected.receipt });
      }
      assertAuthority();
      const result = engine.capture(
        ["stop", "--time", String(STOP_GRACE_SECONDS), inspected.container.runtimeId],
        MUTATION_TIMEOUT_MS,
      );
      inspected = inspectReceipt(inspected.receipt);
      if (inspected.container.running || !AT_REST_STATES.has(inspected.container.status)) {
        throw new Error(
          `Podman inference stop did not leave the exact runtime at rest: ${redactedCommandEvidence(sensitiveRedactor, result)}`,
        );
      }
      emitAcknowledgedCommandFailure(
        "Podman inference container stop",
        "stop",
        result,
        onFailureEvidence,
        sensitiveRedactor,
      );
      return Object.freeze({ running: false, receipt: inspected.receipt });
    },
    preserveForRebuild: (receipt: HostLocalInferenceReceipt) => validateReceipt(receipt),
    validate: validateReceipt,
    prepareDestroy(receipt: HostLocalInferenceReceipt) {
      const normalized = authorizeReceipt(receipt);
      if (normalized.runtime.kind === "container") {
        if (exactContainerExists(engine, normalized.runtime.runtimeId)) {
          inspectReceipt(normalized);
        } else {
          const name = lookupContainerId(engine, normalized.runtime.name);
          if (name !== null) {
            throw new Error(
              `Podman inference cleanup found name '${normalized.runtime.name}' reused by '${name}'.`,
            );
          }
        }
      }
      return normalized;
    },
    destroy(receipt: HostLocalInferenceReceipt) {
      if (publishedEngineAuthority) {
        throw new Error("Hermes Portable published recovery cannot destroy a published runtime.");
      }
      const normalized = authorizeReceipt(receipt);
      if (normalized.runtime.kind === "host") {
        return Object.freeze({
          status: "retained" as const,
          reason: "host-process" as const,
          receipt: normalized,
        });
      }
      if (!exactContainerExists(engine, normalized.runtime.runtimeId)) {
        const name = lookupContainerId(engine, normalized.runtime.name);
        if (name !== null) {
          throw new Error(
            `Podman inference destroy found name '${normalized.runtime.name}' reused by '${name}'.`,
          );
        }
        return Object.freeze({ status: "already-absent" as const, receipt: normalized });
      }
      const inspected = inspectReceipt(normalized);
      assertAuthority();
      removeExact(
        engine,
        inspected.container,
        (candidate) => requireReceiptIdentity(candidate, inspected.receipt),
        "cleanup",
        onFailureEvidence,
        sensitiveRedactor,
      );
      return Object.freeze({ status: "removed" as const, receipt: inspected.receipt });
    },
  });
}

function createPodmanHostLocalInferenceOperationFromAuthority(
  options: PodmanHostLocalInferenceOperationOptions,
  qualifiedEngine: PodmanContainerEngine,
  authority: PodmanInferenceAuthorityReceipt,
  acceleration: HostLocalOllamaAccelerationAuthority,
): HostLocalInferenceOperation {
  const redactor = requireRedactor(options.redactSensitive);
  const runtime = createPodmanHostLocalInferenceRuntime({
    ...options,
    engine: qualifiedEngine,
    redactSensitive: redactor,
    authority,
    operationAcceleration: acceleration,
  });
  const assertTransactionCurrent = (): void => {
    const candidate = options.engine as PodmanContainerEngine & {
      readonly assertAuthority?: () => void;
    };
    if (!candidate.assertAuthority) {
      throw new Error("Podman inference operation lacks bound executable and socket authority.");
    }
    candidate.assertAuthority();
  };
  const denyGenericEngineCommand = () => {
    throw new Error(
      "Podman managed inference exposes commands only through its provider-owned lifecycle.",
    );
  };
  const publicEngine = Object.freeze({
    operation: options.engine.operation,
    engineId: options.engine.engineId,
    displayName: options.engine.displayName,
    authorityId: options.engine.authorityId,
    endpointAuthorityId: options.engine.endpointAuthorityId,
    capture: denyGenericEngineCommand,
    captureWithEnvironment: denyGenericEngineCommand,
    captureHost: denyGenericEngineCommand,
  }) satisfies PodmanContainerEngine;
  return Object.freeze({
    providerId: PROVIDER_ID,
    engine: publicEngine,
    bindingSha256: authority.receiptSha256,
    assertTransactionCurrent,
    assertAuthority: () => {
      const refreshed = revalidatePodmanInferenceAuthority(
        qualifiedEngine,
        authority,
        options.authorityQualification,
      );
      if (acceleration === "nvidia-gpu" && refreshed.cdiDevices.length === 0) {
        throw new Error(
          "Podman NVIDIA GPU operation authority requires at least one discovered NVIDIA CDI device.",
        );
      }
    },
    spawn: () => {
      throw new Error("Podman managed inference does not expose a generic command spawner.");
    },
    createLlamaCppLifecycle: () => {
      throw new Error("Podman managed inference does not provide llama.cpp lifecycle authority.");
    },
    managedRuntime: runtime,
  });
}

/** Fully qualify one engine generation before a delayed, single operation construction. */
export function preparePodmanHostLocalInferenceOperationAuthority(
  options: Omit<
    Pick<
      PodmanHostLocalInferenceOperationOptions,
      "acceleration" | "authority" | "authorityQualification" | "engine" | "env" | "redactSensitive"
    >,
    "engine"
  > & { readonly engine: PodmanBoundContainerEngine },
): PreparedPodmanHostLocalInferenceOperationAuthority {
  const acceleration = normalizeOperationAcceleration(options.acceleration);
  const redactor = requireRedactor(options.redactSensitive);
  const qualifiedEngine = redactingEngine(options.engine, redactor);
  const authority = options.authority
    ? revalidatePodmanInferenceAuthority(
        qualifiedEngine,
        options.authority,
        options.authorityQualification,
      )
    : qualifyPodmanInferenceAuthority(qualifiedEngine, options.authorityQualification);
  let operationCreated = false;
  const assertTransactionCurrent = (): void => {
    options.engine.assertAuthority();
  };
  const assertCurrent = (): void => {
    revalidatePodmanInferenceAuthority(qualifiedEngine, authority, options.authorityQualification);
  };
  return Object.freeze({
    createOperation(
      operationOptions: PodmanPreparedHostLocalInferenceOperationOptions,
    ): HostLocalInferenceOperation {
      if (operationCreated) {
        throw new Error("Podman inference operation authority was already consumed.");
      }
      operationCreated = true;
      assertTransactionCurrent();
      const operation = createPodmanHostLocalInferenceOperationFromAuthority(
        {
          ...operationOptions,
          engine: options.engine,
          env: options.env,
          acceleration,
          authority,
          authorityQualification: options.authorityQualification,
          redactSensitive: options.redactSensitive,
        },
        qualifiedEngine,
        authority,
        acceleration,
      );
      assertTransactionCurrent();
      return operation;
    },
    assertTransactionCurrent,
    assertCurrent,
  });
}

export function createPodmanHostLocalInferenceOperation(
  options: PodmanHostLocalInferenceOperationOptions,
): HostLocalInferenceOperation {
  const acceleration = normalizeOperationAcceleration(options.acceleration);
  const redactor = requireRedactor(options.redactSensitive);
  const qualifiedEngine = redactingEngine(options.engine, redactor);
  const authority = options.authority
    ? revalidatePodmanInferenceAuthority(
        qualifiedEngine,
        options.authority,
        options.authorityQualification,
      )
    : qualifyPodmanInferenceAuthority(qualifiedEngine, options.authorityQualification);
  return createPodmanHostLocalInferenceOperationFromAuthority(
    options,
    qualifiedEngine,
    authority,
    acceleration,
  );
}
