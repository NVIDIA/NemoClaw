// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listSandboxSkills,
  printSkillInstallUsage,
} from "../../../lib/actions/sandbox/skill-install";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SkillListCliCommand extends NemoClawCommand {
  static id = "sandbox:skill:list";
  static customHelp = true;
  static strict = false;
  static summary = "List skills from the agent's native state";
  static description =
    "Pass through to the selected sandbox agent's native skill list command. Supported output and filter flags are forwarded; lifecycle-bound agent overrides are refused.";
  static usage = ["<name> [agent-skill-list-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox skill list alpha",
    "<%= config.bin %> sandbox skill list alpha --json",
    "<%= config.bin %> sandbox skill list alpha --eligible --verbose",
  ];
  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (
      !sandboxName ||
      sandboxName.trim() === "" ||
      sandboxName === "--help" ||
      sandboxName === "-h" ||
      extraArgs.includes("--help") ||
      extraArgs.includes("-h")
    ) {
      printSkillInstallUsage();
      return;
    }
    await listSandboxSkills(sandboxName, { extraArgs });
  }
}
