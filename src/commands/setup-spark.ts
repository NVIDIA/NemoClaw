// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOnboardAction } from "../lib/actions/global";
import { CLI_NAME } from "../lib/cli/branding";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { buildOnboardFlags, type OnboardFlags } from "../lib/onboard/command-support";

export default class SetupSparkCliCommand extends NemoClawCommand {
  static id = "setup-spark";
  static strict = true;
  static summary = "Deprecated alias for onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup-spark [flags]"];
  static examples = ["<%= config.bin %> setup-spark --name alpha"];
  static state = "deprecated" as const;
  static deprecationOptions = {
    message: `Deprecated: '${CLI_NAME} setup-spark' is now '${CLI_NAME} onboard'; current OpenShell releases handle the old DGX Spark cgroup issue. See '${CLI_NAME} help'.`,
  };
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupSparkCliCommand);
    await runOnboardAction(flags as OnboardFlags);
  }
}
