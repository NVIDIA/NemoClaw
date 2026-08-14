// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import { inspectCheckpoint } from "../../state/onboard-checkpoint";
import type { CheckpointOnboardProfile } from "../../state/onboard-checkpoint-types";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OnboardResumeIntentSnapshot {
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly checkpointUpdatedAt: string;
  readonly machineRevision: number;
  readonly profile: CheckpointOnboardProfile;
}

export class OnboardResumeIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardResumeIntentError";
  }
}

export class OnboardResumeIntentRaceError extends Error {
  readonly nemoclawOnboardResumeIntentRace = true;

  constructor() {
    super("The onboarding checkpoint changed while resume acquired its lock.");
    this.name = "OnboardResumeIntentRaceError";
  }
}

export function isOnboardResumeIntentRaceError(
  error: unknown,
): error is OnboardResumeIntentRaceError {
  return (
    error instanceof OnboardResumeIntentRaceError ||
    (typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "nemoclawOnboardResumeIntentRace") === true)
  );
}

export interface ResolvedOnboardResumeIntent {
  readonly effectiveResume: boolean;
  readonly snapshot: OnboardResumeIntentSnapshot | null;
}

function fingerprint(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function sessionFingerprint(value: Record<string, unknown>): string {
  return fingerprint(JSON.stringify(value));
}

function readRawSession(filePath: string): { value: Record<string, unknown> } | null {
  if (!fs.existsSync(filePath)) return null;
  let raw: string;
  let value: unknown;
  try {
    raw = fs.readFileSync(filePath, "utf8");
    value = JSON.parse(raw);
  } catch {
    throw new OnboardResumeIntentError(
      "The onboarding resume checkpoint is unreadable and cannot be safely continued.",
    );
  }
  if (!isObjectRecord(value)) {
    throw new OnboardResumeIntentError(
      "The onboarding resume checkpoint is unreadable and cannot be safely continued.",
    );
  }
  return { value };
}

export function resolveOnboardResumeIntent(options: {
  readonly explicitResume: boolean;
  readonly fresh: boolean;
  readonly explicitProfile: CheckpointOnboardProfile | null;
  readonly sessionFile: string;
}): ResolvedOnboardResumeIntent {
  const stored = readRawSession(options.sessionFile);
  const status = stored?.value.status;
  const effectiveResume = options.explicitResume || (!options.fresh && status === "in_progress");
  if (!effectiveResume) return { effectiveResume: false, snapshot: null };
  if (!stored) {
    throw new OnboardResumeIntentError("No resumable onboarding session was found.");
  }
  if (
    stored.value.resumable === false ||
    (stored.value.status !== "in_progress" && stored.value.status !== "failed")
  ) {
    throw new OnboardResumeIntentError("No resumable onboarding session was found.");
  }
  const inspected = inspectCheckpoint(stored.value.checkpoint);
  if (inspected.status === "legacy" || inspected.status === "none") {
    throw new OnboardResumeIntentError(
      "This onboarding checkpoint predates recorded runtime authority and cannot be resumed safely. Start a new onboarding attempt with the `--fresh` option.",
    );
  }
  if (inspected.status === "unsupported_future") {
    throw new OnboardResumeIntentError(
      `This onboarding checkpoint uses unsupported schema v${String(inspected.foundVersion)}. Upgrade the CLI or start a new onboarding attempt with the \`--fresh\` option.`,
    );
  }
  if (inspected.status !== "loaded") {
    throw new OnboardResumeIntentError(
      "The onboarding resume checkpoint is unreadable and cannot be safely continued.",
    );
  }
  const sessionId = typeof stored.value.sessionId === "string" ? stored.value.sessionId : "";
  const machine = isObjectRecord(stored.value.machine) ? stored.value.machine : null;
  const machineRevision = machine?.revision;
  if (
    sessionId === "" ||
    sessionId !== inspected.checkpoint.sessionId ||
    machine?.state !== inspected.checkpoint.machineState ||
    !Number.isSafeInteger(machineRevision) ||
    Number(machineRevision) < 0
  ) {
    throw new OnboardResumeIntentError(
      "The onboarding resume checkpoint is unreadable and cannot be safely continued.",
    );
  }
  const profile = inspected.checkpoint.profile.value;
  if (options.explicitProfile && options.explicitProfile !== profile) {
    throw new OnboardResumeIntentError(
      `The requested onboarding profile '${options.explicitProfile}' does not match checkpoint profile '${profile}'.`,
    );
  }
  return {
    effectiveResume: true,
    snapshot: {
      fingerprint: sessionFingerprint(stored.value),
      sessionId,
      checkpointUpdatedAt: inspected.checkpoint.updatedAt,
      machineRevision: Number(machineRevision),
      profile,
    },
  };
}

export function assertLockedResumeIntentSnapshot(
  expected: OnboardResumeIntentSnapshot,
  sessionFile: string,
): void {
  const stored = readRawSession(sessionFile);
  if (!stored || sessionFingerprint(stored.value) !== expected.fingerprint) {
    throw new OnboardResumeIntentRaceError();
  }
  const inspected = inspectCheckpoint(stored.value.checkpoint);
  const machine = isObjectRecord(stored.value.machine) ? stored.value.machine : null;
  if (
    inspected.status !== "loaded" ||
    inspected.checkpoint.sessionId !== expected.sessionId ||
    inspected.checkpoint.updatedAt !== expected.checkpointUpdatedAt ||
    inspected.checkpoint.profile.value !== expected.profile ||
    machine?.state !== inspected.checkpoint.machineState ||
    machine?.revision !== expected.machineRevision
  ) {
    throw new OnboardResumeIntentRaceError();
  }
}
