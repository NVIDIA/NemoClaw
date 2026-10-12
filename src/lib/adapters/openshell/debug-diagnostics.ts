// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellDebugArtifactName =
  | "openshell-gateway-info"
  | "openshell-logs"
  | "openshell-sandbox-get"
  | "openshell-sandbox-list"
  | "openshell-status";

export type OpenShellDebugDiagnosticError = Readonly<{
  kind: "capture" | "configuration" | "invocation" | "timeout" | "unavailable";
  message: string;
}>;

export type OpenShellDebugDiagnosticOutcome =
  | Readonly<{ kind: "completed"; exitCode: number }>
  | Readonly<{ kind: "failed"; error: OpenShellDebugDiagnosticError }>;

export type OpenShellDebugArtifact = Readonly<{
  name: OpenShellDebugArtifactName;
  content: string;
  outcome: OpenShellDebugDiagnosticOutcome;
}>;

export type CollectOpenShellDebugDiagnosticsRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  quick: boolean;
  timeoutMs: number;
}>;

/** Collect the fixed OpenShell artifacts owned by the debug command. */
export interface OpenShellDebugDiagnostics {
  collect(
    request: CollectOpenShellDebugDiagnosticsRequest,
  ): Promise<readonly OpenShellDebugArtifact[]>;
}
