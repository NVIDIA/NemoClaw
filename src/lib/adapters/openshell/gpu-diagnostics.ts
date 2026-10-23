// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./gateway-scope";

export type OpenShellGpuDiagnosticArtifactName =
  | "openshell-logs.txt"
  | "openshell-sandbox-get.txt"
  | "openshell-sandbox-list.txt";

export type OpenShellGpuDiagnosticError = Readonly<{
  kind: "capture" | "configuration" | "invocation" | "timeout" | "unavailable";
  message: string;
}>;

export type OpenShellGpuDiagnosticOutcome =
  | Readonly<{ kind: "completed"; exitCode: number }>
  | Readonly<{ kind: "failed"; error: OpenShellGpuDiagnosticError }>;

export type OpenShellGpuDiagnosticArtifact = Readonly<{
  name: OpenShellGpuDiagnosticArtifactName;
  content: string;
  outcome: OpenShellGpuDiagnosticOutcome;
}>;

export type CollectOpenShellGpuDiagnosticsRequest = Readonly<{
  target: OpenShellGatewayTarget;
  sandboxName: string;
  timeoutMs: number;
  deadlineMs?: number;
  redact: (value: string) => string;
}>;

/** Collect the fixed OpenShell artifacts owned by Docker GPU failure diagnostics. */
export interface OpenShellGpuDiagnostics {
  collect(
    request: CollectOpenShellGpuDiagnosticsRequest,
  ): readonly OpenShellGpuDiagnosticArtifact[];
}
