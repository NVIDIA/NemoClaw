// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { formatEnvAssignment } from "../core/url-utils";
import { buildSubprocessEnv } from "../subprocess-env";
import { isValidProxyHost, isValidProxyPort } from "./dockerfile-patch";
import { appendExtraPlaceholderKeysEnvArg } from "./extra-placeholder-keys";
import type { HermesDashboardOnboardState } from "./hermes-dashboard";
import { appendHermesDashboardEnvArgs } from "./hermes-dashboard";
import { appendHostProxyEnvArgs } from "./host-proxy-env";
import { appendOpenClawRuntimeEnvArgs } from "./openclaw-runtime-env";
import {
  prebuildSandboxImageIfEligible,
  type SandboxPrebuildInput,
  type SandboxPrebuildResult,
} from "./sandbox-prebuild";

type OpenshellShellCommand = (args: string[]) => string;
type OpenshellArgv = (args: string[]) => string[];

// These non-secret scheduler controls are intentionally forwarded for bounded
// live-test and operator tuning. Keep this as an exact allowlist: the host's
// broader NEMOCLAW_* environment must not become sandbox runtime input.
const OPENCLAW_AUTO_PAIR_RUNTIME_ENV_KEYS = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
] as const;

function appendOpenClawAutoPairRuntimeEnvArgs(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (agent && agent.name !== "openclaw") return;
  for (const key of OPENCLAW_AUTO_PAIR_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) envArgs.push(formatEnvAssignment(key, value));
  }
}

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
  manageDashboard?: boolean;
  openshellShellCommand: OpenshellShellCommand;
  openshellArgv?: OpenshellArgv;
  buildEnv?(): Record<string, string>;
}

export interface SandboxCreateLaunch {
  createCommand: string;
  createArgv: string[];
  effectiveDashboardPort: string;
  envArgs: string[];
  sandboxEnv: Record<string, string>;
  sandboxStartupCommand: string[];
}

export interface SandboxCreateLaunchWithPrebuildInput extends SandboxCreateLaunchInput {
  sandboxName: string;
  prebuild: Omit<SandboxPrebuildInput, "createArgs" | "sandboxName">;
}

export interface SandboxCreateLaunchWithPrebuild extends SandboxCreateLaunch {
  prebuild: SandboxPrebuildResult;
}

export function prepareSandboxCreateLaunch(input: SandboxCreateLaunchInput): SandboxCreateLaunch {
  const env = input.env ?? process.env;
  const manageDashboard = input.manageDashboard ?? true;
  const envArgs = manageDashboard ? [formatEnvAssignment("CHAT_UI_URL", input.chatUiUrl)] : [];

  // When manageDashboard is enabled, pass the effective dashboard port into
  // the sandbox so nemoclaw-start.sh starts the gateway on the correct port.
  // If CHAT_UI_URL has a custom port (e.g. :18790), that port must reach the
  // container; otherwise _DASHBOARD_PORT defaults to 18789 and the gateway
  // listens on the wrong port. With manageDashboard disabled, CHAT_UI_URL and
  // _DASHBOARD_PORT are intentionally not injected. (#2267, #1925)
  const effectiveDashboardPort = manageDashboard
    ? input.getDashboardForwardPort(input.chatUiUrl)
    : "0";
  if (manageDashboard) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort));
  }

  appendOpenClawRuntimeEnvArgs(envArgs, input.agent ?? null);
  appendOpenClawAutoPairRuntimeEnvArgs(envArgs, input.agent ?? null, env);
  appendHermesDashboardEnvArgs(envArgs, input.hermesDashboardState, formatEnvAssignment);
  appendHostProxyEnvArgs(envArgs, env, {
    dropCredentialBearingProxyUrls: input.agent?.name === "langchain-deepagents-code",
  });

  // Propagate NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT to runtime containers
  // that consume them from sandbox-create env. patchStagedDockerfile() also
  // substitutes the validated build args; dcode pins that build-time source in
  // root-owned image files instead of trusting this runtime copy. Keep both
  // paths in sync for the other agent images that still consume runtime env.
  // Fixes #2424. Uses the shared isValidProxyHost / isValidProxyPort
  // helpers so build-time and runtime validation stay aligned.
  const sandboxProxyHost = env.NEMOCLAW_PROXY_HOST;
  if (sandboxProxyHost && isValidProxyHost(sandboxProxyHost)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_HOST", sandboxProxyHost));
  }
  const sandboxProxyPort = env.NEMOCLAW_PROXY_PORT;
  if (sandboxProxyPort && isValidProxyPort(sandboxProxyPort)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_PORT", sandboxProxyPort));
  }

  if (input.agent?.name === "langchain-deepagents-code") {
    const sandboxName = input.sandboxName;
    if (sandboxName) {
      envArgs.push(formatEnvAssignment("NEMOCLAW_SANDBOX_NAME", sandboxName));
    }
    envArgs.push(
      formatEnvAssignment(
        "NEMOCLAW_OBSERVABILITY",
        input.observabilityEnabled === true ? "1" : "0",
      ),
    );
  }

  appendExtraPlaceholderKeysEnvArg(envArgs, input.extraPlaceholderKeys, formatEnvAssignment);

  const sandboxEnv = (input.buildEnv ?? buildSubprocessEnv)();
  // Remove host-infrastructure credentials that the generic allowlist
  // permits for host-side processes but that must not enter the sandbox.
  delete sandboxEnv.KUBECONFIG;
  delete sandboxEnv.SSH_AUTH_SOCK;

  // Run without piping through awk; the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const sandboxStartupCommand = ["env", ...envArgs, "nemoclaw-start"];
  const openshellArgs = ["sandbox", "create", ...input.createArgs, "--", ...sandboxStartupCommand];
  const createCommand = `${input.openshellShellCommand(openshellArgs)} 2>&1`;
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
    sandboxName: input.sandboxName,
  });
  return {
    ...prepareSandboxCreateLaunch({ ...launchInput, createArgs: prebuild.createArgs }),
    prebuild,
  };
}
