// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSandboxBrew } from "../../lib/actions/sandbox/brew";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { brewCommandError, sandboxNameArg } from "../../lib/sandbox/brew-command-support";

export default class BrewCommand extends NemoClawCommand {
  static id = "sandbox:brew";
  static strict = true;
  static summary = "Show brew usage";
  static description = "Show brew usage for init, deinit, install, and uninstall subcommands.";
  static usage = ["<init|deinit|install|uninstall> <name>"];
  static examples = [
    "<%= config.bin %> sandbox brew init alpha",
    "<%= config.bin %> sandbox brew install alpha hello jq",
    "<%= config.bin %> sandbox brew uninstall alpha hello",
    "<%= config.bin %> sandbox brew deinit alpha",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(BrewCommand);
    try {
      await runSandboxBrew(args.sandboxName, { kind: "help" });
    } catch (error) {
      const brewError = brewCommandError(error);
      if (brewError) {
        this.failWithLines(brewError.lines, brewError.exitCode);
        return;
      }
      throw error;
    }
  }
}
