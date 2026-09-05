// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateSkillName } from "./skill-name";

describe("validateSkillName", () => {
  it.each(["my-skill", "my_skill", "my.skill", "MySkill123", "digicon-zeiss-ai-strategy"])(
    "accepts %s",
    (name) => expect(validateSkillName(name)).toBe(true),
  );

  it.each([
    "",
    "my skill",
    "my;skill",
    "my$skill",
    "my/skill",
    "../escape",
    "my`skill`",
    ".",
    "..",
  ])("rejects %s", (name) => expect(validateSkillName(name)).toBe(false));
});
