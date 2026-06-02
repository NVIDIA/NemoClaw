// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export const OPENCLAW_OTEL_LOCAL_POLICY_PRESET = "openclaw-diagnostics-otel-local";

export function isOpenclawOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NEMOCLAW_OPENCLAW_OTEL;
  return typeof raw === "string" && raw.trim() !== "" && !FALSE_VALUES.has(raw.trim().toLowerCase());
}

export function isOpenclawAgent(agent: string | null | undefined): boolean {
  const trimmed = typeof agent === "string" ? agent.trim() : "";
  return !trimmed || trimmed === "openclaw";
}

/** Presets that must be present whenever OpenClaw OTEL diagnostics are enabled. */
export function requiredOpenclawOtelPolicyPresets(
  agent: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isOpenclawAgent(agent) || !isOpenclawOtelEnabled(env)) return [];
  return [OPENCLAW_OTEL_LOCAL_POLICY_PRESET];
}

export function mergeRequiredOpenclawOtelPolicyPresets(
  selectedPresets: string[],
  options: {
    agent?: string | null;
    knownPresetNames?: Iterable<string> | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  const merged = [...selectedPresets];
  const selected = new Set(merged);
  const known = options.knownPresetNames ? new Set(options.knownPresetNames) : null;
  const env = options.env ?? process.env;

  for (const preset of requiredOpenclawOtelPolicyPresets(options.agent, env)) {
    if (known && !known.has(preset)) continue;
    if (selected.has(preset)) continue;
    merged.push(preset);
    selected.add(preset);
  }

  return merged;
}
