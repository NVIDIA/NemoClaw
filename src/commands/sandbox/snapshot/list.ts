// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSandboxSnapshot } from "../../../lib/actions/sandbox/snapshot";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  sandboxNameArg,
  snapshotCommandError,
} from "../../../lib/sandbox/snapshot-command-support";

export default class SnapshotListCommand extends NemoClawCommand {
  static id = "sandbox:snapshot:list";
  static strict = true;
  static summary = "List available snapshots";
  static description = "List available snapshots for a sandbox.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox snapshot list alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SnapshotListCommand);
    try {
      await runSandboxSnapshot(args.sandboxName, { kind: "list" });
    } catch (error) {
      const snapshotError = snapshotCommandError(error);
      if (snapshotError) {
        this.failWithLines(snapshotError.lines, snapshotError.exitCode);
        return;
      }
      throw error;
    }
  }
}
