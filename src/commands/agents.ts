// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class AgentsCommand extends NemoClawCommand {
  static id = "agents";
  static strict = true;
  static summary = "Discover available agent runtimes";
  static description = "Discover installed agent runtimes that can be selected during onboarding.";
  static usage = ["agents list"];
  static examples = ["<%= config.bin %> agents list"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(AgentsCommand);
    this.log(`Usage: ${this.config.bin} agents list`);
  }
}
