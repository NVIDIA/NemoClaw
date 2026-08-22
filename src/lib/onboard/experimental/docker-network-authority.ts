// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_DOCKER_DRIVER_NETWORK_NAME = "openshell-docker";
export const DOCKER_NETWORK_IPAM_INSPECT_FORMAT = "{{json .IPAM.Config}}";

export interface DockerNetworkIpamEntry {
  readonly subnet?: string;
  readonly gatewayIp?: string;
}

export function resolveDockerDriverNetworkName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSHELL_DOCKER_NETWORK_NAME || DEFAULT_DOCKER_DRIVER_NETWORK_NAME;
}

export function parseDockerNetworkIpamEntries(
  raw: string,
): readonly DockerNetworkIpamEntry[] | undefined {
  const text = raw.trim();
  if (!text || text === "<no value>") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const entries: DockerNetworkIpamEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const subnet = typeof record.Subnet === "string" ? record.Subnet : undefined;
    const gatewayIp = typeof record.Gateway === "string" ? record.Gateway : undefined;
    if (subnet || gatewayIp) entries.push({ subnet, gatewayIp });
  }
  return entries.length > 0 ? entries : undefined;
}
