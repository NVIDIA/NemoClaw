// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  cuaDeferredTaskIdentityFlags,
  cuaDeferredTaskInputFlag,
  cuaSandboxArgs,
} from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskRespondCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:respond";
  static strict = true;
  static summary = "Report that CUA task response is unavailable in this slice";
  static args = cuaSandboxArgs;
  static flags = {
    ...cuaDeferredTaskIdentityFlags,
    "input-file": cuaDeferredTaskInputFlag,
  };
  public async run(): Promise<unknown> {
    const { args } = await this.parse(SandboxCuaTaskRespondCommand);
    const rendered = renderCuaTaskResult(
      "task.respond",
      await executeCuaTaskCommand({
        operation: "task.respond",
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
