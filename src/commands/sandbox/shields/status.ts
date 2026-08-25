// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertHermesPortableCommandUnavailable,
  NemoClawCommand,
} from "../../../lib/cli/nemoclaw-oclif-command";
import { assertSandboxActivationAllowed } from "../../../lib/actions/sandbox/quarantine/guard";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";
import * as shields from "../../../lib/shields/index";
import { getSandboxForQuarantine } from "../../../lib/state/registry/quarantine-operations";

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
    const quarantineObserved = Boolean(getSandboxForQuarantine(args.sandboxName)?.quarantine);
    shields.shieldsStatus(args.sandboxName, !quarantineObserved, {
      assertCommandAvailable: () => {
        assertHermesPortableCommandUnavailable(args.sandboxName, "sandbox:shields:status");
        if (!quarantineObserved) {
          assertSandboxActivationAllowed(args.sandboxName, "sandbox:shields:status recovery");
        }
      },
    });
  }
}
