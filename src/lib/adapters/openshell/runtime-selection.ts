// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellRuntimeSelection = {
  gatewayName: string;
  localTlsDir?: string;
  workspace: string;
};

/** Remove ambient OpenShell selectors and install one authority-derived target. */
export function replaceOpenShellRuntimeSelectionEnv(
  env: Record<string, string | undefined>,
  runtimeSelection: OpenShellRuntimeSelection,
): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("OPENSHELL_")) delete env[name];
  }
  env.OPENSHELL_GATEWAY = runtimeSelection.gatewayName;
  env.OPENSHELL_WORKSPACE = runtimeSelection.workspace;
  if (runtimeSelection.localTlsDir) {
    env.OPENSHELL_LOCAL_TLS_DIR = runtimeSelection.localTlsDir;
  }
}

/** Capture all OpenShell environment values and return an idempotent restore function. */
export function snapshotOpenShellEnv(env: NodeJS.ProcessEnv = process.env): () => void {
  const previous = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("OPENSHELL_") && entry[1] !== undefined,
    ),
  );
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const name of Object.keys(env)) {
      if (name.startsWith("OPENSHELL_")) delete env[name];
    }
    Object.assign(env, previous);
  };
}

/** Replace ambient OpenShell selectors with one authority-derived runtime target. */
export function buildOpenShellRuntimeSelectionEnv(
  baseEnv: Record<string, string>,
  runtimeSelection: OpenShellRuntimeSelection,
): Record<string, string> {
  const env = { ...baseEnv };
  replaceOpenShellRuntimeSelectionEnv(env, runtimeSelection);
  return env;
}
