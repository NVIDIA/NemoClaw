// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import { loadResumeCheckpoint } from "../state/onboard-checkpoint-migrate";
import type { CheckpointLoadResult } from "../state/onboard-checkpoint-types";
import type { Session } from "../state/onboard-session";
import { DEFAULT_TOOL_DISCLOSURE, type ToolDisclosure } from "../tool-disclosure";
import { recordCheckpointSandboxIdentity } from "./checkpoint-record";
import { checkpointProvesSandboxStepComplete } from "./checkpoint-replay";
import type { ResumeConfigConflict } from "./resume-config";
import type { StationExpressResumeIntent } from "./station-express-resume";

export interface OnboardSessionBootstrapInput {
  resume: boolean;
  fresh: boolean;
  requestedFromDockerfile: string | null;
  requestedSandboxName: string | null;
  cannotPrompt: boolean;
  nonInteractive: boolean;
  authoritativeResumeConfig?: boolean;
  agentFlag?: string | null;
  envAgent?: string | null;
  requestedToolDisclosure?: ToolDisclosure | null;
  requestedObservabilityEnabled?: boolean | null;
  stationExpressIntent?: StationExpressResumeIntent | null;
}

export interface OnboardSessionBootstrapDeps {
  loadSession(): Session | null;
  clearSession(): void;
  createSession(overrides?: Partial<Session>): Session;
  saveSession(session: Session): Session;
  updateSession(mutator: (session: Session) => Session | void): Session;
  applySessionRecovery(session: Session): void;
  setOnboardBrandingAgent(agentName: string | null): void;
  getResumeConfigConflicts(
    session: Session | null,
    opts: {
      nonInteractive?: boolean;
      fromDockerfile?: string | null;
      sandboxName?: string | null;
      agent?: string | null;
      toolDisclosure?: ToolDisclosure | null;
      observabilityEnabled?: boolean | null;
      authoritativeResumeConfig?: boolean;
    },
  ): ResumeConfigConflict[];
  recordResumeConflict(conflict: ResumeConfigConflict): Promise<unknown>;
  resolvePath(value: string): string;
  cliName(): string;
  error(message: string): void;
  exitProcess(code: number): never;
  resolveResumeCheckpoint(): CheckpointLoadResult;
}

export interface OnboardSessionBootstrapResult {
  session: Session | null;
  fromDockerfile: string | null;
}

export const defaultResolveResumeCheckpoint: () => CheckpointLoadResult = loadResumeCheckpoint;

export function checkpointSandboxName(
  sandboxName: string,
  agent: { name?: string } | null,
  updateSession: OnboardSessionBootstrapDeps["updateSession"],
): void {
  if (agent?.name && agent.name !== "openclaw") return;
  updateSession((current) => {
    current.sandboxName = sandboxName;
    current.sandboxPromptProgress.sandboxName = true;
    recordCheckpointSandboxIdentity(
      current,
      sandboxName,
      current.agent ?? agent?.name ?? "openclaw",
    );
    return current;
  });
}

export function getCheckpointedSandboxName(
  resume: boolean,
  agent: { name?: string } | null,
  session: Session | null,
): string | null {
  if (!resume) return null;
  if (session?.checkpoint) {
    return isDecisionSelected(session.checkpoint.sandboxIdentity)
      ? session.checkpoint.sandboxIdentity.value.name
      : null;
  }
  return (!agent?.name || agent.name === "openclaw") &&
    session?.sandboxPromptProgress?.sandboxName === true
    ? session.sandboxName
    : null;
}

function mode(nonInteractive: boolean): "non-interactive" | "interactive" {
  return nonInteractive ? "non-interactive" : "interactive";
}

function reportMissingResumeSession(deps: OnboardSessionBootstrapDeps): never {
  deps.error("  No resumable onboarding session was found.");
  deps.error("  --resume only continues an interrupted onboarding run.");
  deps.error("  To change configuration on an existing sandbox, rebuild it:");
  deps.error(`    ${deps.cliName()} onboard`);
  deps.exitProcess(1);
}

function reportUnsupportedResumeCheckpoint(
  foundVersion: number,
  deps: OnboardSessionBootstrapDeps,
): never {
  deps.error(
    `  This onboarding session was written by a newer NemoClaw (checkpoint schema v${foundVersion}).`,
  );
  deps.error(
    "  Resuming it with this version could create a second sandbox or drop recorded decisions.",
  );
  deps.error(`  Upgrade NemoClaw to resume it, or start fresh: ${deps.cliName()} onboard`);
  deps.exitProcess(1);
}

function reportCorruptResumeCheckpoint(deps: OnboardSessionBootstrapDeps): never {
  deps.error("  The onboarding resume checkpoint is unreadable and cannot be safely continued.");
  deps.error(`  Start fresh: ${deps.cliName()} onboard`);
  deps.exitProcess(1);
}

function guardResumeCheckpoint(deps: OnboardSessionBootstrapDeps): void {
  const result = deps.resolveResumeCheckpoint();
  if (result?.status === "unsupported_future") {
    reportUnsupportedResumeCheckpoint(result.foundVersion, deps);
  }
  if (result?.status === "corrupt") {
    reportCorruptResumeCheckpoint(deps);
  }
  if (result?.status === "migrated") {
    const migratedCheckpoint = result.checkpoint;
    deps.updateSession((current) => {
      current.checkpoint = migratedCheckpoint;
      return current;
    });
  }
}

