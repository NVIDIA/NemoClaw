// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { startAll } from "../../lib/tunnel/services";
import { runStartCommand } from "../../lib/tunnel/service-command";
import { serviceDeps } from "../../lib/tunnel/command-support";

export default class TunnelStartCommand extends NemoClawCommand {
  static id = "tunnel:start";
  static strict = true;
  static summary = "Start the cloudflared public-URL tunnel";
  static description = "Start the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel start"];
  static examples = ["<%= config.bin %> tunnel start"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(TunnelStartCommand);
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}
