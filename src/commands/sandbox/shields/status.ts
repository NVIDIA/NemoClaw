// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";
import * as shields from "../../../lib/shields/index";
import { withSandboxMutationLock } from "../../../lib/state/mcp-lifecycle-lock";

export default class ShieldsStatusCommand extends NemoClawCommand {
  static id = "sandbox:shields:status";
  static hidden = true;
  static strict = true;
  static summary = "Show current shields state";
  static description = "Show current sandbox shields state.";
  static usage = ["<name>"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsStatusCommand);
    await withSandboxMutationLock(args.sandboxName, () => shields.shieldsStatus(args.sandboxName));
  }
}
