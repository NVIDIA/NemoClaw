// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
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
    "Pass through to the selected sandbox agent's native skill list command. Native output and filter flags are forwarded verbatim.";
  static usage = ["<name> [agent-skill-list-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox skill list alpha",
    "<%= config.bin %> sandbox skill list alpha --json",
    "<%= config.bin %> sandbox skill list alpha --eligible --verbose",
  ];
  static flags = {
    json: Flags.boolean({ description: "Forward JSON output mode when the agent supports it" }),
    eligible: Flags.boolean({ description: "Forward the OpenClaw eligible-only filter" }),
    verbose: Flags.boolean({ char: "v", description: "Forward verbose OpenClaw output" }),
    "enabled-only": Flags.boolean({ description: "Forward the Hermes enabled-only filter" }),
    project: Flags.boolean({ description: "Forward the DCode project-only filter" }),
    source: Flags.string({ description: "Forward the Hermes source filter" }),
  };

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
