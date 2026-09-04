// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Namespace access keeps the resolver replaceable in focused command tests.
import * as openshellResolveModule from "./resolve";
import {
  buildOpenShellRuntimeSelectionEnv,
  type OpenShellRuntimeSelection,
} from "./runtime-selection";

export type { OpenShellRuntimeSelection } from "./runtime-selection";

/** Build the standard subprocess environment for one selected OpenShell target. */
export function buildSelectedOpenShellSubprocessEnv(
  runtimeSelection: OpenShellRuntimeSelection,
  extra?: Record<string, string>,
): Record<string, string> {
  return buildOpenShellRuntimeSelectionEnv(
    openshellResolveModule.buildOpenShellCommandBaseEnv(extra),
    runtimeSelection,
  );
}

/** Apply one selected OpenShell target to command options. */
export function withSelectedOpenShellCommandOptions<const T extends object>(
  options: T,
  runtimeSelection?: OpenShellRuntimeSelection,
): T & { env?: Record<string, string>; replaceEnv?: true } {
  return runtimeSelection
    ? {
        ...options,
        env: buildSelectedOpenShellSubprocessEnv(runtimeSelection),
        replaceEnv: true,
      }
    : options;
}

/** Build a subprocess environment with optional explicit OpenShell target selection. */
export function buildOpenShellCommandEnv(
  runtimeSelection?: OpenShellRuntimeSelection,
  extra?: Record<string, string>,
): Record<string, string> {
  return runtimeSelection
    ? buildSelectedOpenShellSubprocessEnv(runtimeSelection, extra)
    : openshellResolveModule.buildOpenShellCommandBaseEnv(extra);
}

export function tryResolveOpenshellBinary(): string | null {
  return openshellResolveModule.resolveOpenshell();
}

export function openshellNotFoundDiagnosticLines(): string[] {
  return openshellResolveModule.openshellNotFoundDiagnosticLines();
}

export function resolveOpenshellBinary(): string {
  return tryResolveOpenshellBinary() ?? "openshell";
}

export function buildOpenshellCommand(args: readonly string[]): string[] {
  return [resolveOpenshellBinary(), ...args];
}
