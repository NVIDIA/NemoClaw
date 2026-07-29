// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { cuaSandboxArgs, cuaTaskIdentityFlags } from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskCancelCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:cancel";
  static strict = true;
  static summary = "Cancel an active CUA task and wait for a terminal result";
  static description =
    "Ask the task adapter to cancel the active task, then validate and record its terminal result.";
  static examples = [
    "<%= config.bin %> sandbox cua task cancel alpha --adapter /opt/cua-task-adapter --task-id task-123",
  ];
  static usage = ["<name> --adapter <absolute-path> --task-id <id> [--json]"];
  static args = cuaSandboxArgs;
  static flags = cuaTaskIdentityFlags;

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTaskCancelCommand);
    const rendered = renderCuaTaskResult(
      "task.cancel",
      executeCuaTaskCommand({
        operation: "task.cancel",
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
