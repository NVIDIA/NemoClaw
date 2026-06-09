// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { deleteSandboxSession } from "../../../lib/actions/sandbox/sessions/delete";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxSessionsDeleteCommand extends NemoClawCommand {
  static id = "sandbox:sessions:delete";
  static strict = true;
  static summary = "Delete an OpenClaw conversation session via the gateway";
  static description = [
    "Remove a session entry (and, by default, its transcript) by invoking the",
    "OpenClaw gateway `sessions.delete` RPC from inside the sandbox. The gateway",
    "refuses to remove the agent's main session.",
    "",
    "Goes through `openshell sandbox exec` -> `openclaw gateway call sessions.delete`,",
    "so the gateway owns lock handling and lifecycle events. The host never edits",
    "`sessions.json` directly.",
    "",
    "The <key> argument accepts either an alias (e.g. `telegram:t-1`) or the",
    "canonical `agent:<id>:<rest>` form. Pass --agent to scope an alias to a",
    "non-default agent; mismatched --agent + canonical-key combinations are refused.",
    "",
    "Pass --keep-transcript to retain the on-disk `<sessionId>.jsonl` after the",
    "session entry is removed.",
  ].join("\n");
  static usage = ["<name> <key> [--agent <id>] [--keep-transcript] [--json] [--verbose]"];
  static examples = [
    "<%= config.bin %> sandbox sessions delete alpha telegram:t-1",
    "<%= config.bin %> sandbox sessions delete alpha agent:work:telegram:t-1",
    "<%= config.bin %> sandbox sessions delete alpha telegram:t-1 --agent work --keep-transcript",
    "<%= config.bin %> sandbox sessions delete alpha agent:main:slack:c-9 --json",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    key: Args.string({
      name: "key",
      description: "Session key (alias or canonical agent:<id>:<rest>).",
      required: true,
    }),
  };
  static flags = {
    agent: Flags.string({
      description: "Agent id when <key> is an alias rather than the canonical form.",
    }),
    "keep-transcript": Flags.boolean({
      description: "Retain the session transcript on disk after the entry is removed.",
      default: false,
    }),
    json: Flags.boolean({
      description: "Print the delete result as JSON.",
      default: false,
    }),
    verbose: Flags.boolean({
      description: "Print the gateway entry payload after a successful delete.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSessionsDeleteCommand);
    try {
      await deleteSandboxSession(args.sandboxName, {
        key: args.key,
        agent: flags.agent,
        keepTranscript: flags["keep-transcript"],
        json: flags.json,
        verbose: flags.verbose,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
