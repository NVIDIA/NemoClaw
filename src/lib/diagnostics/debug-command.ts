// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DebugOptions } from "./debug";

export interface RunDebugCommandDeps {
  getDefaultSandbox: () => string | undefined;
  isSandboxKnown: (name: string) => boolean;
  runDebug: (options: DebugOptions) => void;
  env?: NodeJS.ProcessEnv;
  errorLine?: (message: string) => void;
  exit?: (code: number) => never;
}

const SANDBOX_NAME_ENV_VARS = ["NEMOCLAW_SANDBOX_NAME", "NEMOCLAW_SANDBOX", "SANDBOX_NAME"] as const;

function resolveExplicitName(
  options: DebugOptions,
  env: NodeJS.ProcessEnv,
): { name: string; source: "flag" | "env"; envVar?: string } | null {
  const flagName = options.sandboxName?.trim();
  if (flagName) return { name: flagName, source: "flag" };
  for (const envVar of SANDBOX_NAME_ENV_VARS) {
    const value = env[envVar]?.trim();
    if (value) return { name: value, source: "env", envVar };
  }
  return null;
}

export function runDebugCommandWithOptions(options: DebugOptions, deps: RunDebugCommandDeps): void {
  const opts = { ...options };
  const env = deps.env ?? process.env;
  const errorLine = deps.errorLine ?? ((msg: string) => console.error(msg));
  const exit =
    deps.exit ??
    ((code: number) => {
      process.exit(code);
    });

  const explicit = resolveExplicitName(opts, env);
  if (explicit) {
    if (!deps.isSandboxKnown(explicit.name)) {
      const sourceLabel =
        explicit.source === "env" && explicit.envVar ? ` (from ${explicit.envVar})` : "";
      errorLine(`Error: Sandbox '${explicit.name}'${sourceLabel} is not registered.`);
      errorLine("  Run `nemoclaw list` to see available sandboxes.");
      exit(1);
      return;
    }
    opts.sandboxName = explicit.name;
  } else {
    opts.sandboxName = deps.getDefaultSandbox();
  }

  deps.runDebug(opts);
}
