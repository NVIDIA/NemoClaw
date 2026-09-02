// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NAME_ALLOWED_FORMAT as CANONICAL_NAME_ALLOWED_FORMAT,
  NAME_MAX_LENGTH as CANONICAL_NAME_MAX_LENGTH,
  NAME_VALID_PATTERN as CANONICAL_NAME_VALID_PATTERN,
  PROVIDER_NAME_ALLOWED_FORMAT as CANONICAL_PROVIDER_NAME_ALLOWED_FORMAT,
  PROVIDER_NAME_MAX_LENGTH as CANONICAL_PROVIDER_NAME_MAX_LENGTH,
  PROVIDER_NAME_VALID_PATTERN as CANONICAL_PROVIDER_NAME_VALID_PATTERN,
  diagnosticPreview as canonicalDiagnosticPreview,
  isValidName as isCanonicalValidName,
  isValidProviderName as isCanonicalValidProviderName,
} from "../../nemoclaw/dist/shared/sandbox-name.cjs";

// sourceOfTruth: nemoclaw/src/shared/sandbox-name.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// module is compiled (mirrors src/lib/adapters/openshell/policy-boundary.ts). Keep the name grammar
// definition-free here so the CLI, the plugin, and CI share one rule and cannot
// drift.
export const NAME_MAX_LENGTH = CANONICAL_NAME_MAX_LENGTH;
export const NAME_ALLOWED_FORMAT = CANONICAL_NAME_ALLOWED_FORMAT;
export const NAME_VALID_PATTERN = CANONICAL_NAME_VALID_PATTERN;
export const PROVIDER_NAME_MAX_LENGTH = CANONICAL_PROVIDER_NAME_MAX_LENGTH;
export const PROVIDER_NAME_ALLOWED_FORMAT = CANONICAL_PROVIDER_NAME_ALLOWED_FORMAT;
export const PROVIDER_NAME_VALID_PATTERN = CANONICAL_PROVIDER_NAME_VALID_PATTERN;
export const diagnosticPreview = canonicalDiagnosticPreview;
export const isValidName = isCanonicalValidName;
export const isValidProviderName = isCanonicalValidProviderName;

function validationSubject(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "sandbox name") return "Sandbox names";
  if (normalized === "instance name") return "Instance names";
  if (normalized === "target sandbox name") return "Target sandbox names";
  return "Names";
}

// Derive a copy-paste-ready OpenShell-compatible label from arbitrary user input. Returns
// null when no recoverable slug exists (empty, all-symbol input) or when the
// input is already a valid name (no canonicalisation is performed against
// inputs the validator would accept). The transform mirrors what a user would
// do by hand: lowercase, replace illegal chars with `-`, collapse runs of `-`,
// trim terminal `-`, prefix a leading non-letter with `s-`, and truncate to
// the max length without leaving a dangling hyphen.
export function suggestNameSlug(value: string): string | null {
  if (typeof value !== "string") return null;
  if (value.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(value)) return null;
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  if (!slug) return null;
  if (!/^[a-z]/.test(slug)) {
    slug = `s-${slug}`;
  }
  if (slug.length > NAME_MAX_LENGTH) {
    slug = slug.slice(0, NAME_MAX_LENGTH);
  }
  slug = slug.replace(/[^a-z0-9]+$/g, "");
  if (!slug || !NAME_VALID_PATTERN.test(slug)) return null;
  if (slug === value) return null;
  return slug;
}

export function getNameValidationGuidance(
  label: string,
  value: string,
  opts: { includeAllowedFormat?: boolean } = {},
): string[] {
  const lines: string[] = [];
  if (/\s/.test(value)) {
    lines.push(`${validationSubject(label)} cannot contain spaces.`);
  }
  if (value.length > NAME_MAX_LENGTH) {
    lines.push(`${validationSubject(label)} must be ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  if (opts.includeAllowedFormat !== false) {
    lines.push(`Allowed format: ${NAME_ALLOWED_FORMAT}.`);
  }
  const suggestion = suggestNameSlug(value);
  if (suggestion) {
    lines.push(`Try: ${suggestion}`);
  }
  return lines;
}
