// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSandboxBrew } from "../../../lib/actions/sandbox/brew";
import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { brewCommandError, sandboxNameArg } from "../../../lib/sandbox/brew-command-support";

export default class BrewDeinitCommand extends NemoClawCommand {
  static id = "sandbox:brew:deinit";
  static strict = true;
  static summary = "Remove Homebrew from the sandbox";
  static description =
    "Remove the linuxbrew user and the Homebrew prefix from the sandbox.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox brew deinit alpha"];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> brew deinit",
      description: "Remove Homebrew from the sandbox",
      group: "Sandbox Management",
      scope: "sandbox",
      order: 28,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static args = {
    sandboxName: sandboxNameArg,
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(BrewDeinitCommand);
    try {
      await runSandboxBrew(args.sandboxName, { kind: "deinit" });
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
