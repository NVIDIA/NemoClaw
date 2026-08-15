// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { runUpdateAction } from "../lib/actions/update";
import { CLI_DISPLAY_NAME } from "../lib/cli/branding";
import { yesFlag } from "../lib/cli/common-flags";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { getVersion } from "../lib/core/version";
import { prompt } from "../lib/credentials/store";

export default class UpdateCommand extends NemoClawCommand {
  static id = "update";
  static strict = true;
  static summary = `Run the maintained ${CLI_DISPLAY_NAME} installer update flow`;
  static description =
    `Check for a ${CLI_DISPLAY_NAME} CLI update and run the maintained installer flow.`;
  static usage = ["update [--check] [--fresh] [--allow-downgrade] [--yes|-y]"];
  static examples = [
    "<%= config.bin %> update --check",
    "<%= config.bin %> update",
    "<%= config.bin %> update --fresh",
    "<%= config.bin %> update --fresh --allow-downgrade",
    "<%= config.bin %> update --yes",
  ];
  static flags = {
    "allow-downgrade": Flags.boolean({
      description:
        "Allow --fresh to reinstall the maintained build even when it is older than, or cannot be ordered against, the installed version (--yes alone does not accept a downgrade)",
    }),
    check: Flags.boolean({
      description: "Check update availability without running the installer",
    }),
    fresh: Flags.boolean({
      description:
        "Reinstall the maintained build for a clean re-clone (useful to repair a broken install); refuses when the maintained build is older than the installed version",
    }),
    yes: yesFlag(),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(UpdateCommand);
    const result = await runUpdateAction(
      {
        allowDowngrade: flags["allow-downgrade"] === true,
        check: flags.check === true,
        fresh: flags.fresh === true,
        yes: flags.yes === true,
      },
      {
        currentVersion: () => getVersion({ rootDir: this.config.root }),
        env: process.env,
        error: console.error,
        log: console.log,
        prompt,
        rootDir: this.config.root,
      },
    );
    this.applyExitResult(result);
  }
}
