// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import type { ResumeConfigConflict } from "./resume-config";

export interface OnboardSessionBootstrapInput {
  resume: boolean;
  fresh: boolean;
  requestedFromDockerfile: string | null;
  requestedSandboxName: string | null;
  cannotPrompt: boolean;
  nonInteractive: boolean;
  agentFlag?: string | null;
  envAgent?: string | null;
}

export interface OnboardSessionBootstrapDeps {
  loadSession(): Session | null;
  clearSession(): void;
  createSession(overrides?: Partial<Session>): Session;
  saveSession(session: Session): Session;
  updateSession(mutator: (session: Session) => Session | void): Session;
  repairResumeMachineSnapshot(session: Session): Session;
  setOnboardBrandingAgent(agentName: string | null): void;
  getResumeConfigConflicts(
    session: Session | null,
    opts: {
      nonInteractive?: boolean;
      fromDockerfile?: string | null;
      sandboxName?: string | null;
      agent?: string | null;
    },
  ): ResumeConfigConflict[];
  recordResumeConflict(conflict: ResumeConfigConflict): Promise<unknown>;
  resolvePath(value: string): string;
  cliName(): string;
  error(message: string): void;
  exitProcess(code: number): never;
}

export interface OnboardSessionBootstrapResult {
  session: Session | null;
  fromDockerfile: string | null;
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
  const sandboxStepCompleted = session?.steps?.sandbox?.status === "complete";
  const recoveredSandboxName =
    input.requestedSandboxName || (sandboxStepCompleted ? session?.sandboxName || null : null);
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
  });
  if (resumeConflicts.length > 0) {
    await exitForResumeConflicts(resumeConflicts, deps);
  }

  deps.updateSession((current: Session) => {
    deps.repairResumeMachineSnapshot(current);
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
