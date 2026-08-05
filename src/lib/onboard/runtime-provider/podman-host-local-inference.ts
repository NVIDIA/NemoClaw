// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import {
  type HostLocalInferenceEndpointAuthority,
  type HostLocalInferenceEndpointInput,
  type HostLocalInferenceMount,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceRouteAuthority,
  type HostLocalInferenceRouteAuthorityStore,
  type HostLocalInferenceRuntime,
  type HostLocalInferenceService,
  type HostLocalManagedInferenceInput,
  type HostLocalManagedInferenceInspection,
  normalizeHostLocalInferenceImageRef,
  normalizeHostLocalInferenceReceipt,
} from "./host-local-inference";
import {
  createPersistedEngineAuthority,
  type PersistedEngineAuthority,
  type PersistedEngineAuthorityStore,
  requirePersistedEngineAuthority,
} from "./persisted-engine-authority";
import { qualifyPodmanGpuAttachments } from "./podman-gpu";
import { translatePodmanLocalInferenceArgs } from "./podman-inference-args";
import type { PodmanHostPreflightReceipt } from "./podman-preflight";

export const PODMAN_INFERENCE_MANAGED_LABEL = "ai.nvidia.nemoclaw.inference.managed";
export const PODMAN_INFERENCE_PROVIDER_LABEL = "ai.nvidia.nemoclaw.inference.provider";
export const PODMAN_INFERENCE_SERVICE_LABEL = "ai.nvidia.nemoclaw.inference.service";
export const PODMAN_INFERENCE_SPEC_LABEL = "ai.nvidia.nemoclaw.inference.spec-sha256";
export const PODMAN_INFERENCE_AUTHORITY_LABEL = "ai.nvidia.nemoclaw.inference.authority-sha256";

const PROVIDER_ID = "podman";
const HOST_GATEWAY_NAME = "host.containers.internal";
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SHARED_MEMORY = /^[1-9][0-9]{0,11}(?:[kKmMgGtT][bB]?)?$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const AT_REST_STATES = new Set(["configured", "created", "dead", "exited", "stopped"]);
const PROBE_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 60_000;
const STOP_GRACE_SECONDS = 30;

export interface PodmanHostLocalInferenceRuntimeOptions {
  readonly engine: ContainerEngine;
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly routeAuthorityStore: HostLocalInferenceRouteAuthorityStore;
  readonly bindingSha256: string;
  readonly preflight: PodmanHostPreflightReceipt;
}

interface ManagedSpec {
  readonly service: "nim" | "vllm";
  readonly containerName: string;
  readonly containerPort: number;
  readonly imageRef: string;
  readonly gpuDevices: readonly string[];
  readonly environment: readonly string[];
  readonly mounts: readonly Required<HostLocalInferenceMount>[];
  readonly sharedMemory: string | null;
  readonly ipc: "host" | "private" | null;
  readonly command: readonly string[];
  readonly probeImageRef: string;
  readonly endpoint: HostLocalInferenceEndpointAuthority;
  readonly specSha256: string;
}

interface ManagedContainer {
  readonly runtimeId: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly running: boolean;
  readonly status: string;
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

function exactContainerId(value: unknown): string {
  const candidate = exactText(value, /\S+/u, "Podman inference container identity").toLowerCase();
  const normalized = candidate.startsWith("sha256:") ? candidate.slice(7) : candidate;
  if (!FULL_CONTAINER_ID.test(normalized)) {
    throw new Error("Podman inference container identity must be a full immutable ID.");
  }
  return normalized;
}

function commandDetail(result: ContainerEngineCommandResult): string {
  return (result.stderr || result.stdout || result.error?.message || "unknown failure")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-500);
}

