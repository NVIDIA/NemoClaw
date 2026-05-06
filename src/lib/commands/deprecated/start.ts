// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { CLI_NAME } from "../../branding";
import { startAll } from "../../services";
import { runStartCommand } from "../../services-command";
import { serviceDeps } from "../tunnel/common";

export default class DeprecatedStartCommand extends Command {
  static id = "start";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel start'";
  static description = "Deprecated alias for tunnel start.";
  static usage = ["start"];
  static examples = ["<%= config.bin %> start"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(DeprecatedStartCommand);
    this.logToStderr(
      `  Deprecated: '${CLI_NAME} start' is now '${CLI_NAME} tunnel start'. See '${CLI_NAME} help'.`,
    );
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}
