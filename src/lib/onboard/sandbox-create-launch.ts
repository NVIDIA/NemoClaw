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

type OpenshellShellCommand = (args: string[]) => string;

export interface SandboxCreateLaunchInput {
  agent: AgentDefinition | null | undefined;
  chatUiUrl: string;
  createArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
  extraPlaceholderKeys: readonly string[];
  getDashboardForwardPort(chatUiUrl: string): string;
  hermesDashboardState: HermesDashboardOnboardState;
  openshellShellCommand: OpenshellShellCommand;
  buildEnv?(): Record<string, string>;
}

export interface SandboxCreateLaunch {
  createCommand: string;
  effectiveDashboardPort: string;
  envArgs: string[];
  sandboxEnv: Record<string, string>;
  sandboxStartupCommand: string[];
}

export function prepareSandboxCreateLaunch(input: SandboxCreateLaunchInput): SandboxCreateLaunch {
  const env = input.env ?? process.env;
  const envArgs = [formatEnvAssignment("CHAT_UI_URL", input.chatUiUrl)];

  // Always pass the effective dashboard port into the sandbox so
  // nemoclaw-start.sh starts the gateway on the correct port. When the
  // user sets CHAT_UI_URL with a custom port (e.g. :18790), the port
  // must reach the container; otherwise _DASHBOARD_PORT defaults to
  // 18789 and the gateway listens on the wrong port. (#2267, #1925)
  const effectiveDashboardPort = input.getDashboardForwardPort(input.chatUiUrl);
  envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort));

  appendOpenClawRuntimeEnvArgs(envArgs, input.agent ?? null);
  appendHermesDashboardEnvArgs(envArgs, input.hermesDashboardState, formatEnvAssignment);
  appendHostProxyEnvArgs(envArgs, env);

  // Propagate NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT to the runtime
  // sandbox container. patchStagedDockerfile() already substitutes them
  // into the build-time Dockerfile ARG/ENV, but `openshell sandbox create
  // -- env ... nemoclaw-start` only forwards the explicitly listed env vars;
  // image-baked ENV does not propagate into the running pod. Without
  // this, nemoclaw-start.sh falls back to the default 10.200.0.1:3128
  // and `HTTPS_PROXY` inside the sandbox ignores the host override. The
  // build-time substitution and runtime env stay in sync as a result.
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
  const createCommand = `${input.openshellShellCommand([
    "sandbox",
    "create",
    ...input.createArgs,
    "--",
    ...sandboxStartupCommand,
  ])} 2>&1`;

  return {
    createCommand,
    effectiveDashboardPort,
    envArgs,
    sandboxEnv,
    sandboxStartupCommand,
  };
}
