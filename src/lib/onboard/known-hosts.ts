// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
export function pruneKnownHostsEntries(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const hostField = trimmed.split(/\s+/)[0];
      return !hostField.split(",").some((host) => host.startsWith("openshell-"));
    })
    .join("\n");
}
