// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertHermesPortableCommandUnavailable,
  NemoClawCommand,
  withSandboxCommandLifecycleLock,
} from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";
import * as shields from "../../../lib/shields/index";

export default class ShieldsUpCommand extends NemoClawCommand {
  static id = "sandbox:shields:up";
  static hidden = true;
  static strict = true;
  static summary = "Raise sandbox security shields";
  static description = "Restore sandbox shields from the saved snapshot.";
  static usage = ["<name>"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsUpCommand);
    await withSandboxCommandLifecycleLock(args.sandboxName, () => {
      assertHermesPortableCommandUnavailable(args.sandboxName, "sandbox:shields:up");
      return shields.shieldsUp(args.sandboxName, { throwOnError: true });
    });
  }
}
