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
  static summary = "List conversation sessions in a sandbox";
  static description =
    "Pass through to the sandbox agent's session-listing command (`openclaw sessions` for OpenClaw sandboxes, `hermes sessions list` for Hermes sandboxes). On OpenClaw sandboxes the in-sandbox CLI lists stored sessions for the configured default agent, and internal NemoClaw onboard warm-up sessions are hidden from default user-facing output; OpenClaw-specific flags are forwarded verbatim. Hermes sandboxes pass through their native output unchanged.";
  static usage = ["<name> [sessions-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox sessions alpha",
    "<%= config.bin %> sandbox sessions alpha --limit 20",
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
