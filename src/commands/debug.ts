// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import path from "node:path";

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
    "native-windows-turn": Flags.boolean({ hidden: true }),
    "artifact-directory": Flags.string({ hidden: true }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(DebugCliCommand);
    if (flags["native-windows-turn"]) {
      const installRoot = process.env.NEMOCLAW_NATIVE_INSTALL_ROOT;
      if (!installRoot || process.platform !== "win32") {
        this.error("The native Windows qualification turn requires the installed Windows package.");
      }
      const script = path.join(installRoot, "qualification", "run-installed-native-turn.mts");
      const args = ["--experimental-strip-types", "--no-warnings", script];
      if (flags["artifact-directory"]) {
        args.push("--artifact-directory", flags["artifact-directory"]);
      }
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          env: process.env,
          stdio: "inherit",
          windowsHide: false,
        });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) {
        this.error(`Native Windows MXC qualification turn failed with exit code ${exitCode}.`);
      }
      return;
    }
    const options: DebugOptions = {};
    if (flags.quick) options.quick = true;
    if (flags.output) options.output = flags.output;
    if (flags.sandbox) options.sandboxName = flags.sandbox;
    await runDebugCommandWithOptions(options, buildDebugCommandDeps(this.config.root));
  }
}
