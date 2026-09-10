// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSessionsPassthrough,
  hasSessionsPassthroughHelpToken,
  printSessionsPassthroughHelp,
} from "../../../lib/actions/sandbox/sessions/passthrough";
import { createCliOpenShellSandboxCommandExecutor } from "../../../lib/adapters/openshell/sandbox-command-cli";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { REPOSITORY_ROOT } from "../../../lib/core/repository-root";

const runSessionsPassthrough = createSessionsPassthrough({
  sandboxCommandExecutor: createCliOpenShellSandboxCommandExecutor({ hostCwd: REPOSITORY_ROOT }),
});

export default class SandboxSessionsListCommand extends NemoClawCommand {
  static id = "sandbox:sessions:list";
  static customHelp = true;
  static strict = false;
  static summary = "List conversation sessions in a sandbox";
  static description =
    "Pass through to the sandbox agent's `sessions list` command (`openclaw sessions list` for OpenClaw sandboxes, `hermes sessions list` for Hermes sandboxes). On OpenClaw sandboxes, internal NemoClaw onboard warm-up sessions are hidden from default user-facing output and OpenClaw flags (--agent, --all-agents, --active, --limit, --json, --store, --verbose) are forwarded verbatim. Hermes sandboxes pass through their native output unchanged.";
  static usage = ["<name> [sessions-list-flags...]"];
  static examples = [
    "<%= config.bin %> sandbox sessions list alpha",
    "<%= config.bin %> sandbox sessions list alpha --limit 20",
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
