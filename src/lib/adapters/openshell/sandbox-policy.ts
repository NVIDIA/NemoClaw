// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget, OpenShellSandboxResult } from "./sandbox-observer";
import type { OpenShellPolicyInspection } from "../../policy/merge";

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

export type InspectOpenShellSandboxPolicyRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  timeoutMs?: number;
}>;

export type ReadOpenShellSandboxPolicyRevisionRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  revision: number;
  timeoutMs?: number;
}>;

export type OpenShellSandboxPolicyRevisionRead = Readonly<{
  document: string;
  revision: number;
}>;

/** Transport-neutral policy reads used by NemoClaw actions. */
export interface OpenShellSandboxPolicyReader {
  readSandboxPolicy(
    request: ReadOpenShellSandboxPolicyRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxPolicyRead>>;
  inspectSandboxPolicy(
    request: InspectOpenShellSandboxPolicyRequest,
  ): Promise<OpenShellSandboxResult<OpenShellPolicyInspection>>;
  readSandboxPolicyRevision(
    request: ReadOpenShellSandboxPolicyRevisionRequest,
  ): Promise<OpenShellSandboxResult<OpenShellSandboxPolicyRevisionRead>>;
}

/** Synchronous policy reads for existing transactional mutation paths. */
export interface SyncOpenShellSandboxPolicyReader {
  readSandboxPolicy(
    request: ReadOpenShellSandboxPolicyRequest,
  ): OpenShellSandboxResult<OpenShellSandboxPolicyRead>;
  inspectSandboxPolicy(
    request: InspectOpenShellSandboxPolicyRequest,
  ): OpenShellSandboxResult<OpenShellPolicyInspection>;
  readSandboxPolicyRevision(
    request: ReadOpenShellSandboxPolicyRevisionRequest,
  ): OpenShellSandboxResult<OpenShellSandboxPolicyRevisionRead>;
}
