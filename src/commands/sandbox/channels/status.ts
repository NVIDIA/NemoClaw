// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { exitCodeFor, showSandboxChannelStatus } from "../../../lib/actions/sandbox/channel-status";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxChannelsStatusCommand extends NemoClawCommand {
  static id = "sandbox:channels:status";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Inspect messaging channel status";
  static description =
    "Report configured messaging channels, policy coverage, non-secret rendered config comparisons, and manifest-defined runtime health. Use --wait with a supported --channel readiness check.";
  static usage = ["<name> [--channel <channel>] [--wait] [--timeout <seconds>] [--json]"];
  static examples = [
    "<%= config.bin %> sandbox channels status alpha --channel whatsapp",
    "<%= config.bin %> sandbox channels status alpha --channel slack --wait --timeout 180 --json",
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
    wait: Flags.boolean({
      dependsOn: ["channel"],
      description: "Wait for manifest-defined operational readiness",
    }),
    timeout: Flags.integer({
      dependsOn: ["wait"],
      // No parser default: oclif validates dependsOn whenever the flag has a
      // value, so a default makes oclif reject every invocation that omits
      // --wait (#8883). showSandboxChannelStatus applies the 180-second
      // budget documented in docs/reference/commands.mdx.
      description: "Readiness timeout in seconds (default: 180)",
      min: 1,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxChannelsStatusCommand);
    const report = await showSandboxChannelStatus(args.sandboxName, {
      channel: flags.channel,
      asJson: this.jsonEnabled(),
      quietJson: this.jsonEnabled(),
      wait: flags.wait,
      timeoutSeconds: flags.timeout,
    });
    if (this.jsonEnabled()) {
      if (report && exitCodeFor(report) !== 0) process.exitCode = 1;
      return report;
    }
  }
}
