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
