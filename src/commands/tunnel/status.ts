// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { showStatus } from "../../lib/tunnel/services";

export default class TunnelStatusCommand extends NemoClawCommand {
  static id = "tunnel:status";
  static strict = true;
  static summary = "Show cloudflared public-URL tunnel status";
  static description = "Show the cloudflared public-URL tunnel status for the default sandbox dashboard.";
  static usage = ["tunnel status"];
  static examples = ["<%= config.bin %> tunnel status"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(TunnelStatusCommand);
    showStatus();
  }
}
