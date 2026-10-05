// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInventory, listSandboxesCommand } from "../lib/inventory";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { withStdoutRedirectedToStderr } from "../lib/cli/stdout-guard";
import { buildListCommandDeps } from "../lib/list-command-deps";

export default class ListCommand extends NemoClawCommand {
  static id = "list";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "List all sandboxes";
  static description =
    "List all registered sandboxes with their model, provider, and policy presets.";
  static usage = ["list [--json]"];
  static examples = ["<%= config.bin %> list", "<%= config.bin %> list --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(ListCommand);
    const deps = buildListCommandDeps();
    const json = this.jsonEnabled();
    if (json) {
      return withStdoutRedirectedToStderr(() => getSandboxInventory(deps));
    }
    await listSandboxesCommand({ ...deps, log: this.log.bind(this) });
  }
}
