// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";

import { dockerCapture } from "../../adapters/docker/local-model-runtime";
import { loadManagedVllmApiKey } from "../vllm-api-key";
import { buildVllmDockerEnv } from "../vllm-docker-env";
import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";

export const HOST_LOCAL_VLLM_CONTAINER_NAME = "nemoclaw-vllm" as const;
export const HOST_LOCAL_VLLM_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm" as const;
export const HOST_LOCAL_VLLM_AUTH_LABEL = "com.nvidia.nemoclaw.managed-vllm-auth" as const;
const HOST_LOCAL_VLLM_PORT = 8000;
const DUAL_STATION_VLLM_ROLE_LABEL = "com.nvidia.nemoclaw.vllm-role";

interface DockerInspectRow {
  Id?: unknown;
  Name?: unknown;
  State?: { Running?: unknown };
  Config?: { Env?: unknown; Labels?: unknown };
  NetworkSettings?: { Ports?: unknown };
}

export interface RecoverHostLocalManagedVllmOptions {
  dockerInspect?: () => string;
  loadApiKey?: () => string | null;
  onManagedContainerObserved?: () => void;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function inspectHostLocalContainer(): string {
  return dockerCapture(["container", "inspect", HOST_LOCAL_VLLM_CONTAINER_NAME], {
    env: buildVllmDockerEnv(),
    ignoreError: true,
    timeout: 10_000,
  });
}

/** Recover only the exact authenticated, loopback-published host-local container. */
export function recoverHostLocalManagedVllmEndpoint(
  options: RecoverHostLocalManagedVllmOptions = {},
): { baseUrl: string; apiKey: string } | null {
  const source = (options.dockerInspect ?? inspectHostLocalContainer)().trim();
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
      ? (ports as Record<string, unknown>)["8000/tcp"]
      : null;
  const binding = Array.isArray(portBindings) && portBindings.length === 1 ? portBindings[0] : null;
  const env = Array.isArray(row.Config?.Env) ? row.Config.Env : [];
  const configuredKeyRows = env.filter(
    (value): value is string => typeof value === "string" && value.startsWith("VLLM_API_KEY="),
  );
  if (
    row.Id === undefined ||
    typeof row.Id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test(row.Id) ||
    row.Name !== `/${HOST_LOCAL_VLLM_CONTAINER_NAME}` ||
    row.State?.Running !== true ||
    !binding ||
    typeof binding !== "object" ||
    (binding as { HostIp?: unknown }).HostIp !== "127.0.0.1" ||
    (binding as { HostPort?: unknown }).HostPort !== String(HOST_LOCAL_VLLM_PORT) ||
    configuredKeyRows.length !== 1 ||
    typeof authFingerprint !== "string"
  ) {
    throw new Error("Managed host-local vLLM runtime identity is unsafe or incomplete.");
  }

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
  return { baseUrl: `http://127.0.0.1:${String(HOST_LOCAL_VLLM_PORT)}`, apiKey };
}
