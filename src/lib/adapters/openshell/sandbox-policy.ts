// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget, OpenShellSandboxResult } from "./sandbox-observer";
import type { OpenShellPolicyInspection } from "../../policy/merge";

export type OpenShellSandboxPolicyScope = "base" | "effective";

export type OpenShellSandboxPolicyRead = Readonly<{
  document: string;
  appliedRevision: number | null;
}>;

type OpenShellSandboxPolicyRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  timeoutMs?: number;
}>;

export type ReadOpenShellSandboxPolicyRequest = OpenShellSandboxPolicyRequest &
  Readonly<{ scope: OpenShellSandboxPolicyScope }>;

export type InspectOpenShellSandboxPolicyRequest = OpenShellSandboxPolicyRequest;

export type ReadOpenShellSandboxPolicyRevisionRequest = OpenShellSandboxPolicyRequest &
  Readonly<{ revision: number }>;

export type OpenShellSandboxPolicyRevisionRead = Readonly<{
  document: string;
  revision: number;
}>;

type PolicyResult<Async extends boolean, Value> = Async extends true
  ? Promise<OpenShellSandboxResult<Value>>
  : OpenShellSandboxResult<Value>;

interface OpenShellSandboxPolicyReaderContract<Async extends boolean> {
  readSandboxPolicy: (
    request: ReadOpenShellSandboxPolicyRequest,
  ) => PolicyResult<Async, OpenShellSandboxPolicyRead>;
  inspectSandboxPolicy: (
    request: InspectOpenShellSandboxPolicyRequest,
  ) => PolicyResult<Async, OpenShellPolicyInspection>;
  readSandboxPolicyRevision: (
    request: ReadOpenShellSandboxPolicyRevisionRequest,
  ) => PolicyResult<Async, OpenShellSandboxPolicyRevisionRead>;
}

export type OpenShellSandboxPolicyReader = OpenShellSandboxPolicyReaderContract<true>;

export type SyncOpenShellSandboxPolicyReader = OpenShellSandboxPolicyReaderContract<false>;
