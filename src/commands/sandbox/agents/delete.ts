// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentsPassthroughHelpToken,
  printAgentsPassthroughHelp,
  runAgentsPassthrough,
} from "../../../lib/actions/sandbox/agents/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentsDeleteCommand extends NemoClawCommand {
  static id = "sandbox:agents:delete";
  static strict = false;
  static summary = "Delete an OpenClaw agent inside a sandbox";
  static description =
    "Pass through to `openclaw agents delete <id>` in the sandbox. The OpenClaw CLI owns gateway dispatch, host-side workspace removal, and config edits. All flags (e.g. `--force`, `--json`) are forwarded verbatim.";
  static usage = ["<name> <agent-id> [openclaw-agents-delete-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox agents delete alpha work",
    "<%= config.bin %> sandbox agents delete alpha work --force --json",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "" || sandboxName === "--help" || sandboxName === "-h") {
      printAgentsPassthroughHelp("delete");
      return;
    }
    if (hasAgentsPassthroughHelpToken(extraArgs)) {
      printAgentsPassthroughHelp("delete");
      return;
    }
    await runAgentsPassthrough(sandboxName, { verb: "delete", extraArgs });
  }
}
