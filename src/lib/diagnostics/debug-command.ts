// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DebugOptions } from "./debug";

export type DebugSandboxSelection = Readonly<{ name: string; gatewayName?: string }>;
export type DebugSandboxAvailability =
  | Readonly<{ state: "available"; gatewayName: string }>
  | Readonly<{ state: "unregistered" | "missing" | "invalid_gateway" | "observation_denied" }>;

export interface RunDebugCommandDeps {
  getDefaultSandbox: () => Promise<DebugSandboxSelection | null>;
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
    if (availability.state !== "available") {
      const sourceLabel =
        explicit.source === "env" && explicit.envVar ? ` (from ${explicit.envVar})` : "";
      if (availability.state === "unregistered") {
        errorLine(`Error: Sandbox '${explicit.name}'${sourceLabel} is not registered.`);
        errorLine("  Run `nemoclaw list` to see available sandboxes.");
      } else if (availability.state === "observation_denied") {
        errorLine(
          `Error: OpenShell rejected observation of sandbox '${explicit.name}'${sourceLabel}.`,
        );
        errorLine("  Verify OpenShell authentication and gateway identity, then retry.");
      } else if (availability.state === "invalid_gateway") {
        errorLine(`Error: Sandbox '${explicit.name}'${sourceLabel} has an invalid registered gateway binding.`);
        errorLine(
          "  Restore gatewayName and gatewayPort from a trusted backup. Otherwise, back up and remove the sandbox before onboarding it again. Do not copy a gateway binding from another sandbox.",
        );
      } else {
        errorLine(`Error: Sandbox '${explicit.name}'${sourceLabel} exists in the local registry but not in OpenShell.`);
        errorLine("  Run `nemoclaw onboard` again to recreate or select a sandbox.");
      }
      exit(1);
      return;
    }
    opts.sandboxName = explicit.name;
    opts.gatewayName = availability.gatewayName;
  } else {
    const defaultSandbox = await deps.getDefaultSandbox();
    if (defaultSandbox === null) {
      exit(1);
      return;
    }
    opts.sandboxName = defaultSandbox.name;
    opts.gatewayName = defaultSandbox.gatewayName;
  }

  deps.runDebug(opts);
}
