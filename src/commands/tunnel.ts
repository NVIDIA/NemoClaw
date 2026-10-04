// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { printTunnelUsage } from "../lib/tunnel/command-support";

export default class TunnelCommand extends NemoClawCommand {
  static id = "tunnel";
  static strict = true;
  static summary = "Manage the cloudflared public-URL tunnel";
  static description =
    "Manage the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel <start|stop|status>"];
  static examples = [
    "<%= config.bin %> tunnel start",
    "<%= config.bin %> tunnel stop",
    "<%= config.bin %> tunnel status",
  ];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(TunnelCommand);
    printTunnelUsage(this.log.bind(this));
  }
}
