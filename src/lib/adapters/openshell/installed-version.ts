// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellInstalledVersionError = Readonly<{
  kind: "capture" | "configuration" | "invocation" | "malformed" | "timeout" | "unavailable";
  message: string;
}>;

export type OpenShellInstalledVersionObservation =
  | Readonly<{ ok: true; version: string; development: boolean }>
  | Readonly<{ ok: false; error: OpenShellInstalledVersionError }>;

export function formatOpenShellInstalledVersionOutput(
  observation: OpenShellInstalledVersionObservation,
): string | null {
  if (!observation.ok) return null;
  return `openshell ${observation.version}${observation.development ? "-dev" : ""}`;
}

export type ObserveOpenShellInstalledVersionRequest = Readonly<{
  timeoutMs?: number;
}>;

/** Observe the installed OpenShell CLI version without applying compatibility policy. */
export interface OpenShellInstalledVersionObserver {
  observeInstalledVersion(
    request?: ObserveOpenShellInstalledVersionRequest,
  ): OpenShellInstalledVersionObservation;
}
