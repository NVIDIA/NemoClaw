// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { stopAll } from "../../lib/tunnel/services";
import { runStopCommand } from "../../lib/tunnel/service-command";
import { serviceDeps } from "../../lib/tunnel/command-support";

export default class TunnelStopCommand extends NemoClawCommand {
  static id = "tunnel:stop";
  static strict = true;
  static summary = "Stop the cloudflared public-URL tunnel";
  static description = "Stop the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel stop"];
  static examples = ["<%= config.bin %> tunnel stop"];
  static flags = {
  };

  public async run(): Promise<void> {
    await this.parse(TunnelStopCommand);
    runStopCommand({ ...serviceDeps(), stopAll });
  }
}
