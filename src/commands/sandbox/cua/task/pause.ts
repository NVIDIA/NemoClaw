// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { cuaSandboxArgs, cuaTaskIdentityFlags } from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskPauseCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:pause";
  static strict = true;
  static summary = "Pause an active CUA task when supported";
  static description =
    "Ask the task adapter to pause an active task and validate the returned task state.";
  static examples = [
    "<%= config.bin %> sandbox cua task pause alpha --adapter /opt/cua-task-adapter --task-id task-123",
  ];
  static usage = ["<name> --adapter <absolute-path> --task-id <id> [--json]"];
  static args = cuaSandboxArgs;
  static flags = cuaTaskIdentityFlags;

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTaskPauseCommand);
    const rendered = renderCuaTaskResult(
      "task.pause",
      executeCuaTaskCommand({
        operation: "task.pause",
        sandboxName: args.sandboxName,
        taskId: flags["task-id"],
        adapterPath: flags.adapter,
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    if (rendered.message) this.log(rendered.message);
    return rendered.output;
  }
}
