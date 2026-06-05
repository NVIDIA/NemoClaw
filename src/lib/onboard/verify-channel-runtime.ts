// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Build the `probeChannelRuntimeStatus` dep that the post-deployment
 * verifier wires through to `verifyDeployment`. Kept out of `onboard.ts`
 * itself so the entrypoint stays net-neutral (see the
 * `onboard-entrypoint-budget` CI gate) and so the wiring can be
 * unit-tested without spinning up the whole onboarding state machine.
 */

import type { AgentDefinition } from "../agent/defs";
import {
  probeChannelRuntimeStatus,
  type ChannelRuntimeStatusDeps,
  type RuntimeChannelStatus,
} from "../channel-runtime-status";
import { executeSandboxCommandForVerification } from "./sandbox-verification-exec";

export interface ChannelRuntimeProbeDeps {
  /**
   * Execute a shell snippet inside the named sandbox. Returns null when
   * the openshell exec itself failed to spawn or timed out (matching
   * the contract in `onboard/sandbox-verification-exec.ts`).
   */
  executeSandboxCommand: ChannelRuntimeStatusDeps["executeSandboxCommand"];
}

/**
 * Return a no-arg probe function suitable for `verifyDeployment`'s
 * optional `probeChannelRuntimeStatus` dep. Returns `null` when the
 * agent does not store channel config in a JSON file the OpenClaw
 * runtime parses (today: only OpenClaw qualifies — Hermes uses env/yaml).
 *
 * Fixes #4156: NemoClaw onboarding never compared configured channels
 * to the runtime view, so a baked image with a missing or unloaded
 * channel block produced the dashboard's "No channels found" panel
 * without any host-side warning.
 */
export function buildChannelRuntimeProbe(
  agent: AgentDefinition | null,
  deps: ChannelRuntimeProbeDeps,
): (() => RuntimeChannelStatus | null) | null {
  const configPaths = agent?.configPaths;
  if (!configPaths || configPaths.format !== "json") return null;
  const configFilePath = `${configPaths.dir}/${configPaths.configFile}`;
  return () =>
    probeChannelRuntimeStatus({
      configFilePath,
      executeSandboxCommand: deps.executeSandboxCommand,
    });
}

/**
 * Onboard-specific convenience wrapper: binds the sandbox name so the
 * call site in `onboard.ts` is a single line and the entrypoint stays
 * within its size budget. Pre-fills `executeSandboxCommand` with the
 * SSH-based exec helper onboarding already uses for verification probes.
 */
export function buildOnboardChannelRuntimeProbe(
  agent: AgentDefinition | null,
  sandboxName: string,
): (() => RuntimeChannelStatus | null) | undefined {
  return (
    buildChannelRuntimeProbe(agent, {
      executeSandboxCommand: (script: string) =>
        executeSandboxCommandForVerification(sandboxName, script),
    }) ?? undefined
  );
}
