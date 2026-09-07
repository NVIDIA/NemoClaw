// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: These are the canonical blueprint sandbox and provider name
// grammars. Sandbox names use NemoClaw's OpenShell-compatible label subset;
// provider names mirror the existing NemoClaw provider contract. This module
// is compiled to generated .cjs/.d.cts files by build:cli before both the
// plugin and root CLI are built.
// consumers: The ESM plugin runner (nemoclaw/src/blueprint/runner.ts) and
// migration snapshot (nemoclaw/src/blueprint/snapshot.ts) import the generated
// .cjs directly; the root CLI re-exports the sandbox constants through
// src/lib/name-validation.ts (mirroring src/lib/adapters/openshell/policy-boundary.ts). Keeping one
// sandbox definition prevents the leading-char drift already observed between
// src/lib/name-validation.ts and the copies in mcp-bridge-validation.ts /
// smoke-macos-install.sh.
// sourceBoundary: A blueprint is untrusted input. These names flow into
// `openshell ... --name <value>` argv slots, and sandbox names flow onward to
// shell scripts and Kubernetes pod names, so callers must validate at the
// ingestion boundary and fail closed.
// regressionTest: nemoclaw/src/shared/sandbox-name.test.ts plus the plugin
// runner/snapshot tests and the root name-validation consumers.
// removalCondition: remove only when no NemoClaw consumer validates a sandbox
// or provider identifier, or both grammars are enforced by shared upstream
// contracts.

// OpenShell v0.0.99 routes sandbox and workspace identities through labels
// capped at 19 characters. Keep NemoClaw's canonical sandbox-name boundary at
// that upstream limit so invalid creates fail before any gateway mutation.
export const NAME_MAX_LENGTH = 19;
export const PROVIDER_NAME_MAX_LENGTH = 128;

// NemoClaw label: starts with a lowercase letter, then lowercase
// letters/digits/single internal hyphens, and ends with a letter or digit.
// OpenShell v0.0.99 reserves `--` as a routed-name segment delimiter.
export const NAME_VALID_PATTERN = /^(?!.*--)[a-z]([a-z0-9-]*[a-z0-9])?$/;
export const PROVIDER_NAME_VALID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

export const NAME_ALLOWED_FORMAT =
  `1-${NAME_MAX_LENGTH} characters, lowercase, starts with a letter, ` +
  "letters/numbers/single internal hyphens only, ends with letter/number";
export const PROVIDER_NAME_ALLOWED_FORMAT =
  `1-${PROVIDER_NAME_MAX_LENGTH} characters, starts with a letter, ` +
  "letters/numbers/dots/underscores/hyphens only";

const INVALID_NAME_PREVIEW_MAX_LENGTH = 80;

/**
 * Bound rejected input and render it as printable ASCII before it reaches a
 * terminal or CI log. Escaping every non-ASCII UTF-16 code unit also covers
 * C1 controls, line separators, bidi formatting, and unpaired surrogates.
 */
export function diagnosticPreview(value: unknown): string {
  const raw = String(value);
  const prefix = raw.slice(0, INVALID_NAME_PREVIEW_MAX_LENGTH);
  let escaped = '"';
  for (let index = 0; index < prefix.length; index += 1) {
    const codeUnit = prefix.charCodeAt(index);
    if (codeUnit === 0x22) {
      escaped += '\\"';
    } else if (codeUnit === 0x5c) {
      escaped += "\\\\";
    } else if (codeUnit >= 0x20 && codeUnit <= 0x7e) {
      escaped += prefix[index];
    } else {
      escaped += `\\u${codeUnit.toString(16).padStart(4, "0")}`;
    }
  }
  escaped += raw.length > INVALID_NAME_PREVIEW_MAX_LENGTH ? '..."' : '"';
  return escaped;
}

/**
 * True when `value` is a well-formed sandbox name under NemoClaw's
 * OpenShell-compatible label contract.
 */
export function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= NAME_MAX_LENGTH &&
    NAME_VALID_PATTERN.test(value)
  );
}

/** True when `value` follows the existing NemoClaw provider-name contract. */
export function isValidProviderName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROVIDER_NAME_MAX_LENGTH &&
    PROVIDER_NAME_VALID_PATTERN.test(value)
  );
}

/**
 * Return `value` when it is a valid sandbox name; otherwise throw. The error
 * message contains only a bounded, escaped ASCII preview of rejected input.
 */
export function assertValidName(value: unknown, label = "name"): string {
  if (isValidName(value)) {
    return value;
  }
  throw new Error(
    `Invalid ${label}: ${diagnosticPreview(value)}. Allowed format: ${NAME_ALLOWED_FORMAT}.`,
  );
}

/**
 * Return `value` when it is a valid provider name; otherwise throw with the
 * same terminal-safe diagnostic boundary used for sandbox names.
 */
export function assertValidProviderName(value: unknown, label = "provider name"): string {
  if (isValidProviderName(value)) {
    return value;
  }
  throw new Error(
    `Invalid ${label}: ${diagnosticPreview(value)}. Allowed format: ${PROVIDER_NAME_ALLOWED_FORMAT}.`,
  );
}
