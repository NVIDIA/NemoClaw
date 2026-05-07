// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { classifyShimPath } from "../../../lib/actions/uninstall-plan";

export default class InternalUninstallClassifyShimCommand extends Command {
  static hidden = true;
  static strict = true;
  static summary = "Internal: classify a NemoClaw shim path";
  static description = "Classify whether a shim path is safe for the uninstaller to remove.";
  static usage = ["internal uninstall classify-shim <path> [--json]"];
  static examples = ["<%= config.bin %> internal uninstall classify-shim ~/.local/bin/nemoclaw --json"];
  static args = {
    path: Args.string({ description: "Shim path to classify", required: true }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    json: Flags.boolean({ description: "Print classification as JSON" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(InternalUninstallClassifyShimCommand);
    const classification = classifyShimPath(args.path);
    if (flags.json) console.log(JSON.stringify(classification, null, 2));
    else console.log(`${classification.kind}: ${classification.reason}`);
  }
}
