// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  cuaSandboxArgs,
  cuaTaskIdentityFlags,
  cuaTaskInputFlag,
} from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskGuideCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:guide";
  static strict = true;
  static summary = "Inject private guidance into an active CUA task when supported";
  static description =
    "Send bounded private guidance to an active task without persisting the input in NemoClaw state.";
  static examples = [
    "<%= config.bin %> sandbox cua task guide alpha --adapter /opt/cua-task-adapter --task-id task-123 --input-file ./guidance.txt",
  ];
  static usage = ["<name> --adapter <absolute-path> --task-id <id> --input-file <path> [--json]"];
  static args = cuaSandboxArgs;
  static flags = { ...cuaTaskIdentityFlags, "input-file": cuaTaskInputFlag };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTaskGuideCommand);
    const rendered = renderCuaTaskResult(
      "task.guide",
      executeCuaTaskCommand({
        operation: "task.guide",
        sandboxName: args.sandboxName,
        taskId: flags["task-id"],
        adapterPath: flags.adapter,
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
