// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../../branding";
import { stopAll } from "../../services";
import { runStopCommand } from "../../services-command";
import { serviceDeps } from "../tunnel/common";

export default class DeprecatedStopCommand extends Command {
  static id = "stop";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel stop'";
  static description = "Deprecated alias for tunnel stop.";
  static usage = ["stop"];
  static examples = ["<%= config.bin %> stop"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(DeprecatedStopCommand);
    this.logToStderr(
      `  Deprecated: '${CLI_NAME} stop' is now '${CLI_NAME} tunnel stop'. See '${CLI_NAME} help'.`,
    );
    runStopCommand({ ...serviceDeps(), stopAll });
  }
}
