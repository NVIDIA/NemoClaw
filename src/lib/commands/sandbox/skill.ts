// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { getSkillInstallRuntimeBridge } from "./skill/common";

export default class SkillCliCommand extends Command {
  static id = "sandbox:skill";
  static strict = false;
  static summary = "Show skill command usage";
  static description = "Show skill install usage or report unknown skill subcommands.";
  static usage = ["install <name> <path>"];
  static examples = ["<%= config.bin %> sandbox skill install alpha ./my-skill"];

  public async run(): Promise<void> {
    const [sandboxName, ...actionArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "") {
      this.error("Missing required sandboxName for skill.", { exit: 2 });
    }
    await getSkillInstallRuntimeBridge().sandboxSkillInstall(sandboxName, actionArgs);
  }
}
