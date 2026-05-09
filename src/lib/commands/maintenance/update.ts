// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { runUpdateAction } from "../../actions/update";
import { CLI_DISPLAY_NAME } from "../../cli/branding";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";
import { getVersion } from "../../core/version";
import { prompt } from "../../credentials/store";

export default class UpdateCommand extends NemoClawCommand {
  static id = "update";
  static strict = true;
  static summary = `Run the maintained ${CLI_DISPLAY_NAME} installer update flow`;
  static description = `Check for a ${CLI_DISPLAY_NAME} CLI update and run the maintained installer flow.`;
  static usage = ["update [--check] [--yes|-y]"];
  static examples = [
    "<%= config.bin %> update --check",
    "<%= config.bin %> update",
    "<%= config.bin %> update --yes",
  ];
  static flags = {
    check: Flags.boolean({ description: "Check update availability without running the installer" }),
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(UpdateCommand);
    const result = await runUpdateAction(
      {
        check: flags.check === true,
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
    if (result.status !== 0) {
      this.exit(result.status);
    }
  }
}
