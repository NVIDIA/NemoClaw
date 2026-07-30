// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type Issue2478RecoveryProfile = "functional" | "soak";

export interface Issue2478RecoverySettings {
  profile: Issue2478RecoveryProfile;
  crashCycles: number;
  soakSeconds: number;
}

const PROFILE_DEFAULTS: Record<
  Issue2478RecoveryProfile,
  Pick<Issue2478RecoverySettings, "crashCycles" | "soakSeconds">
> = {
  functional: {
    crashCycles: 1,
    soakSeconds: 15,
  },
  soak: {
    crashCycles: 5,
    soakSeconds: 300,
  },
};

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveIssue2478RecoverySettings(
  env: NodeJS.ProcessEnv,
): Issue2478RecoverySettings {
  const rawProfile = env.NEMOCLAW_E2E_RECOVERY_PROFILE ?? "soak";
  if (rawProfile !== "functional" && rawProfile !== "soak") {
    throw new Error(
      `NEMOCLAW_E2E_RECOVERY_PROFILE must be 'functional' or 'soak', got '${rawProfile}'`,
    );
  }

  const defaults = PROFILE_DEFAULTS[rawProfile];
  return {
    profile: rawProfile,
    crashCycles: positiveInteger(env.NEMOCLAW_E2E_CRASH_CYCLES, defaults.crashCycles),
    soakSeconds: positiveInteger(env.NEMOCLAW_E2E_SOAK_SECONDS, defaults.soakSeconds),
  };
}
