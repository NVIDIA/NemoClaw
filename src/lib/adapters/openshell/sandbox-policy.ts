// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget, OpenShellSandboxResult } from "./sandbox-observer";
import type { OpenShellRuntimeSelection } from "./runtime-selection";
import type {
  OpenShellPolicyInspection,
  OpenShellSandboxPolicyRead,
  OpenShellSandboxPolicySetOutcome,
  OpenShellSandboxPolicySetSubmission,
} from "./policy-boundary";

export type {
  OpenShellSandboxPolicyRead,
  OpenShellSandboxPolicySetOutcome,
  OpenShellSandboxPolicySetSubmission,
} from "./policy-boundary";

export type OpenShellSandboxPolicyScope = "base" | "effective";

type OpenShellSandboxPolicyRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  runtimeSelection?: OpenShellRuntimeSelection;
  timeoutMs?: number;
}>;

export type SetOpenShellSandboxPolicyRequest = OpenShellSandboxPolicyRequest &
  Readonly<{ policyPath: string }>;

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

interface OpenShellSandboxPolicyWriterContract<Async extends boolean> {
  setSandboxPolicy: (
    request: SetOpenShellSandboxPolicyRequest,
  ) => Async extends true
    ? Promise<OpenShellSandboxPolicySetSubmission>
    : OpenShellSandboxPolicySetSubmission;
}

export type OpenShellSandboxPolicyWriter = OpenShellSandboxPolicyWriterContract<true>;

export type SyncOpenShellSandboxPolicyWriter = OpenShellSandboxPolicyWriterContract<false>;
