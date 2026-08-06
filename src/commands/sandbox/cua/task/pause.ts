// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  cuaDeferredTaskIdentityFlags,
  cuaSandboxArgs,
} from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskPauseCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:pause";
  static strict = true;
  static summary = "Report that CUA task pause is unavailable in this slice";
  static args = cuaSandboxArgs;
  static flags = cuaDeferredTaskIdentityFlags;
  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxCuaTaskPauseCommand);
    const rendered = renderCuaTaskResult(
      "task.pause",
      await executeCuaTaskCommand({
        operation: "task.pause",
        sandboxName: args.sandboxName,
        taskId: "",
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    return rendered.output;
  }
}
