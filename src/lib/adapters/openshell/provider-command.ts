// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

import { buildSubprocessEnv } from "../../subprocess-env";
import { OPENSHELL_OPERATION_TIMEOUT_MS, runOpenshell } from "./runtime";

export { OPENSHELL_OPERATION_TIMEOUT_MS };

const ANSI_RE = /\x1b\[[0-9;]*m/gu;

export type ProviderCommandOptions = {
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
  stdio?: StdioOptions;
  suppressOutput?: boolean;
  timeout?: number;
};

type ProviderCommandRuntimeHooks = {
  runOpenshell?: typeof runOpenshell;
};

let runtimeHooks: ProviderCommandRuntimeHooks = {};

export function setProviderCommandRuntimeHooksForTest(hooks: ProviderCommandRuntimeHooks): void {
  runtimeHooks = hooks;
}

export function parseCliOpenShellProviderNames(output: unknown): string[] {
  const text =
    typeof output === "string" || Buffer.isBuffer(output) ? output.toString() : String(output ?? "");
  return text
    .replace(ANSI_RE, "")
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
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
