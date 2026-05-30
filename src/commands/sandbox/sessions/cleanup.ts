// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runSessionsPassthrough } from "../../../lib/actions/sandbox/sessions/passthrough";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxSessionsCleanupCommand extends NemoClawCommand {
  static id = "sandbox:sessions:cleanup";
  static strict = false;
  static summary = "Run OpenClaw session-store maintenance in a sandbox";
  static description =
    "Pass through to `openclaw sessions cleanup` in the sandbox. Use --dry-run to preview, --enforce to apply. Other OpenClaw flags (--agent, --all-agents, --fix-missing, --fix-dm-scope, --active-key, --json, --store) are forwarded verbatim.";
  static usage = ["<name> [openclaw-sessions-cleanup-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox sessions cleanup alpha --dry-run",
    "<%= config.bin %> sandbox sessions cleanup alpha --enforce",
    "<%= config.bin %> sandbox sessions cleanup alpha --all-agents --dry-run",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...extraArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "") {
      this.failWithLines(["Missing required sandbox name for sessions cleanup."], 2);
      return;
    }
    await runSessionsPassthrough(sandboxName, { verb: "cleanup", extraArgs });
  }
}
