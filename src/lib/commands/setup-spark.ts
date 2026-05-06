// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { runSetupSparkAction } from "../global-cli-actions";
import { buildOnboardFlags, type OnboardFlags, toLegacyOnboardArgs } from "./onboard/common";

export default class SetupSparkCliCommand extends Command {
  static id = "setup-spark";
  static strict = true;
  static summary = "Deprecated alias for nemoclaw onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup-spark [flags]"];
  static examples = ["<%= config.bin %> setup-spark --name alpha"];
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    if (this.argv.includes("--help") || this.argv.includes("-h")) {
      await runSetupSparkAction(["--help"]);
      return;
    }
    const { flags } = await this.parse(SetupSparkCliCommand);
    await runSetupSparkAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
