// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical secret redaction patterns — single source of truth.
 *
 * Used by runner.ts (CLI output), debug.ts (diagnostic dumps), and
 * mirrored in debug.sh (shell diagnostics). If you add a pattern here,
 * also add it to scripts/debug.sh:redact() and update the consistency
 * test in test/secret-redaction.test.ts.
 *
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/1736
 */

/** Token-prefix patterns that match standalone (no context needed). */
export const TOKEN_PREFIX_PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{10,}/g,
  /nvcf-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9_-]{10,}/g,
  /(?:github_pat_)[A-Za-z0-9_]{30,}/g,
];

/** Context-anchored patterns (require a prefix like KEY=, Bearer, etc.). */
export const CONTEXT_PATTERNS: RegExp[] = [
  /(?<=Bearer\s+)[A-Za-z0-9_.+/=-]{10,}/gi,
  /(?<=(?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=: ]['"]?)[A-Za-z0-9_.+/=-]{10,}/gi,
];

/** All secret patterns combined. */
export const SECRET_PATTERNS: RegExp[] = [
  ...TOKEN_PREFIX_PATTERNS,
  ...CONTEXT_PATTERNS,
];

/**
 * Token prefixes that debug.sh must also handle.
 * Used by the consistency test to verify debug.sh stays in sync.
 */
export const EXPECTED_SHELL_PREFIXES = [
  "nvapi-",
  "nvcf-",
  "ghp_",
  "github_pat_",
];
