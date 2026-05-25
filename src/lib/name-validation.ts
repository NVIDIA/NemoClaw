// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NAME_MAX_LENGTH = 63;
export const NAME_ALLOWED_FORMAT =
  `1-${NAME_MAX_LENGTH} characters, lowercase, starts with a letter, ` +
  "letters/numbers/internal hyphens only, ends with letter/number";

function validationSubject(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "sandbox name") return "Sandbox names";
  if (normalized === "instance name") return "Instance names";
  if (normalized === "target sandbox name") return "Target sandbox names";
  return "Names";
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
  return lines;
}
