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

function inspectPortableNetworkSnapshot(
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
): {
  readonly networkId: string;
  readonly gatewayIp: string;
  readonly authoritySha256: string;
  readonly canonical: object;
} {
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
  const registryResult = engine.capture(["container", "inspect", REGISTRY_CONTAINER], 30_000);
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
  if (
    typeof registry.Id !== "string" ||
    !NETWORK_ID.test(registry.Id) ||
    registry.Name !== REGISTRY_CONTAINER ||
    state.Running !== true ||
    labels[PORTABLE_MANAGED_LABEL] !== "1" ||
    !attachment ||
    attachment.NetworkID !== id ||
    attachment.IPAddress !== PORTABLE_REGISTRY_IP
  ) {
    throw new Error("Hermes Portable inference registry authority changed after host preparation.");
  }
  const canonical = Object.freeze({
    network: Object.freeze({
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
    registry: Object.freeze({
      runtimeId: registry.Id,
      name: REGISTRY_CONTAINER,
      running: true,
      labels,
      networkId: id,
      networkName: PORTABLE_DOCKER_NETWORK_NAME,
      ipAddress: PORTABLE_REGISTRY_IP,
    }),
  });
  return Object.freeze({
    networkId: id,
    gatewayIp: subnet.gateway,
    authoritySha256: digest(canonical),
    canonical,
  });
}

export function capturePortableNetworkAuthority(
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
) {
  const captured = inspectPortableNetworkSnapshot(engine);
  return Object.freeze({
    networkId: captured.networkId,
    name: PORTABLE_DOCKER_NETWORK_NAME,
    subnet: PORTABLE_DOCKER_NETWORK_SUBNET,
    gatewayIp: captured.gatewayIp,
    listenerIp: PORTABLE_HOST_GATEWAY_IP,
    authoritySha256: captured.authoritySha256,
    assertCurrent() {
      const refreshed = inspectPortableNetworkSnapshot(engine);
      if (
        refreshed.authoritySha256 !== captured.authoritySha256 ||
        !isDeepStrictEqual(refreshed.canonical, captured.canonical)
      ) {
        throw new Error("Hermes Portable inference network or registry authority drifted.");
      }
    },
  });
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
