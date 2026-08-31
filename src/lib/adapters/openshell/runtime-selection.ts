// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildSubprocessEnv } from "../../subprocess-env";

export type OpenShellRuntimeSelection = {
  gatewayName: string;
  localTlsDir?: string;
  workspace: string;
};

/** Replace ambient OpenShell selectors with one authority-derived runtime target. */
export function buildOpenShellRuntimeSelectionEnv(
  baseEnv: Record<string, string>,
  runtimeSelection: OpenShellRuntimeSelection,
): Record<string, string> {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    if (name.startsWith("OPENSHELL_")) delete env[name];
  }
  env.OPENSHELL_GATEWAY = runtimeSelection.gatewayName;
  env.OPENSHELL_WORKSPACE = runtimeSelection.workspace;
  if (runtimeSelection.localTlsDir) {
    env.OPENSHELL_LOCAL_TLS_DIR = runtimeSelection.localTlsDir;
  }
  return env;
}

/** Build the standard subprocess environment for one selected OpenShell target. */
export function buildSelectedOpenShellSubprocessEnv(
  runtimeSelection: OpenShellRuntimeSelection,
  extra?: Record<string, string>,
): Record<string, string> {
  return buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(extra), runtimeSelection);
}

/** Build a subprocess environment with optional explicit OpenShell target selection. */
export function buildOpenShellCommandEnv(
  runtimeSelection?: OpenShellRuntimeSelection,
  extra?: Record<string, string>,
): Record<string, string> {
  return runtimeSelection
    ? buildSelectedOpenShellSubprocessEnv(runtimeSelection, extra)
    : buildSubprocessEnv(extra);
}
