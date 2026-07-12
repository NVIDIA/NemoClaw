// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { showSandboxChannelStatus } from "../../../lib/actions/sandbox/channel-status";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxChannelsStatusCommand extends NemoClawCommand {
  static id = "sandbox:channels:status";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Inspect messaging channel status";
  static description =
    "Report configured messaging channels, policy coverage, and non-secret rendered config comparisons in the compact summary and non-WhatsApp detail views. Pass --channel whatsapp for the deeper WhatsApp QR/session and inbound-delivery probe.";
  static usage = ["<name> [--channel <channel>] [--json]"];
  static examples = [
    "<%= config.bin %> sandbox channels status alpha --channel whatsapp",
    "<%= config.bin %> sandbox channels status alpha --json",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    channel: Flags.string({
      description: "Messaging channel to inspect in detail",
      required: false,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxChannelsStatusCommand);
    const report = await showSandboxChannelStatus(args.sandboxName, {
      channel: flags.channel,
      asJson: this.jsonEnabled(),
      quietJson: this.jsonEnabled(),
    });
    if (this.jsonEnabled()) {
      if (report && "report" in report) {
        const verdict = report.report.verdict;
        if (verdict !== "healthy" && verdict !== "unknown") {
          process.exitCode = 1;
        }
      }
      return report;
    }
  }
}
