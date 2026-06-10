// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

import { stopAll } from "../lib/tunnel/services";
import { runStopCommand } from "../lib/tunnel/service-command";
import { serviceDeps } from "../lib/tunnel/command-support";

export default class DeprecatedStopCommand extends NemoClawCommand {
  static id = "stop";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel stop'";
  static description = "Deprecated alias for tunnel stop.";
  static usage = ["stop"];
  static examples = ["<%= config.bin %> stop"];
  static state = "deprecated" as const;
  static deprecationOptions = {
    message: "Deprecated: 'nemoclaw stop' is now 'nemoclaw tunnel stop'. See 'nemoclaw help'.",
  };
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(DeprecatedStopCommand);
    runStopCommand({ ...serviceDeps(), stopAll });
  }
}
