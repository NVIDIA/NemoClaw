// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import {
  resetSandboxSession,
  type SessionsResetReason,
} from "../../../lib/actions/sandbox/sessions/reset";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class SandboxSessionsResetCommand extends NemoClawCommand {
  static id = "sandbox:sessions:reset";
  static strict = true;
  static summary = "Reset an OpenClaw conversation session via the gateway";
  static description = [
    "Archive the named session and rebind its key to a fresh sessionId by invoking",
    "the OpenClaw gateway `sessions.reset` RPC from inside the sandbox.",
    "",
    "Goes through `openshell sandbox exec` -> `openclaw gateway call sessions.reset`,",
    "so the gateway owns archival, lock handling, and lifecycle events. The host",
    "never edits `sessions.json` directly.",
    "",
    "The <key> argument accepts either an alias (e.g. `main`, `telegram:t-1`) or the",
    "canonical `agent:<id>:<rest>` form. Pass --agent to scope an alias to a",
    "non-default agent; mismatched --agent + canonical-key combinations are refused.",
    "",
    "--reason new registers a fresh session under the same key without preserving the",
    "archive trail; the default --reason reset archives the prior transcript.",
  ].join("\n");
  static usage = ["<name> <key> [--agent <id>] [--reason new|reset] [--json] [--verbose]"];
  static examples = [
    "<%= config.bin %> sandbox sessions reset alpha main",
    "<%= config.bin %> sandbox sessions reset alpha agent:work:telegram:t-1",
    "<%= config.bin %> sandbox sessions reset alpha telegram:t-1 --agent work --reason new",
    "<%= config.bin %> sandbox sessions reset alpha agent:main:main --json",
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
    reason: Flags.string({
      description: "Reset reason forwarded to OpenClaw.",
      options: ["reset", "new"],
      default: "reset",
    }),
    json: Flags.boolean({
      description: "Print the reset result as JSON.",
      default: false,
    }),
    verbose: Flags.boolean({
      description: "Print the gateway entry payload after a successful reset.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSessionsResetCommand);
    const reason = (flags.reason ?? "reset") as SessionsResetReason;
    try {
      await resetSandboxSession(args.sandboxName, {
        key: args.key,
        agent: flags.agent,
        reason,
        json: flags.json,
        verbose: flags.verbose,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
