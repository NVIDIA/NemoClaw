// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { getHardwareResources, printHardwareResources } from "../lib/resources-cmd";

export default class ResourcesCommand extends NemoClawCommand {
  static id = "resources";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Show hardware inventory (CPU cores, RAM, GPU VRAM)";
  static description =
    "Display available hardware resources including CPU core count and model, " +
    "total system RAM and swap, Kubernetes node allocatable capacity (when a " +
    "gateway is running), and NVIDIA GPU name and VRAM. Supports --json for " +
    "machine-readable output.";
  static usage = ["resources [--json]"];
  static examples = ["<%= config.bin %> resources", "<%= config.bin %> resources --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(ResourcesCommand);
    if (this.jsonEnabled()) return getHardwareResources();
    printHardwareResources(false);
  }
}
