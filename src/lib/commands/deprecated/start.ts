// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

import { CLI_NAME } from "../../cli/branding";
import { startAll } from "../../tunnel/services";
import { runStartCommand } from "../../tunnel/service-command";
import { serviceDeps } from "../tunnel/common";

export default class DeprecatedStartCommand extends NemoClawCommand {
  static id = "start";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel start'";
  static description = "Deprecated alias for tunnel start.";
  static usage = ["start"];
  static examples = ["<%= config.bin %> start"];
  static flags = {
  };

  public async run(): Promise<void> {
    await this.parse(DeprecatedStartCommand);
    this.logToStderr(
      `  Deprecated: '${CLI_NAME} start' is now '${CLI_NAME} tunnel start'. See '${CLI_NAME} help'.`,
    );
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}
