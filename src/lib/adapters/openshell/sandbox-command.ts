// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellSandboxCommandRequest = Readonly<{
  sandboxName: string;
  target: OpenShellGatewayTarget;
  command: readonly string[];
  workdir?: string;
  tty?: boolean | null;
  timeoutSeconds?: number;
  stdin?: boolean;
}>;

export type OpenShellSandboxBufferedCommandRequest = Readonly<{
  sandboxName: string;
  target: OpenShellGatewayTarget;
  command: readonly string[];
  /** Environment for the host-side OpenShell process. */
  environment?: NodeJS.ProcessEnv;
  /** Environment assignments for the command inside the sandbox. */
  sandboxEnvironment?: Readonly<Record<string, string>>;
  input?: string;
  tty?: boolean | null;
  workdir?: string;
  timeoutMilliseconds?: number;
  timeoutKillSignal?: "SIGTERM" | "SIGKILL";
  outputLimitBytes?: number;
}>;

export type OpenShellSandboxCommandError = Readonly<{
  kind: "capture" | "invocation" | "timeout" | "unavailable";
  message: string;
}>;

export type OpenShellSandboxCommandOutcome =
  | Readonly<{
      kind: "completed";
      exitCode: number;
      signal?: NodeJS.Signals | null;
    }>
  | Readonly<{
      kind: "failed";
      error: OpenShellSandboxCommandError;
    }>;

/**
 * A streaming command keeps its host signal handlers until the consumer has
 * completed any command-dependent cleanup.
 */
export type OpenShellSandboxCommandCompletion = Readonly<{
  outcome: OpenShellSandboxCommandOutcome;
  release: () => void;
}>;

export type OpenShellSandboxBufferedCommandCompletion = Readonly<{
  outcome: OpenShellSandboxCommandOutcome;
  stdout: string;
  stderr: string;
}>;

export type OpenShellSandboxDirectoryProbe =
  | Readonly<{ state: "present" }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "unobservable"; error?: OpenShellSandboxCommandError }>;

/** Transport-neutral streamed command capabilities used by NemoClaw actions. */
export interface OpenShellSandboxCommandExecutor {
  probeDirectory(request: {
    sandboxName: string;
    target: OpenShellGatewayTarget;
    path: string;
  }): Promise<OpenShellSandboxDirectoryProbe>;
  runStreaming(request: OpenShellSandboxCommandRequest): Promise<OpenShellSandboxCommandCompletion>;
}

export interface OpenShellSandboxBufferedCommandExecutor {
  runBuffered(
    request: OpenShellSandboxBufferedCommandRequest,
  ): Promise<OpenShellSandboxBufferedCommandCompletion>;
}
