// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOnboardAction } from "../lib/actions/global";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import {
  buildOnboardFlags,
  type OnboardFlags,
  onboardExamples,
  onboardUsage,
  toLegacyOnboardArgs,
} from "../lib/onboard/command-support";

export default class OnboardCliCommand extends NemoClawCommand {
  static id = "onboard";
  static strict = true;
  static summary = "Configure inference endpoint and credentials (--agent to choose runtime)";
  static description = "Configure inference, credentials, and sandbox settings.";
  static usage = onboardUsage;
  static examples = onboardExamples;
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    const { flags } = await this.parse(OnboardCliCommand);
    await runOnboardAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
