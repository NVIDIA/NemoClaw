// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The Agent Skills specification caps a skill name at 64 characters. */
export const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Validate that a skill name supplied on the CLI or in SKILL.md frontmatter is
 * safe to use as a remote path segment.
 * Names over 64 characters are accepted only for removal of legacy skills.
 */
export function validateSkillName(
  name: string,
  options: { allowLegacyLength?: boolean } = {},
): boolean {
  return (
    name.length > 0 &&
    (options.allowLegacyLength === true || name.length <= MAX_SKILL_NAME_LENGTH) &&
    name !== "." &&
    name !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}
