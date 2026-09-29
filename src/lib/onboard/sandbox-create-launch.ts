// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { AgentDefinition } from "../agent/definition-types";
import { buildOpenShellSandboxCreateEnvironment } from "../adapters/openshell/sandbox-lifecycle-cli";
import {
  buildSandboxRuntimeEnvArgs,
  type SandboxRuntimeEnvArgsInput,
} from "./docker-startup-command-env";
import type { HermesDashboardOnboardState } from "./hermes-dashboard";
import {
  MANAGED_STARTUP_EXECUTABLE,
  MANAGED_STARTUP_HOLD_EXECUTABLE,
} from "./managed-startup/hold";
import type { ManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import {
  prebuildSandboxImageIfEligible,
  type SandboxPrebuildInput,
  type SandboxPrebuildResult,
} from "./sandbox-prebuild";

type OpenshellShellCommand = (args: string[]) => string;
type OpenshellArgv = (args: string[]) => string[];

export const OPENSHELL_SANDBOX_SUPERVISOR_ARGV = Object.freeze([
  "/opt/openshell/bin/openshell-sandbox",
  "--workdir",
  "/sandbox",
] as const);

export interface SandboxCreateLaunchInput {
  agent: AgentDefinition | null | undefined;
  observabilityEnabled?: boolean;
  chatUiUrl: string;
  createArgs: readonly string[];
  sandboxName?: string;
  env?: NodeJS.ProcessEnv;
  extraPlaceholderKeys: readonly string[];
  getDashboardForwardPort(chatUiUrl: string): string;
  hermesDashboardState: HermesDashboardOnboardState;
  /** Reserved host port for this Hermes sandbox's OpenAI-compatible API. */
  hermesApiPort?: number | null;
  manageDashboard?: boolean;
  openshellShellCommand: OpenshellShellCommand;
  openshellArgv?: OpenshellArgv;
  buildEnv?(): Record<string, string>;
  managedStartupRootApplyRequest?: ManagedStartupRootApplyRequest | null;
  /** Reuse the durable hold identity when resuming one verified incomplete create. */
  managedBootstrapIdentity?: string | null;
}

export interface SandboxCreateLaunch {
  createCommand: string;
  createArgv: string[];
  effectiveDashboardPort: string;
  envArgs: string[];
  sandboxEnv: Record<string, string>;
  sandboxStartupCommand: string[];
  intendedSandboxStartupCommand: string[];
  managedBootstrapIdentity: string | null;
  managedStartupRootApplyRequest: ManagedStartupRootApplyRequest | null;
}

export type SandboxRuntimeLaunch = Omit<SandboxCreateLaunch, "createCommand" | "createArgv">;

export interface SandboxCreateLaunchWithPrebuildInput extends SandboxCreateLaunchInput {
  sandboxName: string;
  prebuild: Omit<SandboxPrebuildInput, "createArgs" | "sandboxName">;
}

export interface SandboxCreateLaunchWithPrebuild extends SandboxCreateLaunch {
  prebuild: SandboxPrebuildResult;
}

export interface SandboxRuntimeLaunchWithPrebuild extends SandboxRuntimeLaunch {
  prebuild: Omit<SandboxPrebuildResult, "createArgs">;
}

export function renderSandboxCreateCommand(
  createArgs: readonly string[],
  sandboxStartupCommand: readonly string[],
  openshellShellCommand: OpenshellShellCommand,
): string {
  return `${openshellShellCommand([
    "sandbox",
    "create",
    ...createArgs,
    "--",
    ...sandboxStartupCommand,
  ])} 2>&1`;
}

export {
  buildSandboxRuntimeEnvArgs,
  type SandboxRuntimeEnvArgsInput,
  prebuildSandboxImageIfEligible,
};

export function requiresLocalSandboxBuildKit(
  origin: SandboxPrebuildInput["origin"],
  agent: Pick<AgentDefinition, "name"> | null | undefined,
): boolean {
  return (
    origin === "generated" &&
    (agent == null || agent.name === "openclaw" || agent.name === "hermes")
  );
}

export function prepareSandboxRuntimeLaunch(
  input: Omit<SandboxCreateLaunchInput, "createArgs"> & { readonly policyAttached: boolean },
): SandboxRuntimeLaunch {
  const env = input.env ?? process.env;
  const manageDashboard = input.manageDashboard ?? true;
  const { envArgs, effectiveDashboardPort } = buildSandboxRuntimeEnvArgs({
    agent: input.agent ?? null,
    chatUiUrl: input.chatUiUrl,
    manageDashboard,
    getDashboardForwardPort: input.getDashboardForwardPort,
    hermesDashboardState: input.hermesDashboardState,
    hermesApiPort: input.hermesApiPort,
    extraPlaceholderKeys: input.extraPlaceholderKeys,
    observabilityEnabled: input.observabilityEnabled,
    sandboxName: input.sandboxName,
    allowHermesApiPortOverride: true,
    env,
  });
  const sandboxEnv = buildOpenShellSandboxCreateEnvironment(
    input.buildEnv ? input.buildEnv() : env,
    { policyAttached: input.policyAttached },
  );

  // Run without piping through awk; the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const intendedSandboxStartupCommand = ["env", ...envArgs, MANAGED_STARTUP_EXECUTABLE];
  const managedStartupRootApplyRequest = input.managedStartupRootApplyRequest ?? null;
  if (
    input.managedBootstrapIdentity !== undefined &&
    input.managedBootstrapIdentity !== null &&
    !/^[a-f0-9]{64}$/u.test(input.managedBootstrapIdentity)
  ) {
    throw new Error("Managed startup resume requires one exact bootstrap identity.");
  }
  const managedBootstrapIdentity = managedStartupRootApplyRequest
    ? (input.managedBootstrapIdentity ?? randomBytes(32).toString("hex"))
    : null;
  // Keep the raw profile and CA payload out of OpenShell's create argv and
  // sandbox environment; the verified host apply and release handshake owns them.
  const sandboxStartupCommand =
    managedStartupRootApplyRequest && managedBootstrapIdentity
      ? [
          "env",
          ...envArgs,
          MANAGED_STARTUP_HOLD_EXECUTABLE,
          "--agent",
          managedStartupRootApplyRequest.agent,
          "--profile-fingerprint",
          managedStartupRootApplyRequest.profileFingerprint,
          "--bootstrap-identity",
          managedBootstrapIdentity,
          "--",
          MANAGED_STARTUP_EXECUTABLE,
        ]
      : intendedSandboxStartupCommand;
  return {
    effectiveDashboardPort,
    envArgs,
    sandboxEnv,
    sandboxStartupCommand,
    intendedSandboxStartupCommand,
    managedBootstrapIdentity,
    managedStartupRootApplyRequest,
  };
}

export function prepareSandboxCreateLaunch(input: SandboxCreateLaunchInput): SandboxCreateLaunch {
  const runtime = prepareSandboxRuntimeLaunch({
    ...input,
    policyAttached: input.createArgs.includes("--policy"),
  });
  const createArgs = [...input.createArgs];
  const openshellArgs = [
    "sandbox",
    "create",
    ...createArgs,
    "--",
    ...runtime.sandboxStartupCommand,
  ];
  const createCommand = renderSandboxCreateCommand(
    createArgs,
    runtime.sandboxStartupCommand,
    input.openshellShellCommand,
  );
  return {
    ...runtime,
    createCommand,
    createArgv: input.openshellArgv
      ? input.openshellArgv(openshellArgs)
      : ["bash", "-lc", createCommand],
  };
}

/** Coordinate the optional local image build with the canonical launch renderer. */
export async function prepareSandboxCreateLaunchWithPrebuild(
  input: SandboxCreateLaunchWithPrebuildInput,
): Promise<SandboxCreateLaunchWithPrebuild> {
  const { prebuild: prebuildInput, ...launchInput } = input;
  const prebuild = await prebuildSandboxImageIfEligible({
    ...prebuildInput,
    createArgs: input.createArgs,
    requiresLocalBuildKit: requiresLocalSandboxBuildKit(prebuildInput.origin, input.agent),
    sandboxName: input.sandboxName,
  });
  return {
    ...prepareSandboxCreateLaunch({ ...launchInput, createArgs: prebuild.createArgs }),
    prebuild,
  };
}
