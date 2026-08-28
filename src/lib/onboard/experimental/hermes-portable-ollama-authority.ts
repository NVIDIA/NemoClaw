// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  HostLocalInferenceOperationInput,
  HostLocalInferenceReceiptWriter,
  HostLocalInferenceRuntime,
  HostLocalManagedInferenceInput,
} from "../runtime-provider/host-local-inference";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import { createHermesPortablePodmanOperationEngines } from "./hermes-portable-podman-authority";
import {
  PORTABLE_DOCKER_NETWORK_NAME,
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_REGISTRY_IP,
} from "./portable-profile";

export const PORTABLE_OLLAMA_IMAGE =
  "docker.io/ollama/ollama@sha256:268c47cdc4718ded54babcd842579a7295ad79fd8d5c2ea64d7ba2e76872de6b";
export const PORTABLE_PROBE_IMAGE =
  "docker.io/curlimages/curl@sha256:fcff5cf7a4b895da7bd2933c914938db2b05d2113fa0d6c55b6d29930408f661";
const GPU_UUID = /^GPU-[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/u;
const NETWORK_ID = /^[a-f0-9]{64}$/u;
const REGISTRY_CONTAINER = "nemoclaw-portable-registry";
const PORTABLE_MANAGED_LABEL = "com.nvidia.nemoclaw.portable";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const DIAGNOSTIC_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;
const IMAGE_PULL_TIMEOUT_MS = 30 * 60_000;
const IMAGE_PULL_DIAGNOSTIC_LIMIT = 240;
const REGISTRY_MUTATION_TIMEOUT_MS = 30_000;
const REGISTRY_START_SETTLEMENT_TIMEOUT_MS = 30_000;
const REGISTRY_START_SETTLEMENT_INTERVAL_MS = 1_000;
const REGISTRY_STOP_GRACE_SECONDS = 10;
const REGISTRY_AT_REST_STATES = new Set(["configured", "created", "dead", "exited", "stopped"]);
const REGISTRY_SETTLEMENT_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
type PortablePodmanResult = ReturnType<
  ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"]["capture"]
>;
type DiagnosticRedactor = (message: string) => string;

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function captureCurrentGpuDevices(): readonly string[] {
  const result = spawnSync("nvidia-smi", ["--query-gpu=uuid", "--format=csv,noheader"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("Hermes Portable inference could not capture NVIDIA GPU UUID authority.");
  }
  const uuids = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    uuids.length === 0 ||
    new Set(uuids).size !== uuids.length ||
    uuids.some((id) => !GPU_UUID.test(id))
  ) {
    throw new Error("Hermes Portable inference received missing or ambiguous NVIDIA GPU UUIDs.");
  }
  return Object.freeze(uuids.sort().map((id) => `nvidia.com/gpu=${id}`));
}

export function captureCurrentCdiDevices(): readonly string[] {
  const result = spawnSync("nvidia-ctk", ["cdi", "list"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("Hermes Portable inference could not capture NVIDIA CDI authority.");
  }
  const devices = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("nvidia.com/gpu="));
  if (devices.length === 0 || new Set(devices).size !== devices.length) {
    throw new Error("Hermes Portable inference received missing or ambiguous NVIDIA CDI entries.");
  }
  return Object.freeze([...devices].sort());
}

export function captureQualifiedGpuDevices(
  captureGpuDevices: () => readonly string[],
  captureCdiDevices: () => readonly string[],
): readonly string[] {
  const physicalDevices = Object.freeze([...captureGpuDevices()].sort());
  const cdiInventory = Object.freeze([...captureCdiDevices()].sort());
  const cdiPhysicalDevices = cdiInventory.filter(
    (device) =>
      device.startsWith("nvidia.com/gpu=") && GPU_UUID.test(device.slice("nvidia.com/gpu=".length)),
  );
  if (
    physicalDevices.length === 0 ||
    new Set(physicalDevices).size !== physicalDevices.length ||
    physicalDevices.some(
      (device) =>
        !device.startsWith("nvidia.com/gpu=") ||
        !GPU_UUID.test(device.slice("nvidia.com/gpu=".length)),
    ) ||
    new Set(cdiPhysicalDevices).size !== cdiPhysicalDevices.length ||
    cdiPhysicalDevices.join("\n") !== physicalDevices.join("\n")
  ) {
    throw new Error("Hermes Portable inference host GPU and CDI authority disagree.");
  }
  return physicalDevices;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function sortedStringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const source = requireRecord(value ?? {}, label);
  const result: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(source).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (typeof entry !== "string" || CONTROL_CHARACTERS.test(entry)) {
      throw new Error(`${label} is malformed.`);
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function parseExactInspection(output: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${label} is malformed.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${label} is missing or ambiguous.`);
  }
  return requireRecord(parsed[0], label);
}

type PortableInferenceEngine = ReturnType<
  typeof createHermesPortablePodmanOperationEngines
>["hostLocalInference"];

interface PortableNetworkShape {
  readonly id: string;
  readonly gatewayIp: string;
  readonly canonical: object;
}

interface PortableRegistryShape {
  readonly runtimeId: string;
  readonly running: boolean;
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly networkId: string;
  readonly ipAddress: string;
}

function inspectPortableNetworkShape(engine: PortableInferenceEngine): PortableNetworkShape {
  const result = engine.capture(["network", "inspect", PORTABLE_DOCKER_NETWORK_NAME], 30_000);
  if (result.error || result.status !== 0) {
    throw new Error("Hermes Portable inference could not inspect its Podman network authority.");
  }
  const network = parseExactInspection(
    result.stdout,
    "Hermes Portable inference network authority",
  );
  const id = network.id;
  const name = network.name;
  const subnets = network.subnets;
  const subnet =
    Array.isArray(subnets) && subnets.length === 1
      ? requireRecord(subnets[0], "Hermes Portable inference network subnet")
      : null;
  if (
    typeof id !== "string" ||
    !NETWORK_ID.test(id) ||
    name !== PORTABLE_DOCKER_NETWORK_NAME ||
    network.driver !== "bridge" ||
    network.internal !== false ||
    network.ipv6_enabled !== false ||
    !subnet ||
    subnet.subnet !== PORTABLE_DOCKER_NETWORK_SUBNET ||
    typeof subnet.gateway !== "string"
  ) {
    throw new Error("Hermes Portable inference network authority changed after host preparation.");
  }
  return Object.freeze({
    id,
    gatewayIp: subnet.gateway,
    canonical: Object.freeze({
      id,
      name,
      driver: "bridge",
      internal: false,
      ipv6Enabled: false,
      dnsEnabled: network.dns_enabled,
      networkInterface: network.network_interface,
      subnet: Object.freeze({ subnet: PORTABLE_DOCKER_NETWORK_SUBNET, gateway: subnet.gateway }),
      labels: sortedStringRecord(network.labels, "Hermes Portable inference network labels"),
      ipamOptions: sortedStringRecord(
        network.ipam_options,
        "Hermes Portable inference network IPAM options",
      ),
      options: sortedStringRecord(network.options, "Hermes Portable inference network options"),
      listenerIp: PORTABLE_HOST_GATEWAY_IP,
    }),
  });
}

function inspectPortableRegistryShape(
  engine: PortableInferenceEngine,
  reference: string,
): PortableRegistryShape {
  const registryResult = engine.capture(["container", "inspect", reference], 30_000);
  if (registryResult.error || registryResult.status !== 0) {
    throw new Error("Hermes Portable inference could not inspect its registry authority.");
  }
  const registry = parseExactInspection(
    registryResult.stdout,
    "Hermes Portable inference registry authority",
  );
  const config = requireRecord(registry.Config, "Hermes Portable inference registry configuration");
  const state = requireRecord(registry.State, "Hermes Portable inference registry state");
  const networkSettings = requireRecord(
    registry.NetworkSettings,
    "Hermes Portable inference registry network settings",
  );
  const networks = requireRecord(
    networkSettings.Networks,
    "Hermes Portable inference registry attachments",
  );
  const attachments = Object.entries(networks);
  const attachment =
    attachments.length === 1 && attachments[0]?.[0] === PORTABLE_DOCKER_NETWORK_NAME
      ? requireRecord(attachments[0][1], "Hermes Portable inference registry attachment")
      : null;
  const labels = sortedStringRecord(config.Labels, "Hermes Portable inference registry labels");
  const running = state.Running;
  const status = state.Status;
  const normalizedStatus = running === true ? "running" : typeof status === "string" ? status : "";
  if (
    typeof registry.Id !== "string" ||
    !NETWORK_ID.test(registry.Id) ||
    registry.Name !== REGISTRY_CONTAINER ||
    typeof running !== "boolean" ||
    (running === false && !REGISTRY_AT_REST_STATES.has(normalizedStatus)) ||
    labels[PORTABLE_MANAGED_LABEL] !== "1" ||
    !attachment ||
    typeof attachment.NetworkID !== "string" ||
    typeof attachment.IPAddress !== "string"
  ) {
    throw new Error("Hermes Portable inference registry authority changed after host preparation.");
  }
  return Object.freeze({
    runtimeId: registry.Id,
    running,
    status: normalizedStatus,
    labels,
    networkId: attachment.NetworkID,
    ipAddress: attachment.IPAddress,
  });
}

function canonicalPortableNetworkAuthority(
  network: PortableNetworkShape,
  registry: PortableRegistryShape,
): object {
  return Object.freeze({
    network: network.canonical,
    registry: Object.freeze({
      runtimeId: registry.runtimeId,
      name: REGISTRY_CONTAINER,
      running: true,
      labels: registry.labels,
      networkId: network.id,
      networkName: PORTABLE_DOCKER_NETWORK_NAME,
      ipAddress: PORTABLE_REGISTRY_IP,
    }),
  });
}

function requirePortableRegistryNetwork(
  network: PortableNetworkShape,
  registry: PortableRegistryShape,
): void {
  if (
    registry.networkId !== network.id ||
    (registry.ipAddress !== PORTABLE_REGISTRY_IP && registry.ipAddress !== "")
  ) {
    throw new Error("Hermes Portable inference registry authority changed after host preparation.");
  }
}

function inspectPortableNetworkSnapshot(
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
  registryReference = REGISTRY_CONTAINER,
): {
  readonly networkId: string;
  readonly gatewayIp: string;
  readonly authoritySha256: string;
  readonly canonical: object;
} {
  const network = inspectPortableNetworkShape(engine);
  const registry = inspectPortableRegistryShape(engine, registryReference);
  requirePortableRegistryNetwork(network, registry);
  if (!registry.running || registry.ipAddress !== PORTABLE_REGISTRY_IP) {
    throw new Error("Hermes Portable inference registry authority changed after host preparation.");
  }
  const canonical = canonicalPortableNetworkAuthority(network, registry);
  return Object.freeze({
    networkId: network.id,
    gatewayIp: network.gatewayIp,
    authoritySha256: digest(canonical),
    canonical,
  });
}

export interface PreparedPortableRegistryRecovery {
  readonly started: boolean;
  readonly assertCurrent: () => void;
  readonly rollback: () => void;
  readonly release: () => void;
}

export type PortableRegistryRecoveryPhase =
  | "START_DISPATCH"
  | "SETTLEMENT_CURRENTNESS"
  | "NETWORK_INSPECTION"
  | "PINNED_REGISTRY_INSPECTION"
  | "PENDING_DEADLINE"
  | "POSTCONDITION";

export class PortableRegistryRecoveryPhaseError extends Error {
  constructor(readonly phase: PortableRegistryRecoveryPhase) {
    super("Hermes Portable inference registry recovery stopped at a fixed boundary.");
    this.name = "PortableRegistryRecoveryPhaseError";
  }
}

export class PortableRegistryRecoveryRestorationError extends Error {
  constructor() {
    super("Hermes Portable inference registry restoration was not proved.");
    this.name = "PortableRegistryRecoveryRestorationError";
  }
}

interface PortableRegistryRecoveryTiming {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => void;
}

function atRegistryRecoveryPhase<T>(phase: PortableRegistryRecoveryPhase, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof PortableRegistryRecoveryPhaseError ||
      error instanceof PortableRegistryRecoveryRestorationError
    ) {
      throw error;
    }
    throw new PortableRegistryRecoveryPhaseError(phase);
  }
}

function defaultRegistrySettlementSleep(milliseconds: number): void {
  if (milliseconds > 0) {
    Atomics.wait(REGISTRY_SETTLEMENT_SLEEP_BUFFER, 0, 0, milliseconds);
  }
}

function registrySettlementClock(now: () => number): () => number {
  let previous: number | undefined;
  return () => {
    const current = now();
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      (previous !== undefined && current < previous)
    ) {
      throw new Error("Hermes Portable inference registry settlement clock is invalid.");
    }
    previous = current;
    return current;
  };
}

type PortableRegistryStartObservation =
  | { readonly kind: "pending" }
  | {
      readonly kind: "running";
      readonly authority: ReturnType<typeof capturePortableNetworkAuthorityForReference>;
    };

function observePortableRegistryStart(
  engine: PortableInferenceEngine,
  expectedNetwork: PortableNetworkShape,
  runtimeId: string,
  expectedAuthoritySha256: string,
): PortableRegistryStartObservation {
  const network = atRegistryRecoveryPhase("NETWORK_INSPECTION", () =>
    inspectPortableNetworkShape(engine),
  );
  if (!isDeepStrictEqual(network, expectedNetwork)) {
    throw new PortableRegistryRecoveryPhaseError("POSTCONDITION");
  }
  const registry = atRegistryRecoveryPhase("PINNED_REGISTRY_INSPECTION", () => {
    const inspected = inspectPortableRegistryShape(engine, runtimeId);
    requirePortableRegistryNetwork(network, inspected);
    return inspected;
  });
  if (registry.runtimeId !== runtimeId) {
    throw new PortableRegistryRecoveryPhaseError("POSTCONDITION");
  }
  const canonical = canonicalPortableNetworkAuthority(network, registry);
  const authoritySha256 = digest(canonical);
  if (authoritySha256 !== expectedAuthoritySha256) {
    throw new PortableRegistryRecoveryPhaseError("POSTCONDITION");
  }
  if (registry.running && registry.ipAddress === "") {
    return Object.freeze({ kind: "pending" });
  }
  if (!registry.running || registry.ipAddress !== PORTABLE_REGISTRY_IP) {
    throw new PortableRegistryRecoveryPhaseError("POSTCONDITION");
  }
  return Object.freeze({
    kind: "running",
    authority: portableNetworkAuthorityFromSnapshot(
      engine,
      runtimeId,
      Object.freeze({
        networkId: network.id,
        gatewayIp: network.gatewayIp,
        authoritySha256,
        canonical,
      }),
    ),
  });
}

function settlePortableRegistryStart(
  engine: PortableInferenceEngine,
  expectedNetwork: PortableNetworkShape,
  runtimeId: string,
  expectedAuthoritySha256: string,
  assertRecoveryCurrent: () => void,
  timing: Partial<PortableRegistryRecoveryTiming>,
): ReturnType<typeof capturePortableNetworkAuthorityForReference> {
  const now = registrySettlementClock(timing.now ?? Date.now);
  const sleep = timing.sleep ?? defaultRegistrySettlementSleep;
  const deadline =
    atRegistryRecoveryPhase("PENDING_DEADLINE", now) + REGISTRY_START_SETTLEMENT_TIMEOUT_MS;
  if (!Number.isFinite(deadline)) {
    throw new PortableRegistryRecoveryPhaseError("PENDING_DEADLINE");
  }
  for (;;) {
    atRegistryRecoveryPhase("PENDING_DEADLINE", now);
    assertRecoveryCurrent();
    const observation = observePortableRegistryStart(
      engine,
      expectedNetwork,
      runtimeId,
      expectedAuthoritySha256,
    );
    if (observation.kind === "running") {
      assertRecoveryCurrent();
      return observation.authority;
    }
    const remaining = deadline - atRegistryRecoveryPhase("PENDING_DEADLINE", now);
    if (remaining <= 0) {
      throw new PortableRegistryRecoveryPhaseError("PENDING_DEADLINE");
    }
    atRegistryRecoveryPhase("PENDING_DEADLINE", () =>
      sleep(Math.min(REGISTRY_START_SETTLEMENT_INTERVAL_MS, remaining)),
    );
  }
}

function inspectExactStoppedRegistry(
  engine: PortableInferenceEngine,
  expectedNetwork: PortableNetworkShape,
  runtimeId: string,
  expectedAuthoritySha256: string,
): PortableRegistryShape {
  const network = inspectPortableNetworkShape(engine);
  if (!isDeepStrictEqual(network, expectedNetwork)) {
    throw new Error("Hermes Portable inference registry recovery network authority changed.");
  }
  const current = inspectPortableRegistryShape(engine, runtimeId);
  requirePortableRegistryNetwork(network, current);
  if (
    current.runtimeId !== runtimeId ||
    current.running ||
    digest(canonicalPortableNetworkAuthority(network, current)) !== expectedAuthoritySha256
  ) {
    throw new Error("Hermes Portable inference registry recovery authority changed.");
  }
  return current;
}

function inspectPinnedRegistryRunning(engine: PortableInferenceEngine, runtimeId: string): boolean {
  const result = engine.capture(["container", "inspect", runtimeId], 30_000);
  if (result.error || result.status !== 0) {
    throw new Error("Hermes Portable inference could not reinspect its pinned registry runtime.");
  }
  const registry = parseExactInspection(result.stdout, "Hermes Portable inference registry");
  const state = requireRecord(registry.State, "Hermes Portable inference registry state");
  if (registry.Id !== runtimeId || typeof state.Running !== "boolean") {
    throw new Error("Hermes Portable inference pinned registry identity changed.");
  }
  return state.Running;
}

/** Start only the exact stopped registry whose prospective authority matches the published receipt. */
export function preparePortableRegistryRecovery(
  engine: PortableInferenceEngine,
  expectedAuthoritySha256: string,
  assertEngineCurrent: () => void,
  assertCallerCurrent: () => void,
  timing: Partial<PortableRegistryRecoveryTiming> = {},
): PreparedPortableRegistryRecovery {
  if (!NETWORK_ID.test(expectedAuthoritySha256)) {
    throw new Error("Hermes Portable inference registry recovery digest is malformed.");
  }
  const assertRecoveryCurrent = () => {
    assertCallerCurrent();
    atRegistryRecoveryPhase("SETTLEMENT_CURRENTNESS", assertEngineCurrent);
  };
  assertRecoveryCurrent();
  const network = atRegistryRecoveryPhase("NETWORK_INSPECTION", () =>
    inspectPortableNetworkShape(engine),
  );
  const candidate = atRegistryRecoveryPhase("PINNED_REGISTRY_INSPECTION", () => {
    const inspected = inspectPortableRegistryShape(engine, REGISTRY_CONTAINER);
    requirePortableRegistryNetwork(network, inspected);
    return inspected;
  });
  const prospectiveSha256 = digest(canonicalPortableNetworkAuthority(network, candidate));
  if (prospectiveSha256 !== expectedAuthoritySha256) {
    throw new PortableRegistryRecoveryPhaseError("POSTCONDITION");
  }
  if (candidate.running) {
    const authority = atRegistryRecoveryPhase("POSTCONDITION", () =>
      capturePortableNetworkAuthority(engine),
    );
    if (authority.authoritySha256 !== expectedAuthoritySha256) {
      throw new PortableRegistryRecoveryPhaseError("POSTCONDITION");
    }
    let released = false;
    const assertCurrent = () => {
      if (released) throw new Error("Hermes Portable inference registry recovery was released.");
      assertRecoveryCurrent();
      authority.assertCurrent();
    };
    return Object.freeze({
      started: false,
      assertCurrent,
      rollback: assertCurrent,
      release: () => {
        released = true;
      },
    });
  }
  const runtimeId = candidate.runtimeId;
  atRegistryRecoveryPhase("POSTCONDITION", () =>
    inspectExactStoppedRegistry(engine, network, runtimeId, expectedAuthoritySha256),
  );
  assertRecoveryCurrent();
  let authority: ReturnType<typeof capturePortableNetworkAuthorityForReference>;
  try {
    atRegistryRecoveryPhase("START_DISPATCH", () =>
      engine.capture(["start", runtimeId], REGISTRY_MUTATION_TIMEOUT_MS),
    );
    authority = settlePortableRegistryStart(
      engine,
      network,
      runtimeId,
      expectedAuthoritySha256,
      assertRecoveryCurrent,
      timing,
    );
  } catch (error) {
    try {
      if (inspectPinnedRegistryRunning(engine, runtimeId)) {
        const stopped = engine.capture(
          ["stop", "--time", String(REGISTRY_STOP_GRACE_SECONDS), runtimeId],
          REGISTRY_MUTATION_TIMEOUT_MS,
        );
        if (stopped.error || stopped.status !== 0) {
          throw new Error("registry stop was not acknowledged");
        }
      }
      inspectExactStoppedRegistry(engine, network, runtimeId, expectedAuthoritySha256);
      assertEngineCurrent();
    } catch {
      throw new PortableRegistryRecoveryRestorationError();
    }
    throw error;
  }
  let released = false;
  const assertCurrent = () => {
    if (released) throw new Error("Hermes Portable inference registry recovery was released.");
    assertRecoveryCurrent();
    authority.assertCurrent();
  };
  const rollback = () => {
    if (released) throw new Error("Hermes Portable inference registry recovery was released.");
    assertEngineCurrent();
    if (inspectPinnedRegistryRunning(engine, runtimeId)) {
      const stopped = engine.capture(
        ["stop", "--time", String(REGISTRY_STOP_GRACE_SECONDS), runtimeId],
        REGISTRY_MUTATION_TIMEOUT_MS,
      );
      if (stopped.error || stopped.status !== 0) {
        throw new Error("Hermes Portable inference could not restore its exact stopped registry.");
      }
    }
    inspectExactStoppedRegistry(engine, network, runtimeId, expectedAuthoritySha256);
    assertEngineCurrent();
    released = true;
  };
  return Object.freeze({
    started: true,
    assertCurrent,
    rollback,
    release: () => {
      released = true;
    },
  });
}

function portableNetworkAuthorityFromSnapshot(
  engine: PortableInferenceEngine,
  registryReference: string,
  captured: ReturnType<typeof inspectPortableNetworkSnapshot>,
) {
  return Object.freeze({
    networkId: captured.networkId,
    name: PORTABLE_DOCKER_NETWORK_NAME,
    subnet: PORTABLE_DOCKER_NETWORK_SUBNET,
    gatewayIp: captured.gatewayIp,
    listenerIp: PORTABLE_HOST_GATEWAY_IP,
    authoritySha256: captured.authoritySha256,
    assertCurrent() {
      const refreshed = inspectPortableNetworkSnapshot(engine, registryReference);
      if (
        refreshed.authoritySha256 !== captured.authoritySha256 ||
        !isDeepStrictEqual(refreshed.canonical, captured.canonical)
      ) {
        throw new Error("Hermes Portable inference network or registry authority drifted.");
      }
    },
  });
}

function capturePortableNetworkAuthorityForReference(
  engine: PortableInferenceEngine,
  registryReference: string,
) {
  return portableNetworkAuthorityFromSnapshot(
    engine,
    registryReference,
    inspectPortableNetworkSnapshot(engine, registryReference),
  );
}

export function capturePortableNetworkAuthority(
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
) {
  return capturePortableNetworkAuthorityForReference(engine, REGISTRY_CONTAINER);
}

function throwImagePullFailure(
  image: string,
  result: PortablePodmanResult,
  redactSensitive: DiagnosticRedactor,
): never {
  const raw = [result.error?.message, result.stderr].filter(Boolean).join("\n");
  const detail = redactSensitive(raw.replace(DIAGNOSTIC_CONTROL_CHARACTERS, ""))
    .replace(DIAGNOSTIC_CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, IMAGE_PULL_DIAGNOSTIC_LIMIT);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const outcome = result.error
    ? code === "ETIMEDOUT"
      ? `timed out after ${String(IMAGE_PULL_TIMEOUT_MS)} ms`
      : "spawn failed"
    : `exited with status ${String(result.status)}`;
  throw new Error(
    `Hermes Portable inference could not acquire an immutable runtime image ${image}: Podman pull ${outcome}.${detail ? ` Detail: ${detail}` : ""}`,
  );
}

function acquireRetainedImage(
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
  image: string,
  assertCurrent: () => void,
  redactSensitive: DiagnosticRedactor,
): void {
  assertCurrent();
  const prior = engine.capture(["image", "exists", image], 30_000);
  if (prior.error || (prior.status !== 0 && prior.status !== 1)) {
    throw new Error("Hermes Portable inference could not inspect immutable image custody.");
  }
  if (prior.status === 0) return;
  const pull = engine.capture(["pull", image], IMAGE_PULL_TIMEOUT_MS);
  if (pull.error || pull.status !== 0) {
    throwImagePullFailure(image, pull, redactSensitive);
  }
  const exists = engine.capture(["image", "exists", image], 30_000);
  if (exists.error || exists.status !== 0) {
    throw new Error("Hermes Portable inference could not prove its immutable runtime image.");
  }
  assertCurrent();
}

export function withRetainedImageAcquisition(
  bundle: RuntimeProviderBundle,
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
  assertCurrent: () => void,
  redactSensitive: DiagnosticRedactor,
): RuntimeProviderBundle {
  if (!bundle.hostLocalInference.supported) {
    throw new Error("Hermes Portable inference runtime lacks managed startup authority.");
  }
  const hostLocalInference = bundle.hostLocalInference;
  return Object.freeze({
    ...bundle,
    hostLocalInference: Object.freeze({
      ...hostLocalInference,
      createOperation(input: HostLocalInferenceOperationInput) {
        const operation = hostLocalInference.createOperation(input);
        const managedRuntime = operation.managedRuntime;
        if (!managedRuntime) {
          throw new Error("Hermes Portable inference operation lacks managed runtime authority.");
        }
        const runtime: HostLocalInferenceRuntime = Object.freeze({
          ...managedRuntime,
          startManaged(
            managedInput: HostLocalManagedInferenceInput,
            writer: HostLocalInferenceReceiptWriter,
          ) {
            // Images are immutable shared cache state. This transaction owns
            // the exact container, model, route, and receipt, but deliberately
            // never deletes a digest image that another operation may reuse.
            for (const image of [PORTABLE_OLLAMA_IMAGE, PORTABLE_PROBE_IMAGE]) {
              acquireRetainedImage(engine, image, assertCurrent, redactSensitive);
            }
            return managedRuntime.startManaged(managedInput, writer);
          },
        });
        return Object.freeze({ ...operation, managedRuntime: runtime });
      },
    }),
  });
}

export const hermesPortableOllamaAuthorityInternals = Object.freeze({
  captureCurrentCdiDevices,
  captureCurrentGpuDevices,
  captureQualifiedGpuDevices,
  capturePortableNetworkAuthority,
});
