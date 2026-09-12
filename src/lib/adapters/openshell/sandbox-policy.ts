// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget, OpenShellSandboxResult } from "./sandbox-observer";
import type { OpenShellRuntimeSelection } from "./runtime-selection";
import type { OpenShellPolicyInspection } from "./policy-boundary";

export type OpenShellSandboxPolicyScope = "base" | "effective";

type OpenShellSandboxPolicyRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  runtimeSelection?: OpenShellRuntimeSelection;
  timeoutMs?: number;
}>;

export type SetOpenShellSandboxPolicyRequest = OpenShellSandboxPolicyRequest &
  Readonly<{ document: string }>;

export type ReadOpenShellSandboxPolicyRequest = OpenShellSandboxPolicyRequest &
  Readonly<{ scope: OpenShellSandboxPolicyScope }>;

export type InspectOpenShellSandboxPolicyRequest = OpenShellSandboxPolicyRequest;

export type ReadOpenShellSandboxPolicyRevisionRequest = OpenShellSandboxPolicyRequest &
  Readonly<{ revision: number }>;

export type OpenShellSandboxPolicyRevisionRead = Readonly<{
  document: string;
  revision: number;
}>;

export type OpenShellSandboxPolicyRead = Readonly<{
  document: string;
  appliedRevision: number | null;
  metadata?: readonly Readonly<{
    field: "Version" | "Active" | "Hash" | "Status" | "Created" | "Loaded" | "Updated";
    value: string;
  }>[];
}>;

// Keep exit-status compatibility for existing policy commands.
export type {
  OpenShellSandboxPolicySetOutcome,
  OpenShellSandboxPolicySetSubmission,
} from "./policy-boundary";
import type { OpenShellSandboxPolicySetSubmission } from "./policy-boundary";

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

export interface OpenShellSandboxPolicyWriter {
  setSandboxPolicy(
    request: SetOpenShellSandboxPolicyRequest,
  ): Promise<OpenShellSandboxPolicySetSubmission>;
}

/** Transitional reader for portable lifecycle consumers tracked in #11479. */
export interface SyncOpenShellSandboxPolicyReader {
  readSandboxPolicy(
    request: ReadOpenShellSandboxPolicyRequest,
  ): OpenShellSandboxResult<OpenShellSandboxPolicyRead>;
}
