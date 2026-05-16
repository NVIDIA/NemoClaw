// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";
import { getSkillInstallRuntimeBridge } from "./skill/common";

export default class SkillCliCommand extends NemoClawCommand {
  static id = "sandbox:skill";
  static strict = false;
  static summary = "Show skill command usage";
  static description = "Show skill install usage or report unknown skill subcommands.";
  static usage = ["install <name> <path>"];
  static examples = ["<%= config.bin %> sandbox skill install alpha ./my-skill"];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...actionArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "") {
      this.failWithLines(["Missing required sandboxName for skill."], 2);
      return;
    }
    await getSkillInstallRuntimeBridge().sandboxSkillInstall(sandboxName, actionArgs);
  }
}
