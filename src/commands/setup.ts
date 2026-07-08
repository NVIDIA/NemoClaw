// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOnboardAction } from "../lib/actions/global";
import { CLI_NAME } from "../lib/cli/branding";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { buildOnboardFlags, type OnboardFlags } from "../lib/onboard/command-support";

export default class SetupCliCommand extends NemoClawCommand {
  static id = "setup";
  static strict = true;
  static summary = "Deprecated alias for onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup [flags]"];
  static examples = ["<%= config.bin %> setup --name alpha"];
  static state = "deprecated" as const;
  static deprecationOptions = {
    message: `Deprecated: '${CLI_NAME} setup' is now '${CLI_NAME} onboard'. See '${CLI_NAME} help'.`,
  };
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupCliCommand);
    await runOnboardAction(flags as OnboardFlags);
  }
}
