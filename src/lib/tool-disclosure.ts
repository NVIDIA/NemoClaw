// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Agent-neutral model-visible tool catalog policy. */
export type ToolDisclosure = "progressive" | "direct";

export const DEFAULT_TOOL_DISCLOSURE: ToolDisclosure = "progressive";
export const TOOL_DISCLOSURE_ENV = "NEMOCLAW_TOOL_DISCLOSURE";
export const TOOL_DISCLOSURE_VALUES = ["progressive", "direct"] as const;

/** Normalize a user or persisted value without silently accepting unknown modes. */
export function normalizeToolDisclosure(value: unknown): ToolDisclosure | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "progressive" || normalized === "direct" ? normalized : null;
}

/** Read the build-time environment contract with the shared closed-enum policy. */
export function readToolDisclosureEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ToolDisclosure {
  const raw = env[TOOL_DISCLOSURE_ENV] || DEFAULT_TOOL_DISCLOSURE;
  const normalized = normalizeToolDisclosure(raw);
  if (!normalized) {
    throw new Error(`${TOOL_DISCLOSURE_ENV} must be progressive or direct`);
  }
  return normalized;
}

/** Resolve an explicit CLI/env request. Blank values are treated as unset. */
export function resolveToolDisclosureRequest(
  cliValue: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ToolDisclosure | null {
  const rawCli = typeof cliValue === "string" ? cliValue.trim() : "";
  const rawEnv =
    typeof env[TOOL_DISCLOSURE_ENV] === "string" ? env[TOOL_DISCLOSURE_ENV]!.trim() : "";
  const raw = rawCli || rawEnv;
  if (!raw) return null;
  const normalized = normalizeToolDisclosure(raw);
  if (!normalized) {
    throw new Error(
      `${TOOL_DISCLOSURE_ENV} / --tool-disclosure must be one of: ${TOOL_DISCLOSURE_VALUES.join(
        ", ",
      )}.`,
    );
  }
  return normalized;
}

/** Missing state predates this setting and adopts the new progressive default. */
export function toolDisclosureOrDefault(value: unknown): ToolDisclosure {
  return normalizeToolDisclosure(value) ?? DEFAULT_TOOL_DISCLOSURE;
}

export function invalidRecordedToolDisclosure(value: unknown): boolean {
  return value !== undefined && value !== null && normalizeToolDisclosure(value) === null;
}

export function resolveSandboxToolDisclosure(input: {
  requested: ToolDisclosure | null;
  recorded: unknown;
  session: unknown;
  sandboxExists: boolean;
  recreate: boolean;
}): ToolDisclosure {
  if (invalidRecordedToolDisclosure(input.recorded)) {
    throw new Error("recorded toolDisclosure value is invalid");
  }
  const recorded = normalizeToolDisclosure(input.recorded);
  const session = normalizeToolDisclosure(input.session);

  // Reusing a live sandbox must keep the behavior already baked into it.
  if (input.sandboxExists && !input.recreate) {
    if (recorded) {
      if (input.requested && input.requested !== recorded) {
        throw new Error(
          `sandbox records tool disclosure '${recorded}', but '${input.requested}' was requested; recreate the sandbox to change it`,
        );
      }
      return recorded;
    }
    // Missing durable state marks a legacy sandbox that the caller will
    // recreate. Preserve an explicit requested mode for that migration.
    return input.requested ?? session ?? DEFAULT_TOOL_DISCLOSURE;
  }

  // A deliberate recreation may override recorded state. With no explicit
  // request, preserve the sandbox's durable choice; interrupted creation falls
  // back to its session before adopting the new default.
  return input.requested ?? recorded ?? session ?? DEFAULT_TOOL_DISCLOSURE;
}
