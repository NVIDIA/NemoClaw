// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function normalizeReasoningFlag(value: string | null | undefined): "true" | "false" | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y") {
    return "true";
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "n") {
    return "false";
  }
  return null;
}

/**
 * Describe an explicit `NEMOCLAW_REASONING` that a resume is about to ignore.
 * Returns null when nothing is being ignored.
 *
 * Resume replays the recorded selection, so the stored flag wins over ambient
 * env by design. Without a message the mismatch is a silent no-op: the reporter
 * in #7462 exported `NEMOCLAW_REASONING=true`, re-ran onboarding three ways,
 * and every run kept the recorded `false` with no output naming the recorded
 * value or the command that re-reads the variable.
 */
export function describeIgnoredReasoningEnv(
  storedValue: string | null | undefined,
  cliName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const stored = normalizeReasoningFlag(storedValue);
  if (!stored) return null;
  const requested = normalizeReasoningFlag(env.NEMOCLAW_REASONING);
  if (!requested || requested === stored) return null;
  return (
    `  Ignoring NEMOCLAW_REASONING=${requested} — this sandbox is recorded as reasoning=${stored}. ` +
    `Recreate it to change the recorded value: ${cliName} onboard --fresh --name <sandbox> --recreate-sandbox`
  );
}

export async function configureCompatibleEndpointReasoning(
  storedValue?: string | null,
): Promise<"true" | "false"> {
  const configured = normalizeReasoningFlag(storedValue ?? process.env.NEMOCLAW_REASONING);
  process.env.NEMOCLAW_REASONING = configured ?? "false";
  return process.env.NEMOCLAW_REASONING as "true" | "false";
}

export function clearCompatibleEndpointReasoning(): null {
  delete process.env.NEMOCLAW_REASONING;
  return null;
}

export type ReasoningEffort = "low" | "medium" | "high";

export const REASONING_EFFORT_ENV = "NEMOCLAW_REASONING_EFFORT";
export const REASONING_EFFORT_DEFAULT = "default";
export const REASONING_EFFORT_VALUES = ["low", "medium", "high", REASONING_EFFORT_DEFAULT] as const;

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : null;
}

export interface ReasoningEffortRequest {
  effort: ReasoningEffort | null;
  explicit: boolean;
}

export function resolveReasoningEffortRequest(
  cliValue: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ReasoningEffortRequest {
  const rawCli = typeof cliValue === "string" ? cliValue.trim() : "";
  const rawEnvValue = env[REASONING_EFFORT_ENV];
  const rawEnv = typeof rawEnvValue === "string" ? rawEnvValue.trim() : "";
  const raw = rawCli || rawEnv;
  if (!raw) return { effort: null, explicit: false };
  if (raw.toLowerCase() === REASONING_EFFORT_DEFAULT) {
    return { effort: null, explicit: true };
  }
  const normalized = normalizeReasoningEffort(raw);
  if (!normalized) {
    throw new Error(
      `${REASONING_EFFORT_ENV} / --reasoning-effort must be one of: ${REASONING_EFFORT_VALUES.join(
        ", ",
      )}.`,
    );
  }
  return { effort: normalized, explicit: true };
}

export function describeIgnoredReasoningEffortEnv(
  storedValue: unknown,
  cliName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const stored = normalizeReasoningEffort(storedValue);
  const requested = resolveReasoningEffortRequest(null, env);
  if (!requested.explicit) return null;
  if ((requested.effort ?? null) === (stored ?? null)) return null;
  const requestedLabel = requested.effort ?? REASONING_EFFORT_DEFAULT;
  const storedLabel = stored ?? REASONING_EFFORT_DEFAULT;
  return (
    `  Ignoring ${REASONING_EFFORT_ENV}=${requestedLabel} — this sandbox is recorded as ` +
    `reasoning effort=${storedLabel}. Recreate it to change the recorded value: ` +
    `${cliName} onboard --fresh --name <sandbox> --recreate-sandbox`
  );
}

export async function configureCompatibleEndpointReasoningEffort(
  storedValue?: unknown,
  env: NodeJS.ProcessEnv = process.env,
  allowRequestFallback = true,
): Promise<ReasoningEffort | null> {
  const configured =
    normalizeReasoningEffort(storedValue) ??
    (allowRequestFallback ? resolveReasoningEffortRequest(null, env).effort : null);
  if (configured) {
    env[REASONING_EFFORT_ENV] = configured;
  } else {
    delete env[REASONING_EFFORT_ENV];
  }
  return configured;
}

export function clearCompatibleEndpointReasoningEffort(): null {
  delete process.env[REASONING_EFFORT_ENV];
  return null;
}

export function applyReasoningEffortEnv(value: unknown): void {
  const normalized = normalizeReasoningEffort(value);
  if (normalized) {
    process.env[REASONING_EFFORT_ENV] = normalized;
  } else {
    delete process.env[REASONING_EFFORT_ENV];
  }
}

export const compatibleEndpointReasoningConfigureDeps = {
  configureCompatibleEndpointReasoning,
  configureCompatibleEndpointReasoningEffort,
} as const;

export const compatibleEndpointReasoningClearDeps = {
  clearCompatibleEndpointReasoning,
  clearCompatibleEndpointReasoningEffort,
} as const;

interface CompatibleEndpointReasoningSessionState {
  readonly compatibleEndpointReasoning?: string | null;
  readonly compatibleEndpointReasoningEffort?: ReasoningEffort | null;
}

export function getCompatibleEndpointReasoningSessionState(
  session: CompatibleEndpointReasoningSessionState | null | undefined,
): {
  compatibleEndpointReasoning: string | null;
  compatibleEndpointReasoningEffort: ReasoningEffort | null;
} {
  return {
    compatibleEndpointReasoning: session?.compatibleEndpointReasoning || null,
    compatibleEndpointReasoningEffort: session?.compatibleEndpointReasoningEffort || null,
  };
}
