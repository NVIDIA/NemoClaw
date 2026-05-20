// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { runSandboxBrew } from "../../../lib/actions/sandbox/brew";
import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { brewCommandError } from "../../../lib/sandbox/brew-command-support";

export default class BrewInstallCommand extends NemoClawCommand {
  static id = "sandbox:brew:install";
  static strict = false;
  static summary = "Install one or more Homebrew formulae";
  static description =
    "Install one or more Homebrew formulae into the sandbox via the linuxbrew user. Pair --yes with NEMOCLAW_NON_INTERACTIVE=1 to auto-run `brew init` when Homebrew is not yet bootstrapped.";
  static usage = ["<name> <formula>... [--yes|-y]"];
  static examples = [
    "<%= config.bin %> sandbox brew install alpha hello",
    "<%= config.bin %> sandbox brew install alpha jq curl",
    "NEMOCLAW_NON_INTERACTIVE=1 <%= config.bin %> sandbox brew install alpha hello --yes",
  ];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> brew install",
      description: "Install one or more Homebrew formulae",
      flags: "<formula>... [--yes|-y]",
      group: "Sandbox Management",
      scope: "sandbox",
      order: 26,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];
  static flags = {
    yes: Flags.boolean({
      char: "y",
      description:
        "When set together with NEMOCLAW_NON_INTERACTIVE=1, auto-run `brew init` first if Homebrew is not yet installed in the sandbox.",
    }),
  };

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(BrewInstallCommand);
    const [sandboxName, ...packages] = argv as string[];
    if (!sandboxName || sandboxName.trim() === "") {
      this.failWithLines(["Missing required sandboxName for brew install."], 2);
      return;
    }
    if (packages.length === 0) {
      this.failWithLines(["Specify at least one formula to install."], 2);
      return;
    }
    try {
      await runSandboxBrew(sandboxName, { kind: "install", packages, yes: flags.yes });
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
