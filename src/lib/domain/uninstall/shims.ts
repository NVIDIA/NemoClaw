// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- covered by source-level unit tests; CLI coverage tracks dist integration. */
export const DEV_SHIM_MARKER = "# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh";

export type ShimKind =
  | "missing"
  | "managed-dev-shim"
  | "managed-symlink"
  | "managed-wrapper"
  | "preserve-foreign-file"
  | "unsupported-path-type";

export interface ShimInput {
  contents?: string;
  exists: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface ShimClassification {
  kind: ShimKind;
  remove: boolean;
  reason: string;
}

function stripCommandSubstitutionTrailingNewlines(contents: string): string {
  // Bash command substitution strips trailing newlines before the case pattern in uninstall.sh runs.
  return contents.replace(/\n+$/u, "");
}

export function isInstallerManagedWrapperContents(contents: string): boolean {
  const normalized = stripCommandSubstitutionTrailingNewlines(contents);
  const lines = normalized.split("\n");
  if (lines.length !== 3) return false;
  const [shebang, pathLine, execLine] = lines;
  return (
    shebang === "#!/usr/bin/env bash" &&
    pathLine.startsWith('export PATH="') &&
    pathLine.endsWith(':$PATH"') &&
    execLine.startsWith('exec "') &&
    execLine.endsWith('/nemoclaw" "$@"')
  );
}

export function isDevShimContents(contents: string): boolean {
  const normalized = stripCommandSubstitutionTrailingNewlines(contents);
  const lines = normalized.split("\n");
  if (lines.length !== 4) return false;
  const [shebang, marker, pathLine, execLine] = lines;
  return (
    shebang === "#!/usr/bin/env bash" &&
    marker === DEV_SHIM_MARKER &&
    pathLine.startsWith('export PATH="') &&
    pathLine.endsWith(':$PATH"') &&
    execLine.startsWith('exec "') &&
    execLine.endsWith('" "$@"')
  );
}

export function classifyNemoclawShim(input: ShimInput): ShimClassification {
  if (!input.exists) {
    return { kind: "missing", remove: false, reason: "shim path does not exist" };
  }

  if (input.isSymlink) {
    return { kind: "managed-symlink", remove: true, reason: "shim path is a symlink" };
  }

  if (!input.isFile) {
    return { kind: "unsupported-path-type", remove: false, reason: "shim path is not a regular file" };
  }

  const contents = input.contents ?? "";
  if (isInstallerManagedWrapperContents(contents)) {
    return { kind: "managed-wrapper", remove: true, reason: "installer-managed wrapper contents" };
  }

  if (isDevShimContents(contents)) {
    return { kind: "managed-dev-shim", remove: true, reason: "NemoClaw dev shim marker" };
  }

  return {
    kind: "preserve-foreign-file",
    remove: false,
    reason: "regular file is not an installer-managed shim",
  };
}
/* v8 ignore stop */
