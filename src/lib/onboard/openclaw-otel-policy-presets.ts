// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";
const LOCAL_OPENCLAW_OTEL_HOST = "host.openshell.internal";
const LOCAL_OPENCLAW_OTEL_PORT = "4318";

export const OPENCLAW_OTEL_LOCAL_POLICY_PRESET = "openclaw-diagnostics-otel-local";

export function isOpenclawOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NEMOCLAW_OPENCLAW_OTEL;
  return typeof raw === "string" && raw.trim() !== "" && !FALSE_VALUES.has(raw.trim().toLowerCase());
}

export function isOpenclawAgent(agent: string | null | undefined): boolean {
  const trimmed = typeof agent === "string" ? agent.trim() : "";
  return !trimmed || trimmed === "openclaw";
}

export function isOpenclawOtelEndpointLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
  const endpoint = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_OPENCLAW_OTEL_ENDPOINT;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`);
    return parsed.hostname === LOCAL_OPENCLAW_OTEL_HOST && (parsed.port || "80") === LOCAL_OPENCLAW_OTEL_PORT;
  } catch {
    return false;
  }
}

/** Presets that must be present whenever OpenClaw OTEL diagnostics are enabled. */
export function requiredOpenclawOtelPolicyPresets(
  agent: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isOpenclawAgent(agent) || !isOpenclawOtelEnabled(env)) return [];
  if (!isOpenclawOtelEndpointLocal(env)) return [];
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
