// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellSandboxSessionRequest = Readonly<{
  sandboxName: string;
  target: OpenShellGatewayTarget;
}> &
  (
    | Readonly<{ kind: "connect" }>
    | Readonly<{
        kind: "command";
        command: readonly string[];
        workdir?: string;
        tty?: boolean | null;
        timeoutSeconds?: number;
        output: "inherit" | "capture";
        outputLimitBytes?: number;
      }>
  );

export type OpenShellSandboxSessionOutcome =
  | Readonly<{ kind: "exited"; exitCode: number }>
  | Readonly<{ kind: "signalled"; signal: NodeJS.Signals; exitCode: number }>
  | Readonly<{ kind: "cancelled"; exitCode: number }>
  | Readonly<{
      kind: "failed";
      reason: "configuration" | "unavailable" | "invocation" | "transport" | "capture";
      message: string;
      exitCode: number;
    }>;

export type OpenShellSandboxSessionCompletion = Readonly<{
  outcome: OpenShellSandboxSessionOutcome;
  stdout: string;
  stderr: string;
  release: () => void;
}>;

export interface OpenShellSandboxSession {
  completion: Promise<OpenShellSandboxSessionCompletion>;
  cancel(): void;
}

/** Start under the caller's lifecycle fence, then await completion outside it. */
export interface OpenShellSandboxSessionExecutor {
  start(request: OpenShellSandboxSessionRequest): OpenShellSandboxSession;
}