function requireSuccess(operation: string, result: ContainerEngineCommandResult): string {
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Podman host-local inference ${operation} failed (exit ${String(result.status)}): ${commandDetail(result)}`,
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

function normalizedMounts(
  values: readonly HostLocalInferenceMount[] | undefined,
): readonly Required<HostLocalInferenceMount>[] {
  if (!Array.isArray(values ?? []) || (values?.length ?? 0) > 64) {
    throw new Error("Inference mounts are invalid or exceed their item limit.");
  }
  const mounts = (values ?? []).map((mount) => {
    const source = String(mount?.source ?? "");
    const target = String(mount?.target ?? "");
    if (mount?.readOnly !== undefined && typeof mount.readOnly !== "boolean") {
      throw new Error("Inference mount read-only flag must be a boolean when provided.");
    }
    if (
      source !== source.trim() ||
      target !== target.trim() ||
      !path.posix.isAbsolute(source) ||
      !path.posix.isAbsolute(target) ||
      source.includes(":") ||
      target.includes(":") ||
      CONTROL_CHARACTERS.test(source) ||
      CONTROL_CHARACTERS.test(target)
    ) {
      throw new Error(
        "Inference mounts require trimmed absolute Linux paths without ':' or control characters.",
      );
    }
    return Object.freeze({ source, target, readOnly: mount.readOnly ?? false });
  });
  const targets = mounts.map((mount) => mount.target);
  if (new Set(targets).size !== targets.length) {
    throw new Error("Inference mount targets must be unique.");
  }
  return Object.freeze([...mounts].sort((left, right) => left.target.localeCompare(right.target)));
}

function specDigest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function managedAuthorityDigest(input: {
  readonly providerId: string;
  readonly service: "nim" | "vllm";
  readonly endpoint: HostLocalInferenceEndpointAuthority;
  readonly name: string;
  readonly imageRef: string;
  readonly probeImageRef: string;
  readonly specSha256: string;
  readonly gpuDevices: readonly string[];
}): string {
  return specDigest({
    providerId: input.providerId,
    service: input.service,
    endpoint: input.endpoint,
    name: input.name,
    imageRef: input.imageRef,
    probeImageRef: input.probeImageRef,
    specSha256: input.specSha256,
    gpu: { vendor: "nvidia", devices: input.gpuDevices },
  });
}

function managedSpecAuthorityDigest(spec: ManagedSpec): string {
  return managedAuthorityDigest({
    providerId: PROVIDER_ID,
    service: spec.service,
    endpoint: spec.endpoint,
    name: spec.containerName,
    imageRef: spec.imageRef,
    probeImageRef: spec.probeImageRef,
    specSha256: spec.specSha256,
    gpuDevices: spec.gpuDevices,
  });
}

function managedReceiptAuthorityDigest(receipt: HostLocalInferenceReceipt): string {
  if (receipt.runtime.kind !== "container" || receipt.service === "ollama") {
    throw new Error("Podman managed inference authority requires a container receipt.");
  }
  return managedAuthorityDigest({
    providerId: receipt.providerId,
    service: receipt.service,
    endpoint: receipt.endpoint,
    name: receipt.runtime.name,
    imageRef: receipt.runtime.imageRef,
    probeImageRef: receipt.runtime.probeImageRef,
    specSha256: receipt.runtime.specSha256,
    gpuDevices: receipt.runtime.gpu.devices,
  });
}

function requireManagedService(service: HostLocalInferenceService): "nim" | "vllm" {
  if (service === "ollama") {
    throw new Error("Podman managed inference requires a container service.");
  }
  return service;
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
    receiptSha256: specDigest({
      providerId: receipt.providerId,
      service: receipt.service,
      engineAuthority: receipt.engineAuthority,
      endpoint: receipt.endpoint,
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

function normalizeManagedSpec(
  input: HostLocalManagedInferenceInput,
  availableCdiDevices: readonly string[],
): ManagedSpec {
  if (input.service !== "nim" && input.service !== "vllm") {
    throw new Error("Podman managed inference supports NIM or vLLM containers.");
  }
  const containerName = exactText(input.containerName, SAFE_NAME, "Inference container name");
  const networkName = exactText(input.networkName, SAFE_NAME, "Inference network name");
  const hostPort = exactPort(input.hostPort, "Inference host port");
  const containerPort = exactPort(input.containerPort, "Inference container port");
  const imageRef = normalizeHostLocalInferenceImageRef(input.imageRef);
  const probeImageRef = normalizeHostLocalInferenceImageRef(input.probeImageRef);
  const gpuDevices = Object.freeze(
    qualifyPodmanGpuAttachments(availableCdiDevices, input.gpuDevices).map(
      (attachment) => attachment.device,
    ),
  );
  const environment = normalizedEnvironment(input.environment);
  const mounts = normalizedMounts(input.mounts);
  const sharedMemory =
    input.sharedMemory === undefined
      ? null
      : exactText(input.sharedMemory, SHARED_MEMORY, "Inference shared-memory size");
  const ipc = input.ipc ?? null;
  if (ipc !== null && ipc !== "host" && ipc !== "private") {
    throw new Error("Inference IPC mode is invalid.");
  }
  const command = normalizedArguments(input.command ?? [], "Inference command arguments");
  const endpoint = Object.freeze({ host: HOST_GATEWAY_NAME, port: hostPort, networkName });
  const canonical = {
    service: input.service,
    containerName,
    containerPort,
    imageRef,
    gpuDevices,
    environment,
    mounts,
    sharedMemory,
    ipc,
    command,
    probeImageRef,
    endpoint,
  };
  return Object.freeze({ ...canonical, specSha256: specDigest(canonical) });
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
  });
}

function exactContainerExists(engine: ContainerEngine, runtimeId: string): boolean {
  const result = engine.capture(["container", "exists", runtimeId], PROBE_TIMEOUT_MS);
  if (result.error) {
    throw new Error(`Podman inference container existence check failed: ${commandDetail(result)}`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Podman inference container existence check failed: ${commandDetail(result)}`);
}

