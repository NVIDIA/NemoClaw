// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellSandboxLogSource = "gateway" | "openshell";

export type OpenShellSandboxLogRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  source: OpenShellSandboxLogSource;
  lines: string;
  since: string | null;
  timeoutMs: number;
}>;

export type OpenShellSandboxLogError = Readonly<{
  kind: "capture" | "configuration" | "invocation" | "timeout" | "unavailable";
  message: string;
}>;

export type OpenShellSandboxLogOutcome =
  | Readonly<{
      kind: "completed";
      exitCode: number;
      termination?: "broken_pipe" | "hangup" | "interrupted" | "other_signal" | "terminated";
    }>
  | Readonly<{
      kind: "failed";
      error: OpenShellSandboxLogError;
      exitCode: number;
    }>;

export type OpenShellSandboxLogRead = Readonly<{
  content: string;
  diagnostic: string;
  outcome: OpenShellSandboxLogOutcome;
}>;

/** A transport-neutral view of output emitted by one followed log source. */
export interface OpenShellSandboxLogOutput {
  onChunk(listener: (chunk: string) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  pause(): void;
  resume(): void;
  close(): void;
}

export type OpenShellSandboxLogFollowCompletion = Readonly<{
  outcome: OpenShellSandboxLogOutcome;
}>;

export interface OpenShellSandboxLogFollowSession {
  completion: Promise<OpenShellSandboxLogFollowCompletion>;
  diagnostic: OpenShellSandboxLogOutput | null;
  output: OpenShellSandboxLogOutput | null;
  cancel(reason: "interrupt" | "terminate"): void;
}

/** Typed public-log capabilities used by the sandbox logs action. */
export interface OpenShellSandboxLogs {
  checkAvailability(): OpenShellSandboxLogError | null;
  read(request: OpenShellSandboxLogRequest): Promise<OpenShellSandboxLogRead>;
  follow(request: OpenShellSandboxLogRequest): OpenShellSandboxLogFollowSession;
}
