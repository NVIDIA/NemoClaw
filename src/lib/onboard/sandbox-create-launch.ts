// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { AgentDefinition } from "../agent/definition-types";
import { buildSubprocessEnv } from "../subprocess-env";
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

export interface SandboxCreateLaunchWithPrebuildInput extends SandboxCreateLaunchInput {
  sandboxName: string;
  prebuild: Omit<SandboxPrebuildInput, "createArgs" | "sandboxName">;
}

export interface SandboxCreateLaunchWithPrebuild extends SandboxCreateLaunch {
  prebuild: SandboxPrebuildResult;
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

export { buildSandboxRuntimeEnvArgs, type SandboxRuntimeEnvArgsInput };

export function prepareSandboxCreateLaunch(input: SandboxCreateLaunchInput): SandboxCreateLaunch {
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
  const sandboxEnv = (input.buildEnv ?? buildSubprocessEnv)();
  // Remove host-infrastructure credentials that the generic allowlist
  // permits for host-side processes but that must not enter the sandbox.
  delete sandboxEnv.KUBECONFIG;
  delete sandboxEnv.SSH_AUTH_SOCK;
  if (!input.createArgs.includes("--policy")) {
    delete sandboxEnv.OPENSHELL_SANDBOX_POLICY;
  }

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
  const createArgs = [...input.createArgs];
  const openshellArgs = ["sandbox", "create", ...createArgs, "--", ...sandboxStartupCommand];
  const createCommand = renderSandboxCreateCommand(
    createArgs,
    sandboxStartupCommand,
    input.openshellShellCommand,
  );
  const createArgv = input.openshellArgv
    ? input.openshellArgv(openshellArgs)
    : ["bash", "-lc", createCommand];

  return {
    createCommand,
    createArgv,
    effectiveDashboardPort,
    envArgs,
    sandboxEnv,
    sandboxStartupCommand,
    intendedSandboxStartupCommand,
    managedBootstrapIdentity,
    managedStartupRootApplyRequest,
  };
}

/** Coordinate the optional local image build with the canonical launch renderer. */
export async function prepareSandboxCreateLaunchWithPrebuild(
  input: SandboxCreateLaunchWithPrebuildInput,
): Promise<SandboxCreateLaunchWithPrebuild> {
  const { prebuild: prebuildInput, ...launchInput } = input;
  const requiresLocalBuildKit =
    prebuildInput.origin === "generated" &&
    (input.agent == null || input.agent.name === "openclaw" || input.agent.name === "hermes");
  const prebuild = await prebuildSandboxImageIfEligible({
    ...prebuildInput,
    createArgs: input.createArgs,
    requiresLocalBuildKit,
    sandboxName: input.sandboxName,
  });
  return {
    ...prepareSandboxCreateLaunch({ ...launchInput, createArgs: prebuild.createArgs }),
    prebuild,
  };
}
