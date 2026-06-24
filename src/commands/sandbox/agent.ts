// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasAgentPassthroughHelpToken,
  printAgentPassthroughHelp,
} from "../../lib/actions/sandbox/agent/passthrough-help";
import { runAgentPassthrough } from "../../lib/actions/sandbox/agent/passthrough";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentCommand extends NemoClawCommand {
  static id = "sandbox:agent";
  static strict = false;
  static summary = "Run one OpenClaw agent turn non-interactively in a sandbox";
  static description =
    "Pass through to `openclaw agent` inside the sandbox via `openshell sandbox exec`. Stream the agent's response back to stdout without owning a TTY; useful for driving the sandbox from another process (CI job, multi-agent platform, evaluation harness). All flags accepted by the in-sandbox OpenClaw CLI are forwarded verbatim, including `-m <text>`, `--session-id <id>`, `--agent <id>`, `--json`, `--thinking <level>`, `--deliver`, and `--reply-channel`. Currently supported on OpenClaw sandboxes only; Hermes sandboxes exit non-zero with a redirect to the OpenAI-compatible API on port 8642 inside the sandbox.";
  static usage = ["<name> [openclaw-agent-flags...]"];
  static examples = [
    '<%= config.bin %> sandbox agent alpha -m "Summarise README.md"',
    '<%= config.bin %> sandbox agent alpha --agent work -m "Status update?"',
    '<%= config.bin %> sandbox agent alpha --session-id review-42 -m "Any new findings?"',
    "<%= config.bin %> sandbox agent alpha --json -m 'ping'",
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
      printAgentPassthroughHelp();
      return;
    }
    if (hasAgentPassthroughHelpToken(extraArgs)) {
      printAgentPassthroughHelp();
      return;
    }
    await runAgentPassthrough(sandboxName, { extraArgs });
  }
}
