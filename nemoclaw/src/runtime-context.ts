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
  "outbound network is deny-by-default; assume no arbitrary internet access",
  "blocked requests can return proxy 403 and may need operator approval or policy changes",
];

const STATIC_FILESYSTEM_LINES = [
  "filesystem/process access is sandboxed; do not assume host-level access",
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
    "- Do not claim unrestricted host or internet access.",
    "- if access is blocked, say it is blocked and ask the operator to adjust policy or approve it in OpenShell",
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
    prependContext: buildRuntimeContextText(getRuntimeSummary(pluginConfig)),
  }));
}
