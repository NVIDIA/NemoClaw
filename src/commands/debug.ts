// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

import type { DebugOptions } from "../lib/diagnostics/debug";
import { runDebugCommandWithOptions } from "../lib/diagnostics/debug-command";
import { buildDebugCommandDeps } from "../lib/diagnostics/debug-command-deps";

export default class DebugCliCommand extends NemoClawCommand {
  static id = "debug";
  static strict = true;
  static summary = "Collect diagnostics for bug reports";
  static description = "Collect NemoClaw diagnostic information.";
  static usage = ["debug [--quick|-q] [--output FILE|-o FILE] [--sandbox NAME]"];
  static examples = [
    "<%= config.bin %> debug --quick",
    "<%= config.bin %> debug --sandbox alpha",
    "<%= config.bin %> debug --output /tmp/nemoclaw-debug.tar.gz",
  ];
  static flags = {
    quick: Flags.boolean({ char: "q", description: "Only collect minimal diagnostics" }),
    output: Flags.string({ char: "o", description: "Write a tarball to FILE" }),
    sandbox: Flags.string({ description: "Target sandbox name" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DebugCliCommand);
    const options: DebugOptions = {};
    if (flags.quick) options.quick = true;
    if (flags.output) options.output = flags.output;
    if (flags.sandbox) options.sandboxName = flags.sandbox;
    await runDebugCommandWithOptions(options, buildDebugCommandDeps(this.config.root));
  }
}
