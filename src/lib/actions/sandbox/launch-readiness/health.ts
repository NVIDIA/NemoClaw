// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../../adapters/openshell/timeouts";
import type { AgentDefinition } from "../../../agent/defs";
import { isTerminalAgent, listAgents, loadAgent } from "../../../agent/defs";
import * as agentRuntime from "../../../agent/runtime";
import { runAgentSmokeCommands } from "../../../agent/terminal-smoke";
import type { SandboxEntry } from "../../../state/registry";
import {
  buildSandboxInferenceRouteProbeArgs,
  type InferenceRouteProbeAgent,
  parseSandboxInferenceRouteProbeResult,
} from "../connect-inference-route-probe";
import { areSandboxLaunchForwardsHealthy } from "../forward-recovery";
import {
  isDcodeOpenRouterModelsRoute404,
  runSandboxInferenceInvocationProbe,
} from "../inference-route-health";
import { isSandboxGatewayRunningForStatus } from "../process-recovery";

export type LaunchReadinessObservationCategory =
  | "missing"
  | "unsafe"
  | "malformed"
  | "expired"
  | "identity"
  | "config"
  | "health"
  | "session";

export type LaunchReadinessCaptureResult = ReturnType<typeof captureOpenshell>;

export type LaunchReadinessFailedCheck = "inference request";

export interface LaunchReadinessHealthDeps {
  listAgents?: typeof listAgents;
  loadAgent?: typeof loadAgent;
  capture?: (args: string[]) => LaunchReadinessCaptureResult;
  gatewayHealth?: (sandboxName: string, gatewayName: string) => Promise<boolean | null>;
  forwardsHealthy?: (sandboxName: string, gatewayName: string) => boolean | null;
  smoke?: typeof runAgentSmokeCommands;
  inferenceProbe?: (
    sandboxName: string,
    agent: InferenceRouteProbeAgent,
    gatewayName: string,
  ) => ReturnType<typeof parseSandboxInferenceRouteProbeResult>;
  inferenceInvocationProbe?: typeof runSandboxInferenceInvocationProbe;
}

export class LaunchReadinessObservationError extends Error {
  constructor(
    readonly category: LaunchReadinessObservationCategory,
    readonly failedCheck?: LaunchReadinessFailedCheck,
  ) {
    super(category);
  }
}

/** The required observation could not produce authoritative evidence. */
export class LaunchReadinessEvidenceError extends Error {
  constructor() {
    super("launch readiness evidence unavailable");
  }
}

export function captureLaunchReadiness(
  args: string[],
  options: { includeStreams?: boolean; maxBuffer?: number } = {},
): LaunchReadinessCaptureResult {
  return captureOpenshell(args, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    ...options,
  });
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveLaunchInteractiveCommand(
  agent: AgentDefinition,
  agentName: string,
): string | null {
  return agentRuntime.getInteractiveAgentCommand(agent, agentName);
}

export function resolveTrustedLaunchAgent(
  entry: SandboxEntry,
  deps: LaunchReadinessHealthDeps,
  agentName = normalizedString(entry.agent) ?? "openclaw",
): AgentDefinition {
  const available = (deps.listAgents ?? listAgents)();
  if (!available.includes(agentName)) throw new LaunchReadinessObservationError("config");
  let agent: AgentDefinition;
  try {
    agent = (deps.loadAgent ?? loadAgent)(agentName);
  } catch {
    throw new LaunchReadinessEvidenceError();
  }
  const interactive = resolveLaunchInteractiveCommand(agent, agentName);
  if (!interactive) throw new LaunchReadinessObservationError("session");
  return agent;
}

function probeInferenceRoute(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  gatewayName: string,
): ReturnType<typeof parseSandboxInferenceRouteProbeResult> {
  return parseSandboxInferenceRouteProbeResult(
    captureLaunchReadiness(buildSandboxInferenceRouteProbeArgs(sandboxName, agent, gatewayName), {
      includeStreams: true,
    }),
  );
}

export async function requireLaunchSemanticHealth(
  sandboxName: string,
  gatewayName: string,
  agentName: string,
  entry: SandboxEntry,
  agent: AgentDefinition,
  inferenceConfigured: boolean,
  deps: LaunchReadinessHealthDeps,
): Promise<void> {
  if (isTerminalAgent(agent)) {
    const smoke = (deps.smoke ?? runAgentSmokeCommands)(
      sandboxName,
      agent,
      (args, _options) =>
        (deps.capture ?? ((captureArgs) => captureLaunchReadiness(captureArgs)))(args),
      gatewayName,
    );
    if (!smoke.ok) {
      const trustedExit = smoke.output?.match(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_EXIT:(\d+)(?:\n|$)/);
      if (!trustedExit) throw new LaunchReadinessEvidenceError();
      throw new LaunchReadinessObservationError("health");
    }
  } else {
    const running = await (deps.gatewayHealth ?? isSandboxGatewayRunningForStatus)(
      sandboxName,
      gatewayName,
    );
    if (running === null) throw new LaunchReadinessEvidenceError();
    if (!running) throw new LaunchReadinessObservationError("health");
    const forwards = (deps.forwardsHealthy ?? areSandboxLaunchForwardsHealthy)(
      sandboxName,
      gatewayName,
    );
    if (forwards === null) throw new LaunchReadinessEvidenceError();
    if (!forwards) {
      throw new LaunchReadinessObservationError("health");
    }
  }
  if (inferenceConfigured) {
    const inference = (deps.inferenceProbe ?? probeInferenceRoute)(sandboxName, agent, gatewayName);
    const strictRouteHealth =
      inference.healthy && inference.httpStatus >= 200 && inference.httpStatus < 300;
    if (strictRouteHealth) return;
    const openRouterDcodeModelsRouteUnsupported =
      inference.healthy &&
      isDcodeOpenRouterModelsRoute404(
        { agentName, provider: entry.provider ?? null },
        inference.httpStatus,
      );
    if (openRouterDcodeModelsRouteUnsupported) {
      const provider = normalizedString(entry.provider);
      const model = normalizedString(entry.model);
      if (!provider || !model) throw new LaunchReadinessEvidenceError();
      const invocation = (deps.inferenceInvocationProbe ?? runSandboxInferenceInvocationProbe)({
        sandboxName,
        gatewayName,
        agentName,
        provider,
        model,
        preferredInferenceApi: normalizedString(entry.preferredInferenceApi),
      });
      if (invocation.ok) return;
      throw new LaunchReadinessObservationError("health", "inference request");
    }
    if (inference.broken || (inference.httpStatus >= 100 && inference.httpStatus < 600)) {
      throw new LaunchReadinessObservationError("health");
    }
    throw new LaunchReadinessEvidenceError();
  }
}
