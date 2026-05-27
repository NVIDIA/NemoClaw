// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { CLI_NAME } from "../lib/cli/branding";

export default class TunnelCommand extends NemoClawCommand {
  static id = "tunnel";
  static strict = true;
  static summary = "Manage the cloudflared public-URL tunnel";
  static description = "Start, inspect, or stop the cloudflared public-URL tunnel.";
  static usage = ["tunnel <start|status|stop>"];
  static examples = [
    "<%= config.bin %> tunnel start",
    "<%= config.bin %> tunnel status",
    "<%= config.bin %> tunnel stop",
  ];
  static flags = {
  };

  public async run(): Promise<void> {
    await this.parse(TunnelCommand);
    this.log("");
    this.log(`  Usage: ${CLI_NAME} tunnel <subcommand>`);
    this.log("");
    this.log("  Subcommands:");
    this.log("    start    Start the cloudflared public-URL tunnel");
    this.log("    status   Show cloudflared tunnel process and public URL status");
    this.log("    stop     Stop the cloudflared public-URL tunnel");
    this.log("");
  }
}
