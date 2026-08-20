// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dockerCapture } from "../../adapters/docker/local-model-runtime";
import { writeLocalAdapterJsonFile } from "../local-adapter-lifecycle";
import { loadManagedVllmApiKey, managedVllmStateDir } from "../vllm-api-key";
import { buildLocalManagedVllmDockerEnv } from "../vllm-docker-env";
import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";
import {
  resolveManagedVllmBridgeHost,
  validateManagedVllmBridgeHost,
} from "./vllm-host-local-network";

export { resolveManagedVllmBridgeHost };

export const HOST_LOCAL_VLLM_CONTAINER_NAME = "nemoclaw-vllm" as const;
export const HOST_LOCAL_VLLM_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm" as const;
export const HOST_LOCAL_VLLM_AUTH_LABEL = "com.nvidia.nemoclaw.managed-vllm-auth" as const;
export const HOST_LOCAL_VLLM_CATALOG_LABEL = "com.nvidia.nemoclaw.serving-catalog-digest" as const;
export const HOST_LOCAL_VLLM_PRESET_LABEL = "com.nvidia.nemoclaw.serving-preset" as const;
export const HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL =
  "com.nvidia.nemoclaw.serving-preset-digest" as const;
export const HOST_LOCAL_VLLM_RECIPE_LABEL = "com.nvidia.nemoclaw.serving-recipe" as const;
export const HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL =
  "com.nvidia.nemoclaw.serving-recipe-digest" as const;
export const HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE = "host-local-vllm-runtime.json" as const;
const HOST_LOCAL_VLLM_CONTAINER_PORT = 8000;
const DUAL_STATION_VLLM_ROLE_LABEL = "com.nvidia.nemoclaw.vllm-role";

interface DockerInspectRow {
  Id?: unknown;
  Name?: unknown;
  State?: { Running?: unknown };
  Config?: { Env?: unknown; Labels?: unknown };
  NetworkSettings?: { Ports?: unknown };
}

export interface HostLocalVllmServingIdentity {
  readonly catalogDigest: string;
  readonly presetId: string;
  readonly presetDigest: string;
  readonly recipeId: string;
  readonly recipeDigest: string;
}

interface HostLocalVllmRuntimeReceipt {
  readonly schemaVersion: 1;
  readonly receiptRef: "vllm.host-local.receipt/v1";
  readonly serving: HostLocalVllmServingIdentity;
  readonly container: { readonly id: string; readonly name: typeof HOST_LOCAL_VLLM_CONTAINER_NAME };
  readonly authentication: { readonly fingerprint: string };
}

export interface RecoverHostLocalManagedVllmOptions {
  dockerCapture?: typeof dockerCapture;
  dockerInspect?: () => string;
  loadApiKey?: () => string | null;
  onManagedContainerObserved?: () => void;
  resolveBridgeHost?: () => string;
  stateDir?: string;
}

