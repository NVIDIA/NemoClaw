// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInventory, renderSandboxInventoryText } from "../inventory-commands";
import { NemoClawCommand } from "../cli/nemoclaw-oclif-command";
import { buildListCommandDeps } from "../list-command-deps";

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
    const inventory = await getSandboxInventory(deps);
    if (this.jsonEnabled()) {
      return inventory;
    }

    const liveInference = inventory.sandboxes.length > 0 ? deps.getLiveInference() : null;
    renderSandboxInventoryText(inventory, this.log.bind(this), liveInference);
  }
}
