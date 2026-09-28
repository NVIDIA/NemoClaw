// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEMVER_PATTERN = /(?:^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9.])/;

export function parseVersionFromText(value = "", versionCommand?: string): string | null {
  const text = String(value || "");
  const commandToken = versionCommand?.trim().split(/\s+/, 1)[0] ?? "";
  const executable = commandToken.split("/").pop() ?? "";
  if (executable) {
    const executablePattern = new RegExp(`\\b${escapeRegExp(executable)}\\b`, "i");
    let executableSeen = false;
    for (const line of text.split(/\r?\n/)) {
      const executableMatch = executablePattern.exec(line);
      if (!executableMatch) continue;
      executableSeen = true;
      const versionMatch = line
        .slice(executableMatch.index + executableMatch[0].length)
        .match(SEMVER_PATTERN);
      if (versionMatch) return versionMatch[1];
    }
    if (executableSeen) return null;
  }

  const match = text.match(SEMVER_PATTERN);
  return match ? match[1] : null;
}
