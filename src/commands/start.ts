// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

import { startAll } from "../lib/tunnel/services";
import { runStartCommand } from "../lib/tunnel/service-command";
import { serviceDeps } from "../lib/tunnel/command-support";

export default class DeprecatedStartCommand extends NemoClawCommand {
  static id = "start";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel start'";
  static description = "Deprecated alias for tunnel start.";
  static usage = ["start"];
  static examples = ["<%= config.bin %> start"];
  static state = "deprecated" as const;
  static deprecationOptions = {
    message: "Deprecated: 'nemoclaw start' is now 'nemoclaw tunnel start'. See 'nemoclaw help'.",
  };
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(DeprecatedStartCommand);
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}
