// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { getBuildIdentity } from "../../lib/core/version";
import {
  createPublicHostProbeReadinessReport,
  createSystemReadinessReport,
  renderReadinessReport,
} from "../../lib/readiness";
import { createProductionGatewayReadinessDependencies } from "../../lib/readiness/gateway-production";

export default class HostProbeCommand extends NemoClawCommand {
  static id = "host:probe";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Report host and gateway readiness without changing the system";
  static description =
    "Inspect host capabilities and gateway authority before onboarding. The command does not remediate findings or change host, Docker, gateway, credential, policy, or sandbox state.";
  static usage = ["host probe [--json]"];
  static examples = ["<%= config.bin %> host probe", "<%= config.bin %> host probe --json"];
  static flags = {};
  static publicDisplay = [
    {
      usage: "nemoclaw host probe",
      description: "Report host and gateway readiness without changing the system",
      flags: "[--json]",
      group: "Troubleshooting",
      scope: "global",
      order: 37.5,
    },
  ] as const;

  public async run(): Promise<unknown> {
    await this.parse(HostProbeCommand);
    const report = createPublicHostProbeReadinessReport(
      await createSystemReadinessReport(getBuildIdentity(), {
        gateway: createProductionGatewayReadinessDependencies(),
      }),
    );
    this.setExitCode(report.exitCode);
    if (this.jsonEnabled()) return report;
    this.log(renderReadinessReport(report));
  }
}
