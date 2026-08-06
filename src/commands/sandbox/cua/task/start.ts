// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import type { CuaTaskMode } from "../../../../lib/adapters/cua-task";
import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  cuaSandboxArgs,
  cuaTaskIdentityFlags,
  cuaTaskInputFlag,
} from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskStartCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:start";
  static strict = true;
  static summary = "Start one CUA task against the attached target";
  static description =
    "Send bounded private input to the explicit task adapter and record the returned active task state.";
  static examples = [
    "<%= config.bin %> sandbox cua task start alpha --adapter /opt/cua-task-adapter --task-id task-123 --mode headless --input-file ./task.txt",
  ];
  static usage = [
    "<name> --adapter <absolute-path> --task-id <id> --mode interactive|headless --input-file <path> [--json]",
  ];
  static args = cuaSandboxArgs;
  static flags = {
    ...cuaTaskIdentityFlags,
    mode: Flags.string({
      description: "Runtime surface used for this task",
      options: ["interactive", "headless"],
      required: true,
    }),
    "input-file": cuaTaskInputFlag,
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTaskStartCommand);
    const rendered = renderCuaTaskResult(
      "task.start",
      await executeCuaTaskCommand({
        operation: "task.start",
        sandboxName: args.sandboxName,
        taskId: flags["task-id"],
        adapterPath: flags.adapter,
        mode: flags.mode as CuaTaskMode,
        inputPath: flags["input-file"],
      }),
      this.jsonEnabled(),
    );
    this.setExitCode(rendered.exitCode);
    if (rendered.error) console.error(rendered.error);
    if (rendered.message) this.log(rendered.message);
    return rendered.output;
  }
}
