// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Use the patch's reviewed preimage at the registration boundary. Surrounding
// plugin code and tool implementations are stubs; no peer is contacted.
export function reviewedPreimage(patch: string, file: string): string {
  const section = patch.split(`diff --git a/${file} b/${file}\n`)[1]?.split("diff --git ")[0];
  if (!section) throw new Error(`Missing patch target: ${file}`);
  const hunk = section.slice(section.indexOf("@@"));
  const header = /^@@ -(\d+),\d+ \+\d+,\d+ @@[^\n]*\n/u.exec(hunk);
  if (!header) throw new Error(`Missing patch hunk: ${file}`);
  const lines = hunk
    .slice(header[0].length)
    .trimEnd()
    .split("\n")
    .filter((line) => line === "" || line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1));
  return "# fixture context\n".repeat(Number(header[1]) - 1) + lines.join("\n") + "\n";
}
