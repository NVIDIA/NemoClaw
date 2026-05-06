// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { startAll } from "../../services";
import { runStartCommand } from "../../services-command";
import { serviceDeps } from "./common";

export default class TunnelStartCommand extends Command {
  static id = "tunnel:start";
  static strict = true;
  static summary = "Start the cloudflared public-URL tunnel";
  static description = "Start the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel start"];
  static examples = ["<%= config.bin %> tunnel start"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(TunnelStartCommand);
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}
