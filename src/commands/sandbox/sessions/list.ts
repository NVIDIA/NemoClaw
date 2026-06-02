// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasSessionsPassthroughHelpToken,
  printSessionsPassthroughHelp,
  runSessionsPassthrough,
} from "../../../lib/actions/sandbox/sessions/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxSessionsListCommand extends NemoClawCommand {
  static id = "sandbox:sessions:list";
  static strict = false;
  static summary = "List OpenClaw conversation sessions in a sandbox";
  static description =
    "Pass through to `openclaw sessions list` in the sandbox. All OpenClaw flags (--agent, --all-agents, --active, --limit, --json, --store, --verbose) are forwarded verbatim.";
  static usage = ["<name> [openclaw-sessions-list-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox sessions list alpha",
    "<%= config.bin %> sandbox sessions list alpha --agent work --json",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "" || sandboxName === "--help" || sandboxName === "-h") {
      printSessionsPassthroughHelp("list");
      return;
    }
    if (hasSessionsPassthroughHelpToken(extraArgs)) {
      printSessionsPassthroughHelp("list");
      return;
    }
    await runSessionsPassthrough(sandboxName, { verb: "list", extraArgs });
  }
}
