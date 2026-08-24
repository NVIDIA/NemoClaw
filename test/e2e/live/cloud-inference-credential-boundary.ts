// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { HIGH_CONFIDENCE_PREFIXED_TOKEN_ERE } from "../../../nemoclaw/src/security/secret-scanner.ts";

const DEFAULT_SANDBOX_STATE_DIRECTORIES = ["/sandbox/.openclaw", "/sandbox/.nemoclaw"];

/** Build a path-only scan for concrete credential values in sandbox state. */
export function buildSandboxCredentialScanCommand(
  directories: readonly string[] = DEFAULT_SANDBOX_STATE_DIRECTORIES,
): string {
  const roots = directories.map((directory) => shellQuote(directory)).join(" ");
  return [
    `for dir in ${roots}; do`,
    '  [ -d "$dir" ] || continue',
    `  matches=$(grep -rlE '${HIGH_CONFIDENCE_PREFIXED_TOKEN_ERE}' "$dir")`,
    "  scan_status=$?",
    '  case "$scan_status" in',
    `    0) printf '%s\\n' "$matches" | grep -Ev '/policies/|/plugin-runtime-deps/|/extensions/[^/]+/(dist|node_modules)/'`,
    "       filter_status=$?",
    '       case "$filter_status" in',
    "         0|1) ;;",
    '         *) exit "$filter_status" ;;',
    "       esac",
    "       ;;",
    "    1) ;;",
    '    *) exit "$scan_status" ;;',
    "  esac",
    "done",
  ].join("\n");
}
