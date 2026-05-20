// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSandboxBrew } from "../../../lib/actions/sandbox/brew";
import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { brewCommandError, sandboxNameArg } from "../../../lib/sandbox/brew-command-support";

export default class BrewInitCommand extends NemoClawCommand {
  static id = "sandbox:brew:init";
  static strict = true;
  static summary = "Bootstrap Homebrew (Linuxbrew) inside the sandbox";
  static description =
    "Create the linuxbrew user inside the sandbox and run the canonical Linuxbrew installer.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox brew init alpha"];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> brew init",
      description: "Bootstrap Homebrew inside the sandbox",
      group: "Sandbox Management",
      scope: "sandbox",
      order: 25,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static args = {
    sandboxName: sandboxNameArg,
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(BrewInitCommand);
    try {
      await runSandboxBrew(args.sandboxName, { kind: "init" });
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
