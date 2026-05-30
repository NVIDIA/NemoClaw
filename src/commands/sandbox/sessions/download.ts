// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { downloadSandboxSessions } from "../../../lib/actions/sandbox/sessions/download";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/snapshot-command-support";

export default class SandboxSessionsDownloadCommand extends NemoClawCommand {
  static id = "sandbox:sessions:download";
  static strict = true;
  static summary = "Download OpenClaw session files from a sandbox to the host";
  static description = [
    "Copy session files out of /sandbox/.openclaw/agents/<agent>/sessions/ to the host.",
    "",
    "With an agent only: copies the entire sessions directory (sessions.json + every",
    "transcript, trajectory, lock, topic transcript, and reset archive) to <out>.",
    "",
    "With an agent and a session key: resolves the entry's sessionId, copies all",
    "<sessionId>.* files for that session only.",
    "",
    "Dest is always treated as a directory and created if missing (defaults to",
    "./sessions-<sandbox>/agent-<agent>/).",
  ].join("\n");
  static usage = ["<name> <agent> [<session>] [--out <dir>]"];
  static examples = [
    "<%= config.bin %> sandbox sessions download alpha main",
    "<%= config.bin %> sandbox sessions download alpha main --out ./out/",
    "<%= config.bin %> sandbox sessions download alpha main agent:main:telegram:thread",
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
    out: Flags.string({
      description: "Host destination directory (created if missing).",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSessionsDownloadCommand);
    try {
      await downloadSandboxSessions(args.sandboxName, {
        agent: args.agent,
        sessionKey: args.session,
        out: flags.out,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
