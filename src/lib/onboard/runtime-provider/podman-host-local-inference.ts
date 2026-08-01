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
  type HostLocalInferenceRuntime,
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
      throw new Error("Inference mounts require safe absolute Linux paths.");
    }
    return Object.freeze({ source, target, readOnly: mount.readOnly === true });
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

function requireManagedIdentity(
  container: ManagedContainer,
  expected: {
    readonly runtimeId: string;
    readonly name: string;
    readonly imageRef: string;
    readonly service: "nim" | "vllm";
    readonly specSha256: string;
  },
): ManagedContainer {
  if (
    container.runtimeId !== expected.runtimeId ||
    container.name !== expected.name ||
    container.imageRef !== expected.imageRef ||
    container.labels[PODMAN_INFERENCE_MANAGED_LABEL] !== "true" ||
    container.labels[PODMAN_INFERENCE_PROVIDER_LABEL] !== PROVIDER_ID ||
    container.labels[PODMAN_INFERENCE_SERVICE_LABEL] !== expected.service ||
    container.labels[PODMAN_INFERENCE_SPEC_LABEL] !== expected.specSha256
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

export function createPodmanHostLocalInferenceRuntime(
  options: PodmanHostLocalInferenceRuntimeOptions,
): HostLocalInferenceRuntime {
  const { engine, authorityStore, bindingSha256, preflight } = options;
  if (engine.operation !== "host-local-inference" || engine.engineId !== PROVIDER_ID) {
    throw new Error("Podman host-local inference requires an operation-scoped Podman engine.");
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
    authorize(false);
    requirePersistedEngineAuthority(normalized.engineAuthority, PROVIDER_ID, engine, bindingSha256);
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
      },
    );
    return { receipt: normalized, container };
  };

  return Object.freeze({
    providerId: PROVIDER_ID,
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
        });
        if (!container.running) {
          if (!AT_REST_STATES.has(container.status)) {
            throw new Error(
              `Podman inference container state '${container.status}' cannot be started safely.`,
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
          });
          if (!container.running) {
            throw new Error("Podman inference start did not leave the exact container running.");
          }
        }
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
        });
        if (!container.running) {
          throw new Error("Podman inference start did not leave the exact container running.");
        }
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
            `Podman inference container state '${inspected.container.status}' cannot be stopped safely.`,
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
        inspectReceipt(normalized);
      }
      return normalized;
    },
  });
}
