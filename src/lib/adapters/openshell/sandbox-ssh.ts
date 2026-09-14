// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellSandboxSshRequest = Readonly<{
  sandboxName: string;
  target: OpenShellGatewayTarget;
  command: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMilliseconds?: number;
}>;

export type OpenShellSandboxSshResult =
  | Readonly<{ kind: "completed"; exitCode: number; stdout: string; stderr: string }>
  | Readonly<{
      kind: "failed";
      reason: "configuration" | "unavailable" | "timeout" | "cancelled" | "transport" | "capture";
      signal?: NodeJS.Signals;
      command?: Readonly<{ exitCode: number; stdout: string; stderr: string }>;
    }>;

export interface OpenShellSandboxSshExecutor {
  run(request: OpenShellSandboxSshRequest): Promise<OpenShellSandboxSshResult>;
}
