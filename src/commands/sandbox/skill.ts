// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";
import { installSandboxSkill } from "../../lib/actions/sandbox/skill-install";

export default class SkillCliCommand extends Command {
  static id = "sandbox:skill";
  static strict = false;
  static summary = "Show skill command usage";
  static description = "Show skill install/remove/list usage or report unknown skill subcommands.";
  static usage = ["<name> install <path>", "<name> remove <skill>", "<name> list"];
  static examples = [
    "<%= config.bin %> sandbox skill alpha install ./my-skill",
    "<%= config.bin %> sandbox skill alpha remove my-skill",
    "<%= config.bin %> sandbox skill alpha list --json",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...actionArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "") {
      console.error("Missing required sandboxName for skill.");
      process.exitCode = 2;
      return;
    }
    await installSandboxSkill(sandboxName, {
      command: actionArgs[0],
      path: actionArgs[1],
      extraArgs: actionArgs.slice(2),
    });
  }
}
