// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NEMOCLAW_GATEWAY_RUNTIME_ENV = "NEMOCLAW_GATEWAY_RUNTIME";

export type NemoClawGatewayRuntime = "docker" | "podman";

/**
 * Restore the explicit native-runtime selector used by the original Podman
 * experiment. Portable profile selection remains an independent authority and
 * is resolved by its existing code path.
 */
export function resolveNemoClawGatewayRuntime(
  env: NodeJS.ProcessEnv = process.env,
): NemoClawGatewayRuntime {
  const raw = env[NEMOCLAW_GATEWAY_RUNTIME_ENV];
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "docker") return "docker";
  if (normalized === "podman") return "podman";
  throw new Error(
    `${NEMOCLAW_GATEWAY_RUNTIME_ENV} must be either "docker" or "podman"; got ${JSON.stringify(raw)}`,
  );
}

export function isPodmanGatewayRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveNemoClawGatewayRuntime(env) === "podman";
}

/** Host lifecycle context, separate from generic OpenShell client target selection. */
export const GATEWAY_HOST_RUNTIME_ENV_KEYS = [
  NEMOCLAW_GATEWAY_RUNTIME_ENV,
  "OPENSHELL_PODMAN_SOCKET",
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

export function gatewayHostRuntimeEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    GATEWAY_HOST_RUNTIME_ENV_KEYS.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name]]],
    ),
  );
}
