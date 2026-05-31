// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import {
  resetSandboxSession,
  type SessionsResetReason,
} from "../../../lib/actions/sandbox/sessions/reset";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/snapshot-command-support";

export default class SandboxSessionsResetCommand extends NemoClawCommand {
  static id = "sandbox:sessions:reset";
  static strict = true;
  static summary = "Reset an OpenClaw conversation session";
  static description = [
    "Archive the named session and rebind its key to a fresh sessionId by invoking",
    "the OpenClaw gateway `sessions.reset` RPC from inside the sandbox.",
    "",
    "Goes through `openshell sandbox exec` -> `openclaw gateway call sessions.reset`,",
    "so the gateway owns archival (`<sessionId>.reset.<ts>.jsonl`), lock handling, and",
    "lifecycle events. The host never edits `sessions.json` directly.",
    "",
    "Use --reason new to register a brand-new session under the same key (no archive",
    "of prior state is bound to the key); the default reason 'reset' preserves the",
    "archive trail.",
  ].join("\n");
  static usage = ["<name> <agent> <session> [--reason new|reset]"];
  static examples = [
    "<%= config.bin %> sandbox sessions reset alpha main agent:main:main",
    "<%= config.bin %> sandbox sessions reset alpha main agent:main:telegram:thread --reason new",
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
      description: "Canonical session key from sessions.json (e.g. agent:main:main).",
      required: true,
    }),
  };
  static flags = {
    reason: Flags.string({
      description: "Reset reason forwarded to OpenClaw.",
      options: ["reset", "new"],
      default: "reset",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSessionsResetCommand);
    const reason = (flags.reason ?? "reset") as SessionsResetReason;
    try {
      await resetSandboxSession(args.sandboxName, {
        agent: args.agent,
        sessionKey: args.session,
        reason,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
