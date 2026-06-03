// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasSessionsPassthroughHelpToken,
  printSessionsPassthroughHelp,
  runSessionsPassthrough,
} from "../../lib/actions/sandbox/sessions/passthrough";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxSessionsCommand extends NemoClawCommand {
  static id = "sandbox:sessions";
  static strict = false;
  static summary = "List OpenClaw conversation sessions in a sandbox";
  static description =
    "Pass through to `openclaw sessions` in the sandbox. With no subcommand the in-sandbox CLI lists stored sessions for the configured default agent. Additional OpenClaw flags are forwarded verbatim after the sandbox name.";
  static usage = ["<name> [openclaw-sessions-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox sessions alpha",
    "<%= config.bin %> sandbox sessions alpha --all-agents",
    "<%= config.bin %> sandbox sessions alpha --json",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "" || sandboxName === "--help" || sandboxName === "-h") {
      printSessionsPassthroughHelp();
      return;
    }
    if (hasSessionsPassthroughHelpToken(extraArgs)) {
      printSessionsPassthroughHelp();
      return;
    }
    await runSessionsPassthrough(sandboxName, { extraArgs });
  }
}
