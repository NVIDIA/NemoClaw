// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { startAll } from "../../tunnel/services";
import { runStartCommand } from "../../tunnel/service-command";
import { serviceDeps } from "./common";

export default class TunnelStartCommand extends NemoClawCommand {
  static id = "tunnel:start";
  static strict = true;
  static summary = "Start the cloudflared public-URL tunnel";
  static description = "Start the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel start"];
  static examples = ["<%= config.bin %> tunnel start"];
  static flags = {
  };

  public async run(): Promise<void> {
    await this.parse(TunnelStartCommand);
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}
