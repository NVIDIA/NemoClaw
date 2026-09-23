// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "./runtime-selection";
import type { OpenShellGatewayTarget, OpenShellSandboxError } from "./sandbox-observer";

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
  deleteSandbox(request: DeleteOpenShellSandboxRequest): Promise<OpenShellSandboxDeleteSubmission>;
}
