// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import {
  cuaSandboxArgs,
  cuaTaskIdentityFlags,
  cuaTaskInputFlag,
} from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskRespondCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:respond";
  static strict = true;
  static summary = "Respond to recoverable CUA input-required state when supported";
  static description =
    "Send a bounded private response only when the active task reports that input is required.";
  static examples = [
    "<%= config.bin %> sandbox cua task respond alpha --adapter /opt/cua-task-adapter --task-id task-123 --input-file ./response.txt",
  ];
  static usage = ["<name> --adapter <absolute-path> --task-id <id> --input-file <path> [--json]"];
  static args = cuaSandboxArgs;
  static flags = { ...cuaTaskIdentityFlags, "input-file": cuaTaskInputFlag };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTaskRespondCommand);
    const rendered = renderCuaTaskResult(
      "task.respond",
      executeCuaTaskCommand({
        operation: "task.respond",
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
