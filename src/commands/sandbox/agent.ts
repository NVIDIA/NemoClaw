// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runAgentPassthrough } from "../../lib/actions/sandbox/agent/passthrough";
import { printAgentPassthroughHelp } from "../../lib/actions/sandbox/agent/passthrough-help";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxAgentCommand extends NemoClawCommand {
  static id = "sandbox:agent";
  static strict = false;
  static summary = "Run one agent turn non-interactively in a sandbox";
  static description =
    "Pass through to the sandbox's registered agent command via `openshell sandbox exec`. OpenClaw sandboxes run `openclaw agent`; terminal-runtime sandboxes run their manifest-declared interactive command, such as `dcode` for LangChain Deep Agents Code. Normal turns stream the agent's response without owning a TTY; top-level OpenClaw `--json` uses a captured path that preserves JSON stdout and appends provenance to stderr. Useful for driving the sandbox from another process (CI job, multi-agent platform, evaluation harness). Hermes sandboxes exit non-zero with a redirect to the OpenAI-compatible API on port 8642 inside the sandbox.";
  static usage = ["<name> [agent-flags...]"];
  static examples = [
    '<%= config.bin %> sandbox agent alpha --agent work -m "Summarise README.md"',
    '<%= config.bin %> sandbox agent alpha --agent work -m "Status update?"',
    '<%= config.bin %> sandbox agent alpha --session-id review-42 -m "Any new findings?"',
    "<%= config.bin %> sandbox agent alpha --session-key intake-42 --json -m 'ping'",
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
    await runAgentPassthrough(sandboxName, { extraArgs });
  }
}
