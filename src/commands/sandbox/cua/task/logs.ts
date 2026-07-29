// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../../lib/cli/nemoclaw-oclif-command";
import { cuaSandboxArgs, cuaTaskIdentityFlags } from "../../../../lib/cua/task-cli-definitions";
import { executeCuaTaskCommand, renderCuaTaskResult } from "../../../../lib/cua/task-command";

export default class SandboxCuaTaskLogsCommand extends NemoClawCommand {
  static enableJsonFlag = true;
  static id = "sandbox:cua:task:logs";
  static strict = true;
  static summary = "Retrieve private CUA log evidence references";
  static description =
    "Retrieve and validate content-addressed references to private log evidence for the active or retained completed task.";
  static examples = [
    "<%= config.bin %> sandbox cua task logs alpha --adapter /opt/cua-task-adapter --task-id task-123 --json",
  ];
  static usage = ["<name> --adapter <absolute-path> --task-id <id> [--json]"];
  static args = cuaSandboxArgs;
  static flags = cuaTaskIdentityFlags;

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxCuaTaskLogsCommand);
    const rendered = renderCuaTaskResult(
      "task.logs",
      executeCuaTaskCommand({
        operation: "task.logs",
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
