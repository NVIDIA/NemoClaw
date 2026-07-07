// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { getStatusReport, showStatusCommand } from "../lib/inventory/index";
import { buildStatusCommandDeps } from "../lib/status-command-deps";

export default class StatusCommand extends NemoClawCommand {
  static id = "status";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Show global sandbox and host service status";
  static description =
    "Show the global overview across registered sandboxes, live inference, host services, and messaging health. Use `<name> status` for one sandbox.";
  static usage = ["status [--json]"];
  static examples = ["<%= config.bin %> status", "<%= config.bin %> status --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(StatusCommand);
    const deps = buildStatusCommandDeps(this.config.root);
    if (this.jsonEnabled()) {
      const report = getStatusReport(deps);
      if (report.gatewayHealth && !report.gatewayHealth.healthy) {
        process.exitCode = 1;
      }
      return report;
    }

    showStatusCommand(deps);
  }
}
