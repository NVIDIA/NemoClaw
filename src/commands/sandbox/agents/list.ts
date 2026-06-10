// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentsPassthroughHelpToken,
  printAgentsPassthroughHelp,
  runAgentsPassthrough,
} from "../../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsListCommand extends NemoClawCommand {
  static id = "sandbox:agents:list";
  static strict = false;
  static summary = "List OpenClaw agents configured in a sandbox";
  static description =
    "Pass through to `openclaw agents list` in the sandbox. Runs the OpenClaw lister via `openshell sandbox exec`; all OpenClaw flags (e.g. `--json`, `--bindings`) are forwarded verbatim.";
  static usage = ["<name> [openclaw-agents-list-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents list alpha",
    "<%= config.bin %> sandbox agents list alpha --json",
    "<%= config.bin %> sandbox agents list alpha --bindings",
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
      printAgentsPassthroughHelp("list");
      return;
    }
    if (hasAgentsPassthroughHelpToken(extraArgs)) {
      printAgentsPassthroughHelp("list");
      return;
    }
    await runAgentsPassthrough(sandboxName, { verb: "list", extraArgs });
  }
}
