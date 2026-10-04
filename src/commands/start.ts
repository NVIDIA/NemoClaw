// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

const DEPRECATED_START_MESSAGE =
  "Deprecated: 'nemoclaw start' no longer starts a resource. Use 'nemoclaw <name> start' for a stopped sandbox or 'nemoclaw tunnel start' for the optional public-URL tunnel.";

export default class DeprecatedStartCommand extends NemoClawCommand {
  static id = "start";
  static strict = true;
  static summary = "Deprecated command that prints start migration guidance";
  static description =
    "Use 'nemoclaw <name> start' or 'nemoclaw tunnel start'; this command does not start a sandbox or public-URL tunnel.";
  static usage = ["start"];
  static examples = ["<%= config.bin %> start"];
  static state = "deprecated" as const;
  static deprecationOptions = {
    message: DEPRECATED_START_MESSAGE,
  };
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(DeprecatedStartCommand);
  }
}
