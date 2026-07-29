// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  type ManagedGatewayRuntimeBinding,
  readManagedGatewayRuntimeBinding,
} from "../docker-driver-gateway-config";

export interface ManagedGatewayRecoveryRuntime {
  readonly driverName: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ManagedGatewayRecoveryAdapter {
  readonly driverName: string;
  resolveEnvironment(binding: ManagedGatewayRuntimeBinding): Readonly<Record<string, string>>;
}

export type ManagedGatewayRecoveryAdapterRegistry = Readonly<
  Record<string, ManagedGatewayRecoveryAdapter>
>;

function requiredString(
  binding: ManagedGatewayRuntimeBinding,
  key: string,
  description: string,
): string {
  const value = binding.values[key];
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error(`Managed ${binding.driverName} runtime binding has no safe ${description}.`);
  }
  return value.trim();
}

const PODMAN_RECOVERY_ADAPTER: ManagedGatewayRecoveryAdapter = {
  driverName: "podman",
  resolveEnvironment(binding) {
    const socketPath = requiredString(binding, "socket_path", "socket_path");
    if (!path.isAbsolute(socketPath)) {
      throw new Error("Managed Podman runtime binding socket_path must be absolute.");
    }
    const networkName = requiredString(binding, "network_name", "network_name");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(networkName)) {
      throw new Error("Managed Podman runtime binding network_name is invalid.");
    }
    const supervisorImage = requiredString(binding, "supervisor_image", "supervisor_image");
    if (supervisorImage.length > 2048) {
      throw new Error("Managed Podman runtime binding supervisor_image is too long.");
    }
    return {
      OPENSHELL_PODMAN_SOCKET: socketPath,
      OPENSHELL_PODMAN_NETWORK_NAME: networkName,
      OPENSHELL_SUPERVISOR_IMAGE: supervisorImage,
    };
  },
};

export const CURRENT_MANAGED_GATEWAY_RECOVERY_ADAPTERS = {
  podman: PODMAN_RECOVERY_ADAPTER,
} as const satisfies ManagedGatewayRecoveryAdapterRegistry;

export function resolveManagedGatewayRecoveryRuntime(
  options: {
    readonly driverName: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly stateDir: string;
  },
  adapters: ManagedGatewayRecoveryAdapterRegistry = CURRENT_MANAGED_GATEWAY_RECOVERY_ADAPTERS,
  readBinding: (
    stateDir: string,
  ) => ManagedGatewayRuntimeBinding | null = readManagedGatewayRuntimeBinding,
): ManagedGatewayRecoveryRuntime {
  const binding = readBinding(options.stateDir);
  if (!binding) {
    throw new Error(`Managed runtime binding is missing in '${options.stateDir}'.`);
  }
  if (binding.driverName !== options.driverName) {
    throw new Error(
      `Managed runtime binding driver '${binding.driverName}' does not match requested recovery driver '${options.driverName}'.`,
    );
  }
  const adapter = Object.hasOwn(adapters, options.driverName)
    ? adapters[options.driverName]
    : undefined;
  if (!adapter || adapter.driverName !== options.driverName) {
    throw new Error(`Managed recovery runtime adapter '${options.driverName}' is not registered.`);
  }
  const environment = adapter.resolveEnvironment(binding);
  const ambient = options.environment ?? process.env;
  for (const [key, value] of Object.entries(environment)) {
    const requested = ambient[key]?.trim();
    if (requested && requested !== value) {
      throw new Error(`${key} does not match the managed ${options.driverName} runtime binding.`);
    }
  }
  return { driverName: options.driverName, environment };
}
