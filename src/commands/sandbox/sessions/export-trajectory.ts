// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { exportSandboxSessionTrajectory } from "../../../lib/actions/sandbox/sessions/export-trajectory";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/snapshot-command-support";

export default class SandboxSessionsExportTrajectoryCommand extends NemoClawCommand {
  static id = "sandbox:sessions:export-trajectory";
  static strict = true;
  static summary = "Export a redacted OpenClaw session trajectory bundle";
  static description = [
    "Runs `openclaw sessions export-trajectory` inside the sandbox via",
    "`openshell sandbox exec`. OpenClaw owns the redaction pipeline and the",
    "on-disk bundle shape; this command always passes `--json` so the host",
    "can read the resolved bundle path.",
    "",
    "Pass `--save-host <dir>` to additionally copy the bundle out to the host",
    "via `openshell sandbox download`. The directory is created if missing.",
  ].join("\n");
  static usage = [
    "<name> <agent> <session> [--output <name>] [--workspace <dir>] [--save-host <dir>] [--json]",
  ];
  static examples = [
    "<%= config.bin %> sandbox sessions export-trajectory alpha main agent:main:main",
    "<%= config.bin %> sandbox sessions export-trajectory alpha main agent:main:main --save-host ./trajectories/",
    "<%= config.bin %> sandbox sessions export-trajectory alpha main agent:main:main --output my-bundle --json",
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
    output: Flags.string({
      description: "Bundle directory name inside the sandbox's .openclaw/trajectory-exports.",
    }),
    workspace: Flags.string({
      description: "Sandbox workspace root used to resolve the export base directory.",
    }),
    "save-host": Flags.string({
      description: "Host destination directory; if set, the bundle is downloaded to this path.",
    }),
    json: Flags.boolean({
      description: "Print the trajectory export summary as JSON instead of the text status lines.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSessionsExportTrajectoryCommand);
    try {
      await exportSandboxSessionTrajectory(args.sandboxName, {
        agent: args.agent,
        sessionKey: args.session,
        output: flags.output,
        workspace: flags.workspace,
        saveHost: flags["save-host"],
        json: flags.json,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