function requireManagedIdentity(
  container: ManagedContainer,
  expected: {
    readonly runtimeId: string;
    readonly name: string;
    readonly imageRef: string;
    readonly service: "nim" | "vllm";
    readonly specSha256: string;
    readonly authoritySha256: string;
  },
): ManagedContainer {
  if (
    container.runtimeId !== expected.runtimeId ||
    container.name !== expected.name ||
    container.imageRef !== expected.imageRef ||
    container.labels[PODMAN_INFERENCE_MANAGED_LABEL] !== "true" ||
    container.labels[PODMAN_INFERENCE_PROVIDER_LABEL] !== PROVIDER_ID ||
    container.labels[PODMAN_INFERENCE_SERVICE_LABEL] !== expected.service ||
    container.labels[PODMAN_INFERENCE_SPEC_LABEL] !== expected.specSha256 ||
    container.labels[PODMAN_INFERENCE_AUTHORITY_LABEL] !== expected.authoritySha256
  ) {
    throw new Error("Podman inference container does not match its exact managed authority.");
  }
  return container;
}

function lookupContainerId(engine: ContainerEngine, containerName: string): string | null {
  const output = requireSuccess(
    "container lookup",
    engine.capture(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^${containerName}$`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      PROBE_TIMEOUT_MS,
    ),
  );
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

function receiptFor(
  authority: PersistedEngineAuthority,
  spec: ManagedSpec,
  runtimeId: string,
): HostLocalInferenceReceipt {
  return normalizeHostLocalInferenceReceipt({
    schemaVersion: 1,
    providerId: PROVIDER_ID,
    service: spec.service,
    engineAuthority: authority,
    endpoint: spec.endpoint,
    runtime: {
      kind: "container",
      runtimeId,
      name: spec.containerName,
      imageRef: spec.imageRef,
      probeImageRef: spec.probeImageRef,
      specSha256: spec.specSha256,
      gpu: { vendor: "nvidia", devices: spec.gpuDevices },
    },
  });
}

function runArguments(spec: ManagedSpec): readonly string[] {
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
    "--network",
    spec.endpoint.networkName,
    "--publish",
    `127.0.0.1:${String(spec.endpoint.port)}:${String(spec.containerPort)}`,
  ];
  for (const device of spec.gpuDevices) args.push("--device", device);
  for (const name of spec.environment) args.push("--env", name);
  for (const mount of spec.mounts) {
    args.push("--volume", `${mount.source}:${mount.target}:${mount.readOnly ? "ro" : "rw"}`);
  }
  if (spec.sharedMemory !== null) args.push("--shm-size", spec.sharedMemory);
  if (spec.ipc !== null) args.push(`--ipc=${spec.ipc}`);
  args.push(spec.imageRef, ...spec.command);
  return Object.freeze(args);
}

function probeOllama(
  engine: ContainerEngine,
  endpoint: HostLocalInferenceEndpointAuthority,
  probeImageRef: string,
): void {
  const result = engine.capture(
    [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      endpoint.networkName,
      probeImageRef,
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      `http://${endpoint.host}:${String(endpoint.port)}/api/tags`,
    ],
    PROBE_TIMEOUT_MS,
  );
  requireSuccess("Ollama network probe", result);
}

