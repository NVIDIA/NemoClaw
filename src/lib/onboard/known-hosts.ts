// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
function normalizeKnownHostToken(host: string): string {
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return host.replace(/:\d+$/, "");
}

export function pruneKnownHostsEntries(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const fields = trimmed.split(/\s+/);
      const hostField = fields[0]?.startsWith("@") ? (fields[1] ?? "") : fields[0];
      return !hostField
        .split(",")
        .map(normalizeKnownHostToken)
        .some((host) => host.startsWith("openshell-"));
    })
    .join("\n");
}
