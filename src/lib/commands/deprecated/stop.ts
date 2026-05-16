// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { CLI_NAME } from "../../cli/branding";
import { stopAll } from "../../tunnel/services";
import { runStopCommand } from "../../tunnel/service-command";
import { serviceDeps } from "../tunnel/common";

export default class DeprecatedStopCommand extends NemoClawCommand {
  static id = "stop";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel stop'";
  static description = "Deprecated alias for tunnel stop.";
  static usage = ["stop"];
  static examples = ["<%= config.bin %> stop"];
  static flags = {
  };

  public async run(): Promise<void> {
    await this.parse(DeprecatedStopCommand);
    this.logToStderr(
      `  Deprecated: '${CLI_NAME} stop' is now '${CLI_NAME} tunnel stop'. See '${CLI_NAME} help'.`,
    );
    runStopCommand({ ...serviceDeps(), stopAll });
  }
}