function probeManagedInference(
  engine: ContainerEngine,
  spec: Pick<ManagedSpec, "endpoint" | "probeImageRef" | "service">,
): void {
  const healthPath = spec.service === "nim" ? "/v1/health/ready" : "/health";
  const result = engine.capture(
    [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      spec.endpoint.networkName,
      spec.probeImageRef,
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "10",
      "--retry-delay",
      "1",
      "--retry-connrefused",
      "--connect-timeout",
      "3",
      "--max-time",
      "12",
      `http://${spec.endpoint.host}:${String(spec.endpoint.port)}${healthPath}`,
    ],
    PROBE_TIMEOUT_MS,
  );
  requireSuccess(`${spec.service} network probe`, result);
}

export function createPodmanHostLocalInferenceRuntime(
  options: PodmanHostLocalInferenceRuntimeOptions,
): HostLocalInferenceRuntime {
  const { engine, authorityStore, routeAuthorityStore, bindingSha256, preflight } = options;
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
  if (preflight.providerId !== PROVIDER_ID || preflight.authorityId !== engine.authorityId) {
    throw new Error("Podman host-local inference preflight has a different endpoint authority.");
  }
  const availableCdiDevices = Object.freeze([...preflight.cdiDevices]);

  const currentAuthority = () => createPersistedEngineAuthority(PROVIDER_ID, engine, bindingSha256);
  const authorize = (recordIfMissing: boolean): PersistedEngineAuthority => {
    const current = currentAuthority();
    const persisted = authorityStore.load("host-local-inference");
    if (persisted === null) {
      if (!recordIfMissing) {
        throw new Error("Podman host-local inference has no persisted engine authority.");
      }
      return authorityStore.record(current);
    }
    return requirePersistedEngineAuthority(persisted, PROVIDER_ID, engine, bindingSha256);
  };
  const authorizeReceipt = (receipt: HostLocalInferenceReceipt): HostLocalInferenceReceipt => {
    const normalized = normalizeHostLocalInferenceReceipt(receipt);
    if (normalized.providerId !== PROVIDER_ID) {
      throw new Error("Host-local inference receipt belongs to another runtime provider.");
    }
    if (normalized.endpoint.host !== HOST_GATEWAY_NAME) {
      throw new Error("Host-local inference receipt does not use the provider's canonical host.");
    }
    authorize(false);
    requirePersistedEngineAuthority(normalized.engineAuthority, PROVIDER_ID, engine, bindingSha256);
    if (normalized.service === "ollama") {
      requireOllamaRouteAuthority(
        routeAuthorityStore.load("ollama"),
        ollamaRouteAuthority(normalized),
      );
    }
    return normalized;
  };
  const inspectReceipt = (
    receipt: HostLocalInferenceReceipt,
  ): { readonly receipt: HostLocalInferenceReceipt; readonly container: ManagedContainer } => {
    const normalized = authorizeReceipt(receipt);
    if (normalized.runtime.kind !== "container" || normalized.service === "ollama") {
      throw new Error("Podman managed inference requires a container receipt.");
    }
    const container = requireManagedIdentity(
      inspectContainer(engine, normalized.runtime.runtimeId),
      {
        runtimeId: normalized.runtime.runtimeId,
        name: normalized.runtime.name,
        imageRef: normalized.runtime.imageRef,
        service: normalized.service,
        specSha256: normalized.runtime.specSha256,
        authoritySha256: managedReceiptAuthorityDigest(normalized),
      },
    );
    return { receipt: normalized, container };
  };

  return Object.freeze({
    providerId: PROVIDER_ID,
    authorityId: engine.authorityId,
    services: Object.freeze(["ollama", "nim", "vllm"] as const),
    translateContainerArgs(args: readonly string[]) {
      authorize(true);
      return translatePodmanLocalInferenceArgs(args, availableCdiDevices);
    },
    qualifyOllama(input: HostLocalInferenceEndpointInput) {
      const authority = authorize(true);
      const receipt = normalizeHostLocalInferenceReceipt({
        schemaVersion: 1,
        providerId: PROVIDER_ID,
        service: "ollama",
        engineAuthority: authority,
        endpoint: {
          host: HOST_GATEWAY_NAME,
          port: exactPort(input.hostPort, "Ollama host port"),
          networkName: exactText(input.networkName, SAFE_NAME, "Ollama network name"),
        },
        runtime: {
          kind: "host",
          probeImageRef: normalizeHostLocalInferenceImageRef(input.probeImageRef),
        },
      });
      if (receipt.runtime.kind !== "host") throw new Error("Ollama receipt normalization failed.");
      probeOllama(engine, receipt.endpoint, receipt.runtime.probeImageRef);
      const routeAuthority = ollamaRouteAuthority(receipt);
      requireOllamaRouteAuthority(routeAuthorityStore.record(routeAuthority), routeAuthority);
      return receipt;
    },
    startManaged(input: HostLocalManagedInferenceInput) {
      const authority = authorize(true);
      const spec = normalizeManagedSpec(input, availableCdiDevices);
      const existingId = lookupContainerId(engine, spec.containerName);
      if (existingId !== null) {
        let container = requireManagedIdentity(inspectContainer(engine, existingId), {
          runtimeId: existingId,
          name: spec.containerName,
          imageRef: spec.imageRef,
          service: spec.service,
          specSha256: spec.specSha256,
          authoritySha256: managedSpecAuthorityDigest(spec),
        });
        if (!container.running) {
          if (!AT_REST_STATES.has(container.status)) {
            throw new Error(
              `Podman inference container state '${container.status}' cannot be started; expected configured, created, dead, exited, or stopped.`,
            );
          }
          requireSuccess(
            "container start",
            engine.capture(["start", container.runtimeId], MUTATION_TIMEOUT_MS),
          );
          container = requireManagedIdentity(inspectContainer(engine, existingId), {
            runtimeId: existingId,
            name: spec.containerName,
            imageRef: spec.imageRef,
            service: spec.service,
            specSha256: spec.specSha256,
            authoritySha256: managedSpecAuthorityDigest(spec),
          });
          if (!container.running) {
            throw new Error("Podman inference start did not leave the exact container running.");
          }
        }
        probeManagedInference(engine, spec);
        return receiptFor(authority, spec, container.runtimeId);
      }

      const runtimeId = exactContainerId(
        requireSuccess(
          "container start",
          engine.capture(runArguments(spec), MUTATION_TIMEOUT_MS),
        ).trim(),
      );
      try {
        const container = requireManagedIdentity(inspectContainer(engine, runtimeId), {
          runtimeId,
          name: spec.containerName,
          imageRef: spec.imageRef,
          service: spec.service,
          specSha256: spec.specSha256,
          authoritySha256: managedSpecAuthorityDigest(spec),
        });
        if (!container.running) {
          throw new Error("Podman inference start did not leave the exact container running.");
        }
        probeManagedInference(engine, spec);
        return receiptFor(authority, spec, runtimeId);
      } catch (error) {
        const cleanup = engine.capture(["rm", "--force", runtimeId], MUTATION_TIMEOUT_MS);
        if (cleanup.status !== 0 || cleanup.error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} Cleanup of '${runtimeId}' also failed: ${commandDetail(cleanup)}`,
          );
        }
        throw error;
      }
    },
    inspectManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection {
      const inspected = inspectReceipt(receipt);
      return Object.freeze({ running: inspected.container.running, receipt: inspected.receipt });
    },
    stopManaged(receipt: HostLocalInferenceReceipt): HostLocalManagedInferenceInspection {
      const inspected = inspectReceipt(receipt);
      if (!inspected.container.running) {
        if (!AT_REST_STATES.has(inspected.container.status)) {
          throw new Error(
            `Podman inference container state '${inspected.container.status}' cannot be stopped; expected configured, created, dead, exited, or stopped.`,
          );
        }
        return Object.freeze({ running: false, receipt: inspected.receipt });
      }
      requireSuccess(
        "container stop",
        engine.capture(
          ["stop", "--time", String(STOP_GRACE_SECONDS), inspected.container.runtimeId],
          MUTATION_TIMEOUT_MS,
        ),
      );
      const stopped = inspectReceipt(inspected.receipt);
      if (stopped.container.running || !AT_REST_STATES.has(stopped.container.status)) {
        throw new Error("Podman inference stop did not leave the exact container at rest.");
      }
      return Object.freeze({ running: false, receipt: stopped.receipt });
    },
    preserveForRebuild(receipt: HostLocalInferenceReceipt) {
      const normalized = authorizeReceipt(receipt);
      if (normalized.runtime.kind === "host") {
        probeOllama(engine, normalized.endpoint, normalized.runtime.probeImageRef);
      } else {
        const inspected = inspectReceipt(normalized);
        probeManagedInference(engine, {
          endpoint: inspected.receipt.endpoint,
          probeImageRef: inspected.receipt.runtime.probeImageRef,
          service: requireManagedService(inspected.receipt.service),
        });
      }
      return normalized;
    },
    prepareDestroy(receipt: HostLocalInferenceReceipt) {
      const normalized = authorizeReceipt(receipt);
      if (
        normalized.runtime.kind === "container" &&
        exactContainerExists(engine, normalized.runtime.runtimeId)
      ) {
        inspectReceipt(normalized);
      }
      return normalized;
    },
    destroy(receipt: HostLocalInferenceReceipt) {
      const normalized = authorizeReceipt(receipt);
      if (normalized.runtime.kind === "host") {
        return Object.freeze({
          status: "retained" as const,
          reason: "host-process" as const,
          receipt: normalized,
        });
      }
      if (!exactContainerExists(engine, normalized.runtime.runtimeId)) {
        return Object.freeze({ status: "already-absent" as const, receipt: normalized });
      }
      const inspected = inspectReceipt(normalized);
      requireSuccess(
        "container removal",
        engine.capture(["rm", "--force", inspected.container.runtimeId], MUTATION_TIMEOUT_MS),
      );
      if (exactContainerExists(engine, inspected.container.runtimeId)) {
        throw new Error("Podman inference removal left the exact managed container present.");
      }
      return Object.freeze({ status: "removed" as const, receipt: inspected.receipt });
    },
  });
}
