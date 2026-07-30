// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxGpuProofResult } from "../../state/registry";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import type {
  ManagedBootstrapAdapter,
  ManagedBootstrapAgentIdentity,
  ManagedBootstrapCreateReceipt,
  ManagedBootstrapImageIdentity,
  ManagedBootstrapReplacementOptions,
} from "./adapter";

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

export type ManagedBootstrapRuntimeRoute = "none" | "native" | "compatibility";

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

/**
 * Provider-neutral lifecycle surface consumed by sandbox-create coordinators.
 *
 * A runtime provider may back these hooks with Docker recreation, Podman
 * watchers, MXC operations, or another implementation. Core onboarding never
 * needs the runtime's mutation handle.
 */
export interface ManagedBootstrapRuntimePatch {
  maybeApplyDuringCreate(): void | Promise<void>;
  createFailureMessage(): string | null;
  exitOnPatchError(): void | Promise<void>;
  rollbackManagedStartupAfterCreateFailure(): void | Promise<void>;
  ensureApplied(): void | Promise<void>;
  waitForSupervisorReconnectIfNeeded(): void | Promise<void>;
  commitAfterReady(): void | Promise<void>;
  selectedMode(): {
    readonly kind: string;
    readonly label: string;
    readonly device: string;
    readonly args: readonly string[];
  } | null;
  printReadinessFailureIfEnabled(): void;
  verifyGpuOrExit(
    verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult,
  ): Promise<SandboxGpuProofResult>;
}

export interface ManagedBootstrapRuntimeCreateLifecycleInput {
  readonly bootstrapIdentity: string;
  readonly request: ManagedStartupRootApplyRequest;
  readonly image: ManagedBootstrapImageIdentity;
  readonly agentIdentity: ManagedBootstrapAgentIdentity;
  readonly intendedWorkloadArgv: readonly string[];
  readonly expectedSupervisorArgv: readonly string[];
  readonly launchArgv: readonly string[];
  readonly heldWorkloadArgv: readonly string[];
  readonly route: ManagedBootstrapRuntimeRoute;
  readonly persistStartupCommand: boolean;
  readonly sandboxName: string;
  readonly sandboxGpuConfig: SandboxGpuConfig;
  readonly requiredLimits: readonly ManagedBootstrapRuntimeLimit[];
  readonly timeoutSecs: number;
  readonly onPatchFailure?: (error: unknown) => never;
  readonly network: {
    readonly inferenceProvider: string;
    readonly dockerDriverGateway: boolean;
    readonly gatewayPort: number;
  };
  readonly dependencies: ManagedBootstrapRuntimeDependencies;
}

export interface ManagedBootstrapRuntimeCreateLaunchResult<T> {
  readonly value: T;
  readonly receipt: ManagedBootstrapCreateReceipt;
}

export interface ManagedBootstrapRuntimeCreateLifecycle {
  readonly launchArgv: readonly string[];
  readonly patch: ManagedBootstrapRuntimePatch;
  /** Prepare any runtime-owned networking before the create stream begins. */
  prepareNetwork(): Promise<void>;
  /**
   * Bind create, discovery, replacement, bootstrap, and deferred cutover to
   * one provider-owned transaction.
   */
  runCreate<T>(
    launch: (input: {
      readonly heldWorkloadArgv: readonly string[];
      readonly bootstrapIdentity: string;
    }) => Promise<ManagedBootstrapRuntimeCreateLaunchResult<T>>,
  ): Promise<T>;
}

export interface ManagedBootstrapRuntimeSnapshot {
  readonly imageId: string | null;
  readonly bookkeepingImageRef: string | null;
  readonly stateError: string;
  readonly nativeGpuAttachmentState: "present" | "absent" | "unknown";
}

export interface ManagedBootstrapRuntimeCompatibilityLaunchInput {
  readonly createArgs: readonly string[];
  readonly currentRegistryImageRef: string | null;
  readonly prebuildImageId: string | null;
  readonly allowUnbuiltSource: boolean;
  readonly compatibilityPolicyPath: string;
  readonly startupCommand: readonly string[];
  readonly runtimeSnapshot: ManagedBootstrapRuntimeSnapshot | null;
}

export interface ManagedBootstrapRuntimeCompatibilityLaunch {
  readonly createArgv: readonly string[];
  readonly registryImageRef: string | null;
}

/**
 * Provider-owned native-to-compatibility evidence and argv preparation.
 * Unregistered runtimes never reach this surface; registered runtimes may
 * explicitly disable fallback by returning a non-clean baseline.
 */
export interface ManagedBootstrapRuntimeOnboardRouting {
  readonly nativeFallbackHasCleanBaseline: boolean;
  inspectNativeRuntime(): ManagedBootstrapRuntimeSnapshot | null;
  isNativeCreateRoutingFailure(output: string, sawProgress: boolean): boolean;
  isTrustedNativeRuntimeError(error: string): boolean;
  isNativeReadinessRoutingFailure(input: {
    readonly failurePhase: string | null;
    readonly runtimeError: string;
  }): boolean;
  prepareCompatibilityLaunch(
    input: ManagedBootstrapRuntimeCompatibilityLaunchInput,
  ): ManagedBootstrapRuntimeCompatibilityLaunch;
}

export interface ManagedBootstrapRuntimeProvider {
  readonly driverId: string;
  createAdapter(dependencies?: ManagedBootstrapRuntimeDependencies): ManagedBootstrapAdapter;
  createReplacementOptions(
    intent: ManagedBootstrapRuntimeReplacementIntent,
  ): ManagedBootstrapReplacementOptions;
  createCreateLifecycle(
    input: ManagedBootstrapRuntimeCreateLifecycleInput,
  ): ManagedBootstrapRuntimeCreateLifecycle;
  createOnboardRouting(input: {
    readonly sandboxName: string;
    readonly openshellArgv: (args: string[]) => string[];
    readonly nativeFallbackEnabled: boolean;
  }): ManagedBootstrapRuntimeOnboardRouting;
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
