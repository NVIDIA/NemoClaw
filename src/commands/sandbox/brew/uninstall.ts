// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSandboxBrew } from "../../../lib/actions/sandbox/brew";
import type { PublicCommandDisplayEntry } from "../../../lib/cli/command-display";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { brewCommandError } from "../../../lib/sandbox/brew-command-support";

export default class BrewUninstallCommand extends NemoClawCommand {
  static id = "sandbox:brew:uninstall";
  static strict = false;
  static summary = "Uninstall one or more Homebrew formulae";
  static description =
    "Uninstall one or more Homebrew formulae from the sandbox via the linuxbrew user.";
  static usage = ["<name> <formula>..."];
  static examples = [
    "<%= config.bin %> sandbox brew uninstall alpha hello",
    "<%= config.bin %> sandbox brew uninstall alpha jq curl",
  ];
  static publicDisplay = [
    {
      usage: "nemoclaw <name> brew uninstall",
      description: "Uninstall one or more Homebrew formulae",
      flags: "<formula>...",
      group: "Sandbox Management",
      scope: "sandbox",
      order: 27,
    },
  ] satisfies readonly PublicCommandDisplayEntry[];

  public async run(): Promise<void> {
    const { argv } = await this.parse(BrewUninstallCommand);
    const [sandboxName, ...packages] = argv as string[];
    if (!sandboxName || sandboxName.trim() === "") {
      this.failWithLines(["Missing required sandboxName for brew uninstall."], 2);
      return;
    }
    if (packages.length === 0) {
      this.failWithLines(["Specify at least one formula to uninstall."], 2);
      return;
    }
    try {
      await runSandboxBrew(sandboxName, { kind: "uninstall", packages });
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
