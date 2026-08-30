// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PolicyPresetState = "active" | "inactive" | "drift" | "unverified" | "missing";

const PRESET_NAME_SOURCE = String.raw`[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?`;
const PRESET_NAME_PATTERN = new RegExp(String.raw`^${PRESET_NAME_SOURCE}$`, "u");
const PROVENANCE_PATTERN = String.raw`(?:user-added|source unverified(?: \(gateway unreachable\))?|from [a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])? (?:tier|agent))`;
const ACTIVE_DRIFT_SUFFIX = " (active on gateway, missing from local state)";
const INACTIVE_DRIFT_SUFFIX = " (recorded locally, not active on gateway)";
const POLICY_LIST_HEADER_PATTERN = /^[\t ]*Policy presets for sandbox '[^'\r\n]+':[\t ]*$/u;
const POLICY_LIST_ROW_PREFIX_PATTERN = /^[\t ]*[●○]/u;
const POLICY_LIST_ROW_PATTERN = new RegExp(
  String.raw`^[\t ]*[●○][\t ]+(${PRESET_NAME_SOURCE})(?:[\t ]+\[${PROVENANCE_PATTERN}\])?[\t ]+—[\t ]+[^\r\n]*$`,
  "u",
);

/**
 * Parse one exact preset row from the human-readable `policy-list` output.
 *
 * Keep the accepted grammar bounded to the CLI's current row contract. This
 * avoids treating a preset name found in a description, a prefix collision,
 * or an unrecognized provenance tag as proof of the requested preset's state.
 */
export function parsePolicyPresetState(output: string, presetName: string): PolicyPresetState {
  if (
    output.includes("Could not query gateway") ||
    output.includes("Could not query OpenShell") ||
    output.includes("cannot be verified or started")
  ) {
    return "unverified";
  }
  if (!PRESET_NAME_PATTERN.test(presetName)) return "missing";

  const rowPattern = new RegExp(
    String.raw`^[\t ]*([●○])[\t ]+${presetName}(?:[\t ]+\[(${PROVENANCE_PATTERN})\])?[\t ]+—[\t ]+([^\r\n]*)$`,
    "u",
  );
  const matches = output
    .split(/\r?\n/)
    .map((line) => rowPattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);

  // A normal policy listing has exactly one row per preset. Ambiguity is not
  // positive evidence, so duplicates and malformed rows fail closed.
  if (matches.length !== 1) return "missing";

  const [, marker, provenance, details] = matches[0];
  if (provenance === "source unverified (gateway unreachable)") return "unverified";
  if (details.endsWith(ACTIVE_DRIFT_SUFFIX)) {
    return marker === "●" && provenance === "source unverified" ? "drift" : "missing";
  }
  if (details.endsWith(INACTIVE_DRIFT_SUFFIX)) {
    return marker === "○" && provenance === undefined ? "drift" : "missing";
  }
  if (marker === "●" && provenance === undefined) return "missing";
  if (provenance === "source unverified" || (marker === "○" && provenance !== undefined)) {
    return "missing";
  }
  return marker === "●" ? "active" : "inactive";
}

/**
 * Return active presets only when the complete human-readable listing matches
 * the verified row contract. Malformed, duplicate, drifted, or
 * gateway-unverified listings return `null` instead of becoming evidence.
 */
export function parseVerifiedActivePolicyPresets(
  output: string,
  expectedPresetNames: readonly string[],
): string[] | null {
  const expected = new Set(expectedPresetNames);
  if (
    expected.size === 0 ||
    expected.size !== expectedPresetNames.length ||
    expectedPresetNames.some((name) => !PRESET_NAME_PATTERN.test(name))
  ) {
    return null;
  }

  const lines = output.split(/\r?\n/);
  if (lines.filter((line) => POLICY_LIST_HEADER_PATTERN.test(line)).length !== 1) {
    return null;
  }

  const rowLines = lines.filter((line) => POLICY_LIST_ROW_PREFIX_PATTERN.test(line));
  if (rowLines.length === 0) return null;

  const presetNames: string[] = [];
  for (const line of rowLines) {
    const match = POLICY_LIST_ROW_PATTERN.exec(line);
    if (!match) return null;
    presetNames.push(match[1]);
  }
  if (
    presetNames.length !== expected.size ||
    new Set(presetNames).size !== expected.size ||
    presetNames.some((name) => !expected.has(name))
  ) {
    return null;
  }

  const activePresets: string[] = [];
  for (const presetName of presetNames) {
    const state = parsePolicyPresetState(output, presetName);
    if (state !== "active" && state !== "inactive") return null;
    if (state === "active") activePresets.push(presetName);
  }
  return activePresets;
}
