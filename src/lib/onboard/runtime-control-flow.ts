// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type Session, updateSession } from "../state/onboard-session";
import { clearAgentScopedResumeState } from "./agent-resume-state";
import { isDcodeAutoApprovalMode } from "./dcode-auto-approval";
import { managedSandboxFeatureIssue } from "./managed-sandbox-feature";
import { stopTrackedModelRouterForAgentChange } from "./model-router-process";
import { DCODE_OBSERVABILITY_FEATURE } from "./observability-policy-presets";
import { formatSandboxAgentName, normalizeSandboxAgentName } from "./sandbox-agent";
import { applyOnboardToolDisclosureRequest } from "./tool-disclosure-flow";
import type { OnboardOptions } from "./types";

export { clearAgentScopedResumeState };
export {
  resolveCurrentOpenShellComputePlan,
  resolveCurrentOpenShellRuntimeSelection,
} from "./compute/plan";

export interface RuntimeControlAgentDeps {
  error(message: string): void;
  exitProcess(code: number): never;
}

export interface SelectedAgentTransitionDeps extends RuntimeControlAgentDeps {
  note(message: string): void;
  stopTrackedModelRouterForAgentChange(session: Session, routerPort: number): Promise<void>;
  clearAgentScopedResumeState(session: Session, selectedAgentName: string): Session;
  updateSession(mutator: (session: Session) => Session | void): Session;
}

type SelectedAgentTransitionOverrides = Partial<Omit<SelectedAgentTransitionDeps, "note">>;

export function applyOnboardRuntimeControlRequests(
  opts: Pick<
    OnboardOptions,
    | "toolDisclosure"
    | "observabilityEnabled"
    | "observabilityRequestedExplicitly"
    | "dcodeAutoApprovalMode"
  >,
) {
  const observabilityIsExplicit = opts.observabilityRequestedExplicitly !== false;
  return {
    requestedToolDisclosure: applyOnboardToolDisclosureRequest(opts.toolDisclosure),
    requestedObservabilityEnabled:
      observabilityIsExplicit && typeof opts.observabilityEnabled === "boolean"
        ? opts.observabilityEnabled
        : null,
    requestedDcodeAutoApprovalMode: isDcodeAutoApprovalMode(opts.dcodeAutoApprovalMode)
      ? opts.dcodeAutoApprovalMode
      : null,
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
  if (
    managedSandboxFeatureIssue(DCODE_OBSERVABILITY_FEATURE, {
      agent: agentName,
      sessionValue: session?.observabilityEnabled,
    }) === "recorded-state-on-unsupported-agent"
  ) {
    deps.error(
      "  Recorded observability belongs to Deep Agents Code. Pass --no-observability explicitly when switching agents.",
    );
    deps.exitProcess(1);
  }
}

export interface SelectedAgentTransitionPlan {
  session: Session;
  resumeAgentChanged: boolean;
  commit(): Promise<Session>;
}

/** Plan an agent transition without changing durable state or stopping a router. */
export function planSelectedAgentTransition(
  input: {
    resume: boolean;
    session: Session | null;
    selectedAgentName: string | null | undefined;
    routerPort: number;
    note(message: string): void;
  },
  overrides: SelectedAgentTransitionOverrides = {},
): SelectedAgentTransitionPlan {
  const deps: SelectedAgentTransitionDeps = {
    note: input.note,
    stopTrackedModelRouterForAgentChange,
    clearAgentScopedResumeState,
    updateSession,
    error: console.error,
    exitProcess: (code) => process.exit(code),
    ...overrides,
  };
  validateSessionAgentObservability(input.session, input.selectedAgentName, deps);
  if (!input.session) throw new Error("Agent transition requires an active onboarding session.");

  const selectedAgentName = normalizeSandboxAgentName(input.selectedAgentName);
  const recordedAgentName = normalizeSandboxAgentName(input.session?.agent);
  const resumeAgentChanged = Boolean(
    input.resume && input.session && recordedAgentName !== selectedAgentName,
  );
  const originalSession = structuredClone(input.session);
  let projectedSession = structuredClone(input.session);
  if (resumeAgentChanged) {
    projectedSession = deps.clearAgentScopedResumeState(projectedSession, selectedAgentName);
  }
  projectedSession = updateSessionAgent(projectedSession, input.selectedAgentName, deps);
  let committed: Promise<Session> | null = null;
  return {
    session: projectedSession,
    resumeAgentChanged,
    commit() {
      committed ??= (async () => {
        if (resumeAgentChanged) {
          deps.note(
            `  Agent changed from ${formatSandboxAgentName(recordedAgentName)} to ${formatSandboxAgentName(selectedAgentName)}; refreshing provider selection.`,
          );
          await deps.stopTrackedModelRouterForAgentChange(originalSession, input.routerPort);
        }
        return deps.updateSession((current) => {
          const transitioned = resumeAgentChanged
            ? deps.clearAgentScopedResumeState(current, selectedAgentName)
            : current;
          return updateSessionAgent(transitioned, input.selectedAgentName, deps);
        });
      })();
      return committed;
    },
  };
}
