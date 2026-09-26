// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "./runtime-selection";
import type { OpenShellGatewayTarget, OpenShellSandboxError } from "./sandbox-observer";
import type {
  StreamSandboxCreateOptions,
  StreamSandboxCreateResult,
} from "../../sandbox/create-stream";

export type CreateOpenShellSandboxRequest = Readonly<{
  sandboxName: string;
  target: Extract<OpenShellGatewayTarget, { kind: "named" }>;
  source: Readonly<{ reference: string }>;
  policyPath?: string;
  driverConfigJson?: string;
  gpu?: Readonly<{ device?: string }>;
  resources?: Readonly<{ cpu?: string; memory?: string }>;
  providers?: readonly string[];
  autoProviders?: boolean;
  labels?: Readonly<Record<string, string>>;
  startupCommand: readonly string[];
  environment: NodeJS.ProcessEnv;
  /** Credential-free Docker client config prepared for this create process only. */
  dockerClientConfigDirectory?: string;
  workingDirectory?: string;
  runtimeSelection?: OpenShellRuntimeSelection;
}>;

export type OpenShellSandboxCreateSubmission = StreamSandboxCreateResult &
  Readonly<{
    ambiguous: boolean;
    diagnostic: string;
  }>;

export type OpenShellSandboxCreateOptions = Omit<StreamSandboxCreateOptions, "cwd" | "spawnImpl">;

export function withoutOpenShellSandboxCreateGpuDriverConfig(value: string): string | undefined {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  for (const driverName of ["docker", "podman"]) {
    const driver = parsed[driverName];
    if (!driver || typeof driver !== "object" || Array.isArray(driver)) continue;
    const config = { ...(driver as Record<string, unknown>) };
    delete config.cdi_devices;
    if (Object.keys(config).length === 0) delete parsed[driverName];
    else parsed[driverName] = config;
  }
  return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : undefined;
}

export function withoutOpenShellSandboxCreateGpu(
  request: CreateOpenShellSandboxRequest,
  options: { readonly sourceReference?: string; readonly policyPath: string },
): CreateOpenShellSandboxRequest {
  const driverConfigJson = request.driverConfigJson
    ? withoutOpenShellSandboxCreateGpuDriverConfig(request.driverConfigJson)
    : undefined;
  return Object.freeze({
    ...request,
    source: Object.freeze({ reference: options.sourceReference ?? request.source.reference }),
    policyPath: options.policyPath,
    ...(driverConfigJson ? { driverConfigJson } : { driverConfigJson: undefined }),
    gpu: undefined,
  });
}

export type DeleteOpenShellSandboxRequest = Readonly<{
  sandboxName: string;
  target: Extract<OpenShellGatewayTarget, { kind: "named" }>;
  runtimeSelection?: OpenShellRuntimeSelection;
  timeoutMs?: number;
}>;

export type OpenShellSandboxDeleteSubmission =
  | Readonly<{ kind: "accepted"; diagnostic: string; exitCode: 0 }>
  | Readonly<{ kind: "absent"; diagnostic: string; exitCode: number }>
  | Readonly<{
      kind: "failed";
      diagnostic: string;
      error: OpenShellSandboxError;
      ambiguous: boolean;
      exitCode: number | null;
    }>;

/** Sandbox mutation transport. Authorization, convergence, and retry stay with each action. */
export interface OpenShellSandboxLifecycle {
  createSandbox(
    request: CreateOpenShellSandboxRequest,
    options?: OpenShellSandboxCreateOptions,
  ): Promise<OpenShellSandboxCreateSubmission>;
  deleteSandbox(request: DeleteOpenShellSandboxRequest): Promise<OpenShellSandboxDeleteSubmission>;
}
