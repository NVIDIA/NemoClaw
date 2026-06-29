// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentsPassthroughHelpToken,
  printAgentsPassthroughHelp,
  runAgentsPassthrough,
} from "../../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsAddCommand extends NemoClawCommand {
  static id = "sandbox:agents:add";
  static strict = false;
  static summary = "Add an OpenClaw agent inside a sandbox";
  static description =
    "Pass through to `openclaw agents add` in the sandbox. Runs the OpenClaw interactive add wizard via `openshell sandbox exec`; all OpenClaw flags are forwarded verbatim.";
  static usage = ["<name> [openclaw-agents-add-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents add alpha",
    "<%= config.bin %> sandbox agents add alpha work --model gpt-4o",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (
      !sandboxName ||
      sandboxName.trim() === "" ||
      sandboxName === "--help" ||
      sandboxName === "-h"
    ) {
      printAgentsPassthroughHelp("add");
      return;
    }
    if (hasAgentsPassthroughHelpToken(extraArgs)) {
      printAgentsPassthroughHelp("add");
      return;
    }
    await runAgentsPassthrough(sandboxName, { verb: "add", extraArgs });
  }
}
