// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import {
  QUARANTINE_RELEASE_GUIDANCE,
  releaseSandboxQuarantine,
} from "../../../lib/actions/sandbox/quarantine/index";
import { NemoClawSandboxCommand } from "../../../lib/cli/nemoclaw-sandbox-command";

export default class SandboxQuarantineReleaseCommand extends NemoClawSandboxCommand {
  static id = "sandbox:quarantine:release";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Release a sandbox quarantine fence without starting it";
  static description =
    "Remove one exact quarantine fence after preserving its receipt. Release never starts or recovers the sandbox.";
  static usage = ["<name> --fence-id <id> [--json]"];
  static examples = [
    "<%= config.bin %> alpha quarantine release --fence-id 00000000-0000-4000-8000-000000000000",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    "fence-id": Flags.string({
      description: "Exact fence identifier printed by the quarantine command",
      required: true,
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxQuarantineReleaseCommand);
    const result = releaseSandboxQuarantine(args.sandboxName, flags["fence-id"]);
    this.setExitCode(result.exitCode);
    if (this.jsonEnabled()) return result;
    console.log(`  ${result.message}`);
    if (result.receiptPath) console.log(`  Receipt: ${result.receiptPath}`);
    if (result.exitCode === 0) console.log(`  ${QUARANTINE_RELEASE_GUIDANCE}`);
  }
}
