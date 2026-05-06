// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { runUpgradeSandboxesAction } from "../../global-cli-actions";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

export default class UpgradeSandboxesCommand extends NemoClawCommand {
  static id = "upgrade-sandboxes";
  static strict = true;
  static summary = "Detect and rebuild stale sandboxes";
  static description = "Detect stale sandboxes and optionally rebuild them.";
  static usage = ["upgrade-sandboxes [--check] [--auto] [--yes|-y]"];
  static examples = [
    "<%= config.bin %> upgrade-sandboxes --check",
    "<%= config.bin %> upgrade-sandboxes --auto --yes",
  ];
  static flags = {
    check: Flags.boolean({ description: "Only check whether sandboxes need upgrading" }),
    auto: Flags.boolean({ description: "Automatically rebuild running stale sandboxes" }),
    yes: Flags.boolean({ char: "y", description: "Skip confirmation prompts" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(UpgradeSandboxesCommand);
    await runUpgradeSandboxesAction({
      auto: flags.auto === true,
      check: flags.check === true,
      yes: flags.yes === true,
    });
  }
}
