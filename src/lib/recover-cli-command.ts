// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { connectSandbox } from "./actions/sandbox/connect";
import { NemoClawCommand } from "./cli/nemoclaw-oclif-command";

export default class RecoverCliCommand extends NemoClawCommand {
  static id = "sandbox:recover";
  static strict = true;
  static summary = "Restart the sandbox gateway and dashboard port-forward";
  static description =
    "Re-run the sandbox-side gateway recovery and re-establish the host-side dashboard port-forward without opening an SSH session. Equivalent to `connect --probe-only`; safe to re-run.";
  static usage = ["<name> recover"];
  static examples = ["<%= config.bin %> alpha recover"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(RecoverCliCommand);
    await connectSandbox(args.sandboxName, { probeOnly: true });
  }
}
