// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

import { buildSubprocessEnv } from "../../subprocess-env";
import { OPENSHELL_OPERATION_TIMEOUT_MS, runOpenshell } from "./runtime";

export { OPENSHELL_OPERATION_TIMEOUT_MS };

export type ProviderCommandOptions = {
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
  stdio?: StdioOptions;
  timeout?: number;
};

type ProviderCommandRuntimeHooks = {
  runOpenshell?: typeof runOpenshell;
};

let runtimeHooks: ProviderCommandRuntimeHooks = {};

export function setProviderCommandRuntimeHooksForTest(hooks: ProviderCommandRuntimeHooks): void {
  runtimeHooks = hooks;
}

export function runOpenshellProviderCommand(args: string[], opts?: ProviderCommandOptions) {
  const explicitEnv = Object.fromEntries(
    Object.entries(opts?.env ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const providerOpts = {
    ...opts,
    env: buildSubprocessEnv(explicitEnv),
    replaceEnv: true,
  };
  const commandRunner = runtimeHooks.runOpenshell ?? runOpenshell;
  return commandRunner(args, providerOpts);
}
