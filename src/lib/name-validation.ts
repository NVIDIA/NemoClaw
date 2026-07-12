// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NAME_MAX_LENGTH = 63;
export const NAME_ALLOWED_FORMAT =
  `1-${NAME_MAX_LENGTH} characters, lowercase, starts with a letter, ` +
  "letters/numbers/internal hyphens only, ends with letter/number";

export const NAME_VALID_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

function validationSubject(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "sandbox name") return "Sandbox names";
  if (normalized === "instance name") return "Instance names";
  if (normalized === "target sandbox name") return "Target sandbox names";
  return "Names";
}

// Derive a copy-paste-ready RFC 1123 label from arbitrary user input. Returns
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