function servingIdentityFromLabels(
  labels: Record<string, unknown>,
): HostLocalVllmServingIdentity | null {
  const values = {
    catalogDigest: labels[HOST_LOCAL_VLLM_CATALOG_LABEL],
    presetId: labels[HOST_LOCAL_VLLM_PRESET_LABEL],
    presetDigest: labels[HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL],
    recipeId: labels[HOST_LOCAL_VLLM_RECIPE_LABEL],
    recipeDigest: labels[HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL],
  };
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return null;
  if (
    present !== Object.keys(values).length ||
    typeof values.catalogDigest !== "string" ||
    typeof values.presetId !== "string" ||
    typeof values.presetDigest !== "string" ||
    typeof values.recipeId !== "string" ||
    typeof values.recipeDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(values.catalogDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(values.presetDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(values.recipeDigest)
  ) {
    throw new Error("Managed host-local vLLM serving identity labels are incomplete.");
  }
  return values as HostLocalVllmServingIdentity;
}

function runtimeReceiptPath(stateDir: string): string {
  return path.join(stateDir, HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE);
}

function sameServingIdentity(
  left: HostLocalVllmServingIdentity,
  right: HostLocalVllmServingIdentity,
): boolean {
  return (
    left.catalogDigest === right.catalogDigest &&
    left.presetId === right.presetId &&
    left.presetDigest === right.presetDigest &&
    left.recipeId === right.recipeId &&
    left.recipeDigest === right.recipeDigest
  );
}

function readRuntimeReceipt(stateDir: string): unknown {
  const filePath = runtimeReceiptPath(stateDir);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform.");
  }
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("Managed host-local vLLM runtime receipt is not owner-only.");
    }
    try {
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      throw new Error("Managed host-local vLLM runtime receipt is not valid JSON.");
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseRuntimeReceipt(value: unknown): HostLocalVllmRuntimeReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const serving = receipt.serving;
  const container = receipt.container;
  const authentication = receipt.authentication;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptRef !== "vllm.host-local.receipt/v1" ||
    !serving ||
    typeof serving !== "object" ||
    Array.isArray(serving) ||
    !container ||
    typeof container !== "object" ||
    Array.isArray(container) ||
    !authentication ||
    typeof authentication !== "object" ||
    Array.isArray(authentication)
  ) {
    return null;
  }
  const identity = serving as Record<string, unknown>;
  const containerRecord = container as Record<string, unknown>;
  const auth = authentication as Record<string, unknown>;
  const exactKeys = (record: Record<string, unknown>, expected: readonly string[]) => {
    const actual = Object.keys(record).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  };
  try {
    const normalized = servingIdentityFromLabels({
      [HOST_LOCAL_VLLM_CATALOG_LABEL]: identity.catalogDigest,
      [HOST_LOCAL_VLLM_PRESET_LABEL]: identity.presetId,
      [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: identity.presetDigest,
      [HOST_LOCAL_VLLM_RECIPE_LABEL]: identity.recipeId,
      [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: identity.recipeDigest,
    });
    if (
      !normalized ||
      !exactKeys(receipt, [
        "authentication",
        "container",
        "receiptRef",
        "schemaVersion",
        "serving",
      ]) ||
      !exactKeys(identity, [
        "catalogDigest",
        "presetDigest",
        "presetId",
        "recipeDigest",
        "recipeId",
      ]) ||
      !exactKeys(containerRecord, ["id", "name"]) ||
      !exactKeys(auth, ["fingerprint"]) ||
      containerRecord.name !== HOST_LOCAL_VLLM_CONTAINER_NAME ||
      typeof containerRecord.id !== "string" ||
      !/^[a-f0-9]{12,64}$/u.test(containerRecord.id) ||
      typeof auth.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(auth.fingerprint)
    ) {
      return null;
    }
    return value as HostLocalVllmRuntimeReceipt;
  } catch {
    return null;
  }
}

export function validateHostLocalVllmRuntimeReceipt(
  input: {
    readonly containerId: string;
    readonly labels: Record<string, unknown>;
    readonly authFingerprint: string;
  },
  stateDir = managedVllmStateDir(),
): HostLocalVllmServingIdentity | null {
  const identity = servingIdentityFromLabels(input.labels);
  if (!identity) return null;
  const receipt = parseRuntimeReceipt(readRuntimeReceipt(stateDir));
  if (
    !receipt ||
    receipt.container.id !== input.containerId ||
    receipt.authentication.fingerprint !== input.authFingerprint ||
    !sameServingIdentity(receipt.serving, identity)
  ) {
    throw new Error("Managed host-local vLLM runtime does not match its ownership receipt.");
  }
  return identity;
}

export function persistHostLocalVllmRuntimeReceipt(
  input: {
    readonly containerId: string;
    readonly authFingerprint: string;
    readonly serving: HostLocalVllmServingIdentity;
  },
  stateDir = managedVllmStateDir(),
): void {
  const serving = servingIdentityFromLabels({
    [HOST_LOCAL_VLLM_CATALOG_LABEL]: input.serving.catalogDigest,
    [HOST_LOCAL_VLLM_PRESET_LABEL]: input.serving.presetId,
    [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: input.serving.presetDigest,
    [HOST_LOCAL_VLLM_RECIPE_LABEL]: input.serving.recipeId,
    [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: input.serving.recipeDigest,
  });
  if (!serving) throw new Error("Managed host-local vLLM serving identity is missing.");
  writeLocalAdapterJsonFile(runtimeReceiptPath(stateDir), {
    schemaVersion: 1,
    receiptRef: "vllm.host-local.receipt/v1",
    serving,
    container: { id: input.containerId, name: HOST_LOCAL_VLLM_CONTAINER_NAME },
    authentication: { fingerprint: input.authFingerprint },
  } satisfies HostLocalVllmRuntimeReceipt);
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function inspectHostLocalContainer(
  capture: typeof dockerCapture,
  dockerEnv: Record<string, string>,
): string {
  return capture(["container", "inspect", HOST_LOCAL_VLLM_CONTAINER_NAME], {
    env: dockerEnv,
    ignoreError: true,
    timeout: 10_000,
  });
}

/** Recover only the exact authenticated host-local container with bounded host bindings. */
export function recoverHostLocalManagedVllmEndpoint(
  options: RecoverHostLocalManagedVllmOptions = {},
): { baseUrl: string; apiKey: string } | null {
  const capture = options.dockerCapture ?? dockerCapture;
  const dockerEnv = buildLocalManagedVllmDockerEnv();
  const source = (
    options.dockerInspect ?? (() => inspectHostLocalContainer(capture, dockerEnv))
  )().trim();
  if (!source) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Managed host-local vLLM container inspection returned invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Managed host-local vLLM container inspection was ambiguous.");
  }
  const row = parsed[0] as DockerInspectRow;
  const labels = row.Config?.Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return null;
  const labelMap = labels as Record<string, unknown>;
  const authFingerprint = labelMap[HOST_LOCAL_VLLM_AUTH_LABEL];
  const dualRole = labelMap[DUAL_STATION_VLLM_ROLE_LABEL];
  if (dualRole === "head" || dualRole === "worker") return null;
  if (labelMap[HOST_LOCAL_VLLM_MANAGED_LABEL] !== "true" || authFingerprint === undefined) {
    return null;
  }
  options.onManagedContainerObserved?.();

  const ports = row.NetworkSettings?.Ports;
  const portBindings =
    ports && typeof ports === "object" && !Array.isArray(ports)
      ? (ports as Record<string, unknown>)[`${String(HOST_LOCAL_VLLM_CONTAINER_PORT)}/tcp`]
      : null;
  const bindings = Array.isArray(portBindings) ? portBindings : [];
  const loopbackBinding = bindings.find(
    (binding) =>
      binding &&
      typeof binding === "object" &&
      (binding as { HostIp?: unknown }).HostIp === "127.0.0.1",
  );
  const expectedBridgeHost = validateManagedVllmBridgeHost(
    options.resolveBridgeHost
      ? options.resolveBridgeHost()
      : resolveManagedVllmBridgeHost(capture, dockerEnv),
  );
  const bridgeBinding = bindings.find(
    (binding) =>
      binding &&
      typeof binding === "object" &&
      (binding as { HostIp?: unknown }).HostIp === expectedBridgeHost,
  );
  const env = Array.isArray(row.Config?.Env) ? row.Config.Env : [];
  const configuredKeyRows = env.filter(
    (value): value is string => typeof value === "string" && value.startsWith("VLLM_API_KEY="),
  );
  const loopbackHostPort =
    loopbackBinding &&
    typeof (loopbackBinding as { HostPort?: unknown }).HostPort === "string" &&
    /^\d{4,5}$/u.test((loopbackBinding as { HostPort: string }).HostPort)
      ? Number((loopbackBinding as { HostPort: string }).HostPort)
      : Number.NaN;
  const bridgeHostPort =
    bridgeBinding &&
    typeof (bridgeBinding as { HostPort?: unknown }).HostPort === "string" &&
    /^\d{4,5}$/u.test((bridgeBinding as { HostPort: string }).HostPort)
      ? Number((bridgeBinding as { HostPort: string }).HostPort)
      : Number.NaN;
  if (
    row.Id === undefined ||
    typeof row.Id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test(row.Id) ||
    row.Name !== `/${HOST_LOCAL_VLLM_CONTAINER_NAME}` ||
    row.State?.Running !== true ||
    bindings.length !== 2 ||
    !loopbackBinding ||
    !bridgeBinding ||
    !Number.isSafeInteger(loopbackHostPort) ||
    loopbackHostPort < 1024 ||
    loopbackHostPort > 65_535 ||
    String(loopbackHostPort) !== (loopbackBinding as { HostPort: string }).HostPort ||
    bridgeHostPort !== loopbackHostPort ||
    String(bridgeHostPort) !== (bridgeBinding as { HostPort: string }).HostPort ||
    configuredKeyRows.length !== 1 ||
    typeof authFingerprint !== "string"
  ) {
    throw new Error("Managed host-local vLLM runtime identity is unsafe or incomplete.");
  }

  validateHostLocalVllmRuntimeReceipt(
    { containerId: row.Id, labels: labelMap, authFingerprint },
    options.stateDir ?? managedVllmStateDir(),
  );

  const apiKey = (options.loadApiKey ?? loadManagedVllmApiKey)();
  const configuredKey = configuredKeyRows[0]!.slice("VLLM_API_KEY=".length);
  if (
    !apiKey ||
    !/^[a-f0-9]{64}$/.test(apiKey) ||
    configuredKey !== apiKey ||
    !equalHex(authFingerprint, runtimeAuthFingerprint(apiKey))
  ) {
    throw new Error("Managed host-local vLLM authentication is missing or mismatched.");
  }
  return { baseUrl: `http://127.0.0.1:${String(loopbackHostPort)}`, apiKey };
}
