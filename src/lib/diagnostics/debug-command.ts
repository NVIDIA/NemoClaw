// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DebugOptions } from "./debug";

export type DebugSandboxAvailability = "available" | "unregistered" | "missing";

export interface RunDebugCommandDeps {
  getDefaultSandbox: () => Promise<string | null>;
  getSandboxAvailability: (name: string) => Promise<DebugSandboxAvailability>;
  runDebug: (options: DebugOptions) => void;
  env?: NodeJS.ProcessEnv;
  errorLine?: (message: string) => void;
  exit?: (code: number) => never;
}

const SANDBOX_NAME_ENV_VARS = [
  "NEMOCLAW_SANDBOX_NAME",
  "NEMOCLAW_SANDBOX",
  "SANDBOX_NAME",
] as const;

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

export async function runDebugCommandWithOptions(
  options: DebugOptions,
  deps: RunDebugCommandDeps,
): Promise<void> {
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
    const availability = await deps.getSandboxAvailability(explicit.name);
    if (availability !== "available") {
      const sourceLabel =
        explicit.source === "env" && explicit.envVar ? ` (from ${explicit.envVar})` : "";
      if (availability === "unregistered") {
        errorLine(`Error: Sandbox '${explicit.name}'${sourceLabel} is not registered.`);
        errorLine("  Run `nemoclaw list` to see available sandboxes.");
      } else {
        errorLine(`Error: Sandbox '${explicit.name}'${sourceLabel} exists in the local registry but not in OpenShell.`);
        errorLine("  Run `nemoclaw onboard` again to recreate or select a sandbox.");
      }
      exit(1);
      return;
    }
    opts.sandboxName = explicit.name;
  } else {
    const defaultSandbox = await deps.getDefaultSandbox();
    if (defaultSandbox === null) {
      exit(1);
      return;
    }
    opts.sandboxName = defaultSandbox;
  }

  deps.runDebug(opts);
}
