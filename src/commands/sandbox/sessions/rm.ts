// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { rmSandboxSessions } from "../../../lib/actions/sandbox/sessions/rm";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/snapshot-command-support";

export default class SandboxSessionsRmCommand extends NemoClawCommand {
  static id = "sandbox:sessions:rm";
  static strict = true;
  static summary = "Remove OpenClaw conversation sessions in a sandbox";
  static description = [
    "Wipe a single session or the whole agent's sessions directory in a running sandbox.",
    "",
    "With an agent only: removes every *.jsonl, *.jsonl.lock, and reset archive under",
    "/sandbox/.openclaw/agents/<agent>/sessions/, then resets sessions.json to '{}'.",
    "",
    "With an agent and a session key: looks up the entry's sessionId in sessions.json,",
    "removes <sessionId>.* files (transcript, trajectory, lock, topic transcripts, reset",
    "archives), and strips the matching entry from sessions.json.",
    "",
    "The OpenClaw Gateway should be idle for the target agent before running this command.",
    "Live writes against sessions.json race the gateway writer; restart or stop the agent first.",
  ].join("\n");
  static usage = ["<name> <agent> [<session>] [--force]"];
  static examples = [
    "<%= config.bin %> sandbox sessions rm alpha main",
    "<%= config.bin %> sandbox sessions rm alpha main agent:main:telegram:thread",
    "<%= config.bin %> sandbox sessions rm alpha main --force",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    agent: Args.string({
      name: "agent",
      description: "Agent id (e.g. main).",
      required: true,
    }),
    session: Args.string({
      name: "session",
      description: "Optional canonical session key from sessions.json.",
      required: false,
    }),
  };
  static flags = {
    force: Flags.boolean({
      description:
        "Override the active write-lock refusal. Only use when the lock is known stale (e.g. crashed gateway).",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSessionsRmCommand);
    try {
      await rmSandboxSessions(args.sandboxName, {
        agent: args.agent,
        sessionKey: args.session,
        force: flags.force,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
