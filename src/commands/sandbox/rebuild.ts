// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { rebuildSandbox } from "../../lib/actions/sandbox/rebuild";
import { forceFlag, yesFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { TOOL_DISCLOSURE_VALUES, type ToolDisclosure } from "../../lib/tool-disclosure";

export default class RebuildCliCommand extends NemoClawCommand {
  static id = "sandbox:rebuild";
  static strict = true;
  static summary = "Upgrade sandbox to current agent version";
  static description = "Back up, recreate, and restore a sandbox using the current agent image.";
  static usage = [
    "<name> [--yes|-y|--force] [--verbose|-v] [--tool-disclosure <progressive|direct>]",
  ];
  static examples = [
    "<%= config.bin %> sandbox rebuild alpha",
    "<%= config.bin %> sandbox rebuild alpha --yes --verbose",
    "<%= config.bin %> sandbox rebuild alpha --yes --tool-disclosure direct",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    yes: yesFlag(),
    force: forceFlag(),
    verbose: Flags.boolean({ char: "v", description: "Show verbose rebuild diagnostics" }),
    "tool-disclosure": Flags.string({
      description: "Change the sandbox tool-disclosure mode during the transactional rebuild",
      options: [...TOOL_DISCLOSURE_VALUES],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RebuildCliCommand);
    await rebuildSandbox(args.sandboxName, {
      force: flags.force === true,
      toolDisclosure: (flags["tool-disclosure"] as ToolDisclosure | undefined) ?? undefined,
      verbose: flags.verbose === true,
      yes: flags.yes === true,
    });
  }
}
