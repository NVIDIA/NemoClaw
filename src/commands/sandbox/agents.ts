// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printAgentsParentHelp } from "../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsCommand extends NemoClawCommand {
  static id = "sandbox:agents";
  static strict = false;
  static summary = "Manage OpenClaw agents inside a sandbox";
  static description =
    "Parent for the `agents` subcommand group (`add`, `delete`, `list`). The parent has no runnable default — invoking `nemoclaw <name> agents` with no subcommand or with flags only renders this help screen instead of dispatching a fabricated `sandbox:agents:--<flag>` command id.";
  static usage = ["<name> <subcommand> [openclaw-agents-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents alpha --help",
    "<%= config.bin %> sandbox agents list alpha --json",
    "<%= config.bin %> sandbox agents add alpha work --model gpt-4o",
    "<%= config.bin %> sandbox agents delete alpha work --force --json",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    printAgentsParentHelp();
  }
}
