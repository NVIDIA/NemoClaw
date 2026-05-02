// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Command, Flags } from "@oclif/core";

import { showStatusCommand } from "./inventory-commands";
import { buildStatusCommandDeps } from "./status-command-deps";

export default class StatusCommand extends Command {
  static id = "status";
  static strict = true;
  static summary = "Show sandbox list and service status";
  static description = "Show registered sandboxes, live inference, services, and messaging health.";
  static usage = ["status"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(StatusCommand);
    showStatusCommand(buildStatusCommandDeps(this.config.root));
  }
}
