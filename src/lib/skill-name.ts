// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The Agent Skills specification caps a skill name at 64 characters. */
export const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Validate that a skill name supplied on the CLI or in SKILL.md frontmatter is
 * safe to use as a remote path segment.
 * Rejects anything that isn't a valid skill name ([A-Za-z0-9._-], at most 64 characters).
 */
export function validateSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_SKILL_NAME_LENGTH &&
    name !== "." &&
    name !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}
