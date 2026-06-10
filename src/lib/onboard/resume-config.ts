// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const onboardProviders = require("./providers");

export interface ResumeSessionLike {
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  agent?: string | null;
  metadata?: { fromDockerfile?: string | null } | null;
  steps?: { sandbox?: { status?: string | null } | null } | null;
}

export interface ResumeConfigConflict {
  field: string;
  requested: string | null;
  recorded: string | null;
}

export function getRequestedSandboxNameHint(
  opts: { sandboxName?: string | null } = {},
): string | null {
  const raw =
    typeof opts.sandboxName === "string" && opts.sandboxName.length > 0
      ? opts.sandboxName
      : process.env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

export function getResumeSandboxConflict(
  session: ResumeSessionLike | null,
  opts: { sandboxName?: string | null } = {},
): { requestedSandboxName: string; recordedSandboxName: string } | null {
  // Use opts.sandboxName as the sole source — the caller has already
  // resolved it (--name first, NEMOCLAW_SANDBOX_NAME only when prompting
  // is impossible). Falling back to the env var here would fire spurious
  // conflicts for interactive resume runs whose shell happens to export
  // NEMOCLAW_SANDBOX_NAME but which never actually consult it.
  // #2753: only treat session.sandboxName as a conflict source if the
  // sandbox step actually completed. A pre-fix incomplete session would
  // otherwise reject a legitimate `--resume --name <new>` that the user
  // is supplying precisely to recover from the phantom.
  const raw = typeof opts.sandboxName === "string" ? opts.sandboxName.trim().toLowerCase() : "";
  const requestedSandboxName = raw || null;
  const recordedSandboxName =
    session?.steps?.sandbox?.status === "complete" ? (session?.sandboxName ?? null) : null;
  if (!requestedSandboxName || !recordedSandboxName) {
    return null;
  }
  return requestedSandboxName !== recordedSandboxName
    ? { requestedSandboxName, recordedSandboxName }
    : null;
}

export function getRequestedProviderHint(nonInteractive = false): string | null {
  return onboardProviders.getRequestedProviderHint(nonInteractive);
}

export function getRequestedModelHint(nonInteractive = false): string | null {
  return onboardProviders.getRequestedModelHint(nonInteractive);
}

export function getResumeConfigConflicts(
  session: ResumeSessionLike | null,
  opts: {
    nonInteractive?: boolean;
    fromDockerfile?: string | null;
    sandboxName?: string | null;
    agent?: string | null;
  } = {},
): ResumeConfigConflict[] {
  const conflicts: ResumeConfigConflict[] = [];
  const nonInteractive = opts.nonInteractive ?? false;

  const sandboxConflict = getResumeSandboxConflict(session, { sandboxName: opts.sandboxName });
  if (sandboxConflict) {
    conflicts.push({
      field: "sandbox",
      requested: sandboxConflict.requestedSandboxName,
      recorded: sandboxConflict.recordedSandboxName,
    });
  }

  const requestedProvider = getRequestedProviderHint(nonInteractive);
  const effectiveRequestedProvider = onboardProviders.getEffectiveProviderName(requestedProvider);
  if (
    effectiveRequestedProvider &&
    session?.provider &&
    effectiveRequestedProvider !== session.provider
  ) {
    conflicts.push({
      field: "provider",
      requested: effectiveRequestedProvider,
      recorded: session.provider,
    });
  }

  const requestedModel = getRequestedModelHint(nonInteractive);
  if (requestedModel && session?.model && requestedModel !== session.model) {
    conflicts.push({
      field: "model",
      requested: requestedModel,
      recorded: session.model,
    });
  }

  const requestedFrom = opts.fromDockerfile ? path.resolve(opts.fromDockerfile) : null;
  const recordedFrom = session?.metadata?.fromDockerfile
    ? path.resolve(session.metadata.fromDockerfile)
    : null;
  if (requestedFrom !== recordedFrom) {
    conflicts.push({
      field: "fromDockerfile",
      requested: requestedFrom,
      recorded: recordedFrom,
    });
  }

  return conflicts;
}
