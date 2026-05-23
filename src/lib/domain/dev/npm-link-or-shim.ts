// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DEV_SHIM_MARKER = "# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh";

export type ShimClassification = "absent" | "managed" | "foreign";

export function classifyDevShim(contents: string | null): ShimClassification {
  if (contents === null) return "absent";
  return contents.split(/\r?\n/).includes(DEV_SHIM_MARKER) ? "managed" : "foreign";
}

export function buildDevShimContents(options: { binPath: string; nodeDir: string }): string {
  return [
    "#!/usr/bin/env bash",
    DEV_SHIM_MARKER,
    `export PATH="${options.nodeDir}:$PATH"`,
    `exec "${options.binPath}" "$@"`,
    "",
  ].join("\n");
}

export function pathContainsDirectory(pathValue: string | undefined, directory: string): boolean {
  return (pathValue ?? "").split(":").includes(directory);
}
