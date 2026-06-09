// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadState } from "./blueprint/state.js";
import type { NemoClawConfig, OpenClawPluginApi } from "./index.js";

interface RuntimeSummary {
  sandboxName: string;
  sandboxPhase: string | null;
  networkLines: string[];
  filesystemLines: string[];
}

const STATIC_NETWORK_LINES = [
  "outbound network is deny-by-default, but allowed endpoints work, so verify by attempting a request rather than assuming a host is unreachable",
  "attempting a restricted endpoint is productive: a proxy or policy denial raises an operator approval request in OpenShell, so make the request rather than refusing preemptively; if it fails, report the actual error and distinguish a policy denial (which the operator can approve) from other network errors such as DNS, timeout, or TLS failures",
];

const STATIC_FILESYSTEM_LINES = [
  "filesystem and process access are scoped to the sandbox, not the host; do not assume access to host paths outside it",
  "within the sandbox you can create, edit, and run files (for example in /tmp or /sandbox) using your file and shell tools; try the operation and report if it fails rather than assuming it is unavailable",
];

/**
 * Resolves the active sandbox name by preferring the persisted state value
 * over the plugin configuration default.
 */
function getSandboxName(pluginConfig: NemoClawConfig): string {
  return loadState().sandboxName ?? pluginConfig.sandboxName;
}

/**
 * Returns static sandbox context without invoking OpenShell subprocesses.
 *
 * The gateway-loaded plugin must pass OpenClaw's install-time safety scanner,
 * so this intentionally avoids shelling out for live policy details. A future
 * implementation can replace this with Gateway API reads if OpenClaw exposes
 * policy state to plugins without subprocess execution.
 */
export function getRuntimeSummary(pluginConfig: NemoClawConfig): RuntimeSummary {
  let sandboxName = pluginConfig.sandboxName;
  try {
    sandboxName = getSandboxName(pluginConfig);
  } catch {
    // Keep the configured default if persisted state cannot be read.
  }

  return {
    sandboxName,
    sandboxPhase: null,
    networkLines: STATIC_NETWORK_LINES,
    filesystemLines: STATIC_FILESYSTEM_LINES,
  };
}

function buildRuntimeContextText(summary: RuntimeSummary): string {
  const lines = [
    "<nemoclaw-runtime>",
    `You are running inside OpenShell sandbox "${summary.sandboxName}" via NemoClaw.`,
    "Treat this as a sandboxed environment, not unrestricted host access.",
    summary.sandboxPhase ? `Current sandbox phase: ${summary.sandboxPhase}.` : null,
    "Network policy:",
    ...summary.networkLines.map((line) => `- ${line}`),
    "Filesystem policy:",
    ...summary.filesystemLines.map((line) => `- ${line}`),
    "Behavior:",
    "- Do not assert that a URL or host is blocked or unreachable unless you have actually attempted it this turn; report the actual result rather than speculating.",
    "- Distinguish a proxy/policy denial, which raises an operator approval request in OpenShell, from other failures such as DNS, timeout, or TLS errors; only a policy denial is something the operator can approve.",
    "- Do not claim unrestricted host or internet access either. When unsure, attempt the action and rely on the real result instead of speculating about the environment.",
    "</nemoclaw-runtime>",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

/**
 * Registers a `before_prompt_build` hook that prepends a static
 * `<nemoclaw-runtime>` context block to each agent turn.
 */
export function registerRuntimeContext(api: OpenClawPluginApi, pluginConfig: NemoClawConfig): void {
  api.on("before_prompt_build", () => ({
    prependSystemContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig)),
  }));
}
