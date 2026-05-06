// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { runSetupAction } from "../global-cli-actions";
import { buildOnboardFlags, type OnboardFlags, toLegacyOnboardArgs } from "./onboard/common";

export default class SetupCliCommand extends Command {
  static id = "setup";
  static strict = true;
  static summary = "Deprecated alias for nemoclaw onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup [flags]"];
  static examples = ["<%= config.bin %> setup --name alpha"];
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    if (this.argv.includes("--help") || this.argv.includes("-h")) {
      await runSetupAction(["--help"]);
      return;
    }
    const { flags } = await this.parse(SetupCliCommand);
    await runSetupAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
