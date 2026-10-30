// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { RuntimeProviderBundle } from "./contract";

export interface InstalledRuntimeDiagnostics {
  capture(channel: string, chunk: Buffer | string): void;
}

export interface InstalledRuntimeWorkload {
  readonly name: string;
  readonly policy: string;
  readonly command: string[];
  readonly directory: string;
  readonly ports?: number[];
  readonly terminal?: boolean;
  readonly environment: Record<string, string>;
}

export type InstalledRuntimeRemoval = {
  sandboxName: string;
  gateway: Pick<ChildProcess, "exitCode" | "signalCode"> | null | undefined;
  stateSession: { assertHeld(): void } | null;
  timeout?: number;
  creationRejected?: boolean;
};

/** A private installed session, not authority over a portable persisted sandbox. */
export interface InstalledRuntimeSession {
  readonly providerId: string;
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly gatewayProcessId: number;
  readonly ownCommandProcess: (child: ChildProcess) => void;
  prepare(): Promise<void>;
  configuration(template: string): string;
  preflightConfiguration(file: string): void;
  gatewayEnvironment(configuration: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  startGateway(input: {
    port: number;
    environment: NodeJS.ProcessEnv;
    stdio: SpawnOptions["stdio"];
    windowsHide?: boolean;
    logLevel?: "info" | "warn";
    explicitMtlsValue?: boolean;
  }): ChildProcess;
  registerGateway(
    port: number,
    name: string,
    environment: NodeJS.ProcessEnv,
    labels: readonly [string, string],
    diagnostics?: InstalledRuntimeDiagnostics,
  ): Promise<void>;
  startWorkload(
    workload: InstalledRuntimeWorkload,
    environment: NodeJS.ProcessEnv,
    stdio: SpawnOptions["stdio"],
  ): ChildProcess;
  createWorkload(
    workload: InstalledRuntimeWorkload,
    environment: NodeJS.ProcessEnv,
    label: string,
    diagnostics?: InstalledRuntimeDiagnostics,
  ): Promise<unknown>;
  deleteWorkload(
    name: string,
    environment: NodeJS.ProcessEnv,
    label: string,
    timeout?: number,
    diagnostics?: InstalledRuntimeDiagnostics,
  ): Promise<unknown>;
  requestWorkloadDeletion(
    environment: NodeJS.ProcessEnv,
    ownership: InstalledRuntimeRemoval,
  ): Promise<void>;
  confirmRegistryEmpty(
    environment: NodeJS.ProcessEnv,
    ownership?: InstalledRuntimeRemoval,
  ): Promise<void>;
  waitForCompletion(
    environment: NodeJS.ProcessEnv,
    name: string,
    gateway: Pick<ChildProcess, "exitCode" | "signalCode">,
    state: { assertHeld(): void } | null,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<"AgentCompleted" | "ExecFailed" | "MainProcessCompleted" | "MainProcessFailed">;
  watchWorkload(
    environment: NodeJS.ProcessEnv,
    name: string,
    gateway: Pick<ChildProcess, "exitCode" | "signalCode">,
    state: { assertHeld(): void } | null,
    signal: AbortSignal,
  ): Promise<void>;
  stopGateway(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface InstalledRuntimeSessionInput {
  readonly installation: string;
  readonly runRoot: string;
}

/** Resolve the bundle capability before any private directory or process exists. */
export function createInstalledRuntimeSession(
  bundle: RuntimeProviderBundle,
  input: InstalledRuntimeSessionInput,
): InstalledRuntimeSession {
  const surface = bundle.gateway.installedSession;
  if (!surface?.supported || surface.providerId !== bundle.identity.id) {
    throw new Error("The selected provider has no installed-session authority.");
  }
  const session = surface.create(input);
  if (session.providerId !== bundle.identity.id) {
    throw new Error("The installed session does not match its provider.");
  }
  return session;
}
