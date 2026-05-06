// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { runOnboardAction } from "../global-cli-actions";
import {
  buildOnboardFlags,
  onboardExamples,
  type OnboardFlags,
  onboardUsage,
  toLegacyOnboardArgs,
} from "./onboard/common";

export default class OnboardCliCommand extends Command {
  static id = "onboard";
  static strict = true;
  static summary = "Configure inference endpoint and credentials";
  static description = "Configure inference, credentials, and sandbox settings.";
  static usage = onboardUsage;
  static examples = onboardExamples;
  static flags = buildOnboardFlags();

  public async run(): Promise<void> {
    const { flags } = await this.parse(OnboardCliCommand);
    await runOnboardAction(toLegacyOnboardArgs(flags as OnboardFlags));
  }
}
