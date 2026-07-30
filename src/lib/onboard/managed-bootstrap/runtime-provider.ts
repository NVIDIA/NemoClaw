// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedBootstrapAdapter, ManagedBootstrapReplacementOptions } from "./adapter";

export interface ManagedBootstrapRuntimeCommandResult {
  readonly status?: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error | null;
}

export interface ManagedBootstrapRuntimeDependencies {
  readonly runCaptureOpenshell?: (args: string[], options?: Record<string, unknown>) => string;
  readonly runOpenshell?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => ManagedBootstrapRuntimeCommandResult;
  readonly sleep?: (seconds: number) => void;
}

export interface ManagedBootstrapRuntimeAcceleration {
  readonly strategy: string;
  readonly label: string;
  readonly device: string;
  readonly arguments: readonly string[];
}

export interface ManagedBootstrapRuntimeLimit {
  readonly name: string;
  readonly soft: number;
  readonly hard: number;
}

/**
 * Driver-neutral replacement intent. Runtime providers translate this intent
 * into their own validated adapter options.
 */
export interface ManagedBootstrapRuntimeReplacementIntent {
  readonly acceleration: ManagedBootstrapRuntimeAcceleration;
  readonly limits: readonly ManagedBootstrapRuntimeLimit[];
  readonly supplementaryGroupIds: readonly string[];
}

export interface ManagedBootstrapRuntimeProvider {
  readonly driverId: string;
  createAdapter(dependencies?: ManagedBootstrapRuntimeDependencies): ManagedBootstrapAdapter;
  createReplacementOptions(
    intent: ManagedBootstrapRuntimeReplacementIntent,
  ): ManagedBootstrapReplacementOptions;
}

export type ManagedBootstrapRuntimeProviderRegistry = Readonly<
  Record<string, ManagedBootstrapRuntimeProvider>
>;

export class ManagedBootstrapRuntimeProviderError extends Error {
  constructor(message: string) {
    super(`Managed bootstrap runtime provider error: ${message}`);
    this.name = "ManagedBootstrapRuntimeProviderError";
  }
}

export function resolveManagedBootstrapRuntimeProvider(
  driverName: string,
  providers: ManagedBootstrapRuntimeProviderRegistry,
): ManagedBootstrapRuntimeProvider {
  if (!driverName || driverName.trim() !== driverName) {
    throw new ManagedBootstrapRuntimeProviderError("driver name is missing or invalid");
  }
  const provider = Object.hasOwn(providers, driverName) ? providers[driverName] : undefined;
  if (!provider) {
    throw new ManagedBootstrapRuntimeProviderError(`driver '${driverName}' is not registered`);
  }
  if (provider.driverId !== driverName) {
    throw new ManagedBootstrapRuntimeProviderError(
      `registry key '${driverName}' does not match provider '${provider.driverId}'`,
    );
  }
  return provider;
}
