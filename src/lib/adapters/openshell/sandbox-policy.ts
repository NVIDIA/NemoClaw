// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget, OpenShellSandboxResult } from "./sandbox-observer";

/** The base policy is mutable input. The effective policy includes provider composition. */
export type OpenShellSandboxPolicyScope = "base" | "effective";

export type OpenShellSandboxPolicyRead = Readonly<{
  document: string;
  appliedRevision: number | null;
}>;

export type ReadOpenShellSandboxPolicyRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  scope: OpenShellSandboxPolicyScope;
  timeoutMs?: number;
}>;

/** Transport-neutral policy reads used by NemoClaw actions. */
export interface OpenShellSandboxPolicyReader {
  readSandboxPolicy(
    request: ReadOpenShellSandboxPolicyRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxPolicyRead>>;
}

/** Synchronous policy reads for existing transactional mutation paths. */
export interface SyncOpenShellSandboxPolicyReader {
  readSandboxPolicy(
    request: ReadOpenShellSandboxPolicyRequest,
  ): OpenShellSandboxResult<OpenShellSandboxPolicyRead>;
}