function reportResumeConflict(
  conflict: ResumeConfigConflict,
  deps: OnboardSessionBootstrapDeps,
): void {
  if (conflict.field === "sandbox") {
    deps.error(
      `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
    );
    return;
  }
  if (conflict.field === "agent") {
    deps.error(
      `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
    );
    return;
  }
  if (conflict.field === "fromDockerfile") {
    if (!conflict.recorded) {
      deps.error(
        `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
      );
    } else if (!conflict.requested) {
      deps.error(
        `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
      );
    } else {
      deps.error(
        `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
      );
    }
    return;
  }
  deps.error(
    `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
  );
}

async function exitForResumeConflicts(
  conflicts: ResumeConfigConflict[],
  deps: OnboardSessionBootstrapDeps,
): Promise<never> {
  for (const conflict of conflicts) {
    try {
      await deps.recordResumeConflict(conflict);
    } catch {
      // Conflict reporting is the enforcing source of truth here; the runtime
      // diagnostic write is best-effort and must not hide the user-facing exit.
      // Remove this suppression if recordResumeConflict becomes authoritative.
    }
    reportResumeConflict(conflict, deps);
  }
  deps.error(`  Run: ${deps.cliName()} onboard              # start a fresh onboarding session`);
  deps.error("  Or rerun with the original settings to continue that session.");
  deps.exitProcess(1);
}

function assertRecoverableResumeSandboxName(
  session: Session | null,
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): void {
  const checkpoint = session?.checkpoint ?? null;
  const nameRecoverable = checkpoint
    ? checkpointProvesSandboxStepComplete(session) || isDecisionSelected(checkpoint.sandboxIdentity)
    : session?.steps?.sandbox?.status === "complete" ||
      ((!session?.agent || session.agent === "openclaw") &&
        session?.sandboxPromptProgress?.sandboxName === true);
  const checkpointedSandboxName =
    checkpoint && isDecisionSelected(checkpoint.sandboxIdentity)
      ? checkpoint.sandboxIdentity.value.name
      : null;
  const recoveredSandboxName =
    input.requestedSandboxName ||
    (nameRecoverable ? checkpointedSandboxName || session?.sandboxName || null : null);
  if (input.cannotPrompt && !recoveredSandboxName) {
    deps.error(
      "  Cannot resume non-interactive onboard: the previous run was interrupted before sandbox creation completed,",
    );
    deps.error(
      "  so no sandbox name was recorded. Re-run with --name <sandbox> (or set NEMOCLAW_SANDBOX_NAME).",
    );
    deps.exitProcess(1);
  }
}

async function prepareResumeSession(
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): Promise<OnboardSessionBootstrapResult> {
  let session = deps.loadSession();
  deps.setOnboardBrandingAgent(input.agentFlag || session?.agent || input.envAgent || null);
  if (!session || session.resumable === false) {
    reportMissingResumeSession(deps);
  }
  guardResumeCheckpoint(deps);

  const sessionFrom = session.metadata?.fromDockerfile || null;
  const fromDockerfile = input.requestedFromDockerfile
    ? deps.resolvePath(input.requestedFromDockerfile)
    : sessionFrom
      ? deps.resolvePath(sessionFrom)
      : null;
  const resumeConflicts = deps.getResumeConfigConflicts(session, {
    nonInteractive: input.nonInteractive,
    fromDockerfile: input.requestedFromDockerfile,
    sandboxName: input.requestedSandboxName,
    agent: input.agentFlag || null,
    toolDisclosure: input.requestedToolDisclosure ?? null,
    observabilityEnabled: input.requestedObservabilityEnabled ?? null,
    authoritativeResumeConfig: input.authoritativeResumeConfig,
  });
  if (resumeConflicts.length > 0) {
    await exitForResumeConflicts(resumeConflicts, deps);
  }

  deps.updateSession((current: Session) => {
    deps.applySessionRecovery(current);
    if (typeof input.requestedObservabilityEnabled === "boolean") {
      current.observabilityEnabled = input.requestedObservabilityEnabled;
      current.observabilityRequestedExplicitly = true;
    }
    current.mode = mode(input.nonInteractive);
    current.failure = null;
    current.status = "in_progress";
    return current;
  });
  session = deps.loadSession();
  assertRecoverableResumeSandboxName(session, input, deps);
  return { session, fromDockerfile };
}

function prepareFreshSession(
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): OnboardSessionBootstrapResult {
  if (input.fresh) {
    deps.clearSession();
  }
  const fromDockerfile = input.requestedFromDockerfile
    ? deps.resolvePath(input.requestedFromDockerfile)
    : null;
  const session = deps.saveSession(
    deps.createSession({
      mode: mode(input.nonInteractive),
      toolDisclosure: input.requestedToolDisclosure ?? DEFAULT_TOOL_DISCLOSURE,
      observabilityEnabled: input.requestedObservabilityEnabled === true,
      observabilityRequestedExplicitly: typeof input.requestedObservabilityEnabled === "boolean",
      stationExpressIntent: input.stationExpressIntent ?? null,
      metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
    }),
  );
  return { session, fromDockerfile };
}

export async function prepareOnboardSession(
  input: OnboardSessionBootstrapInput,
  deps: OnboardSessionBootstrapDeps,
): Promise<OnboardSessionBootstrapResult> {
  return input.resume ? prepareResumeSession(input, deps) : prepareFreshSession(input, deps);
}

export function prepareOnboardSessionValidated(
  input: OnboardSessionBootstrapInput,
  deps: Omit<OnboardSessionBootstrapDeps, "resolveResumeCheckpoint">,
): Promise<OnboardSessionBootstrapResult> {
  return prepareOnboardSession(input, {
    ...deps,
    resolveResumeCheckpoint: defaultResolveResumeCheckpoint,
  });
}
