// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { removeSandboxSkill } from "../../../lib/actions/sandbox/skill-install";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SkillRemoveCliCommand extends NemoClawCommand {
  static id = "sandbox:skill:remove";
  static strict = true;
  static summary = "Remove an installed skill from the sandbox";
  static description = "Remove an installed SKILL.md agent skill from a running sandbox.";
  static usage = ["<name> <skill>"];
  static examples = ["<%= config.bin %> sandbox skill remove alpha my-skill"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
    skillName: Args.string({
      name: "skill",
      description: "Skill name from SKILL.md frontmatter",
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SkillRemoveCliCommand);
    await removeSandboxSkill(args.sandboxName, {
      command: "remove",
      name: args.skillName,
    });
  }
}
