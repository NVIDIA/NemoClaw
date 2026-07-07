// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import { isDcodeAgent } from "./observability-policy-presets";
import { formatSandboxAgentName, normalizeSandboxAgentName } from "./sandbox-agent";
import { applyOnboardToolDisclosureRequest } from "./tool-disclosure-flow";
import type { OnboardOptions } from "./types";

export interface RuntimeControlAgentDeps {
  error(message: string): void;
  exitProcess(code: number): never;
}

export interface SelectedAgentTransitionDeps extends RuntimeControlAgentDeps {
  note(message: string): void;
  stopTrackedModelRouterForAgentChange(session: Session, routerPort: number): Promise<void>;
  clearAgentScopedResumeState(session: Session, selectedAgentName: string): Session;
  setOnboardBrandingAgent(agentName: string): void;
  updateSession(mutator: (session: Session) => Session | void): Session;
}

export function applyOnboardRuntimeControlRequests(
  opts: Pick<OnboardOptions, "toolDisclosure" | "observabilityEnabled">,
) {
  return {
    requestedToolDisclosure: applyOnboardToolDisclosureRequest(opts.toolDisclosure),
    requestedObservabilityEnabled:
      typeof opts.observabilityEnabled === "boolean" ? opts.observabilityEnabled : null,
  };
}

export function updateSessionAgent(
  session: Session,
  agentName: string | null | undefined,
  deps: RuntimeControlAgentDeps = {
    error: console.error,
    exitProcess: (code) => process.exit(code),
  },
): Session {
  validateSessionAgentObservability(session, agentName, deps);
  session.agent = agentName ?? null;
  return session;
}

export function validateSessionAgentObservability(
  session: Pick<Session, "observabilityEnabled"> | null,
  agentName: string | null | undefined,
  deps: RuntimeControlAgentDeps = {
    error: console.error,
    exitProcess: (code) => process.exit(code),
  },
): void {
  if (session?.observabilityEnabled && !isDcodeAgent(agentName)) {
    deps.error(
      "  Recorded observability belongs to Deep Agents Code. Pass --no-observability explicitly when switching agents.",
    );
    deps.exitProcess(1);
  }
}

export async function applySelectedAgentTransition(
  input: {
    resume: boolean;
    session: Session | null;
    selectedAgentName: string | null | undefined;
    routerPort: number;
  },
  deps: SelectedAgentTransitionDeps,
): Promise<{ session: Session; resumeAgentChanged: boolean }> {
  validateSessionAgentObservability(input.session, input.selectedAgentName, deps);

  const selectedAgentName = normalizeSandboxAgentName(input.selectedAgentName);
  const recordedAgentName = normalizeSandboxAgentName(input.session?.agent);
  const resumeAgentChanged = Boolean(
    input.resume && input.session && recordedAgentName !== selectedAgentName,
  );
  if (resumeAgentChanged && input.session) {
    deps.note(
      `  Agent changed from ${formatSandboxAgentName(recordedAgentName)} to ${formatSandboxAgentName(selectedAgentName)}; refreshing provider selection.`,
    );
    await deps.stopTrackedModelRouterForAgentChange(input.session, input.routerPort);
    deps.updateSession((current) => deps.clearAgentScopedResumeState(current, selectedAgentName));
  }
  deps.setOnboardBrandingAgent(input.selectedAgentName || "openclaw");
  const session = deps.updateSession((current) =>
    updateSessionAgent(current, input.selectedAgentName, deps),
  );
  return { session, resumeAgentChanged };
}
