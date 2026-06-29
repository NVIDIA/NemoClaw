// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { buildUseCommandDeps, runUseCommand } from "../lib/use-command-deps";

export default class UseCommand extends NemoClawCommand {
  static id = "use";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Set the default sandbox";
  static description =
    "Promote a registered sandbox to the default. Updates the sandbox registry atomically so subsequent commands and scripts use the chosen sandbox without hand-editing on-disk state.";
  static usage = ["use <name> [--json]"];
  static examples = ["<%= config.bin %> use alpha", "<%= config.bin %> use alpha --json"];
  static args = {
    sandboxName: Args.string({
      name: "name",
      description: "Sandbox name to promote to the default",
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<unknown> {
    const { args } = await this.parse(UseCommand);
    const deps = buildUseCommandDeps();
    const result = runUseCommand(args.sandboxName, deps);
    const json = this.jsonEnabled();
    if (result.outcome === "not-found") {
      if (json) {
        process.exitCode = 1;
        return result;
      }
      const known = result.knownSandboxes.length > 0 ? result.knownSandboxes.join(", ") : "(none)";
      this.error(`Sandbox not found: ${result.sandboxName}. Known sandboxes: ${known}.`, {
        exit: 1,
      });
    }
    if (json) return result;
    if (result.outcome === "already-default") {
      this.log(`Sandbox '${result.sandboxName}' is already the default.`);
      return;
    }
    const previous = result.previousDefault ? ` (was '${result.previousDefault}')` : "";
    this.log(`Default sandbox set to '${result.sandboxName}'${previous}.`);
  }
}
