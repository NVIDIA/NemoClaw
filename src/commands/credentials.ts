// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

import { printCredentialsUsage } from "../lib/credentials/command-support";

export default class CredentialsCommand extends NemoClawCommand {
  static id = "credentials";
  static strict = true;
  static summary = "Manage provider credentials";
  static description =
    "List, add, or reset provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials <list|add|reset>"];
  static examples = [
    "<%= config.bin %> credentials list",
    "<%= config.bin %> credentials add tavily-search --type tavily --credential TAVILY_API_KEY",
    "<%= config.bin %> credentials reset nvidia-prod --yes",
  ];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(CredentialsCommand);
    printCredentialsUsage(this.log.bind(this));
  }
}
