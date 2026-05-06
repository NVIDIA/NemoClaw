// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getStatusReport, showStatusCommand } from "../inventory-commands";
import { NemoClawCommand } from "../cli/nemoclaw-oclif-command";
import { buildStatusCommandDeps } from "../status-command-deps";

export default class StatusCommand extends NemoClawCommand {
  static id = "status";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Show sandbox list and service status";
  static description = "Show registered sandboxes, live inference, services, and messaging health.";
  static usage = ["status [--json]"];
  static examples = ["<%= config.bin %> status", "<%= config.bin %> status --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(StatusCommand);
    const deps = buildStatusCommandDeps(this.config.root);
    if (this.jsonEnabled()) {
      return getStatusReport(deps);
    }

    showStatusCommand(deps);
  }
}
