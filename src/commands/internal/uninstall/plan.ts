// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { buildHostUninstallPlan } from "../../../lib/actions/uninstall-plan";

export default class InternalUninstallPlanCommand extends Command {
  static hidden = true;
  static strict = true;
  static summary = "Internal: build the NemoClaw uninstall plan";
  static description = "Build a deterministic uninstall plan without applying it.";
  static usage = ["internal uninstall plan [--json] [--delete-models] [--keep-openshell]"];
  static examples = ["<%= config.bin %> internal uninstall plan --json --yes"];
  static flags = {
    help: Flags.help({ char: "h" }),
    json: Flags.boolean({ description: "Print the uninstall plan as JSON" }),
    yes: Flags.boolean({ description: "Accepted for parity with run-plan; ignored while planning" }),
    "delete-models": Flags.boolean({ description: "Plan removal of NemoClaw-pulled Ollama models" }),
    "keep-openshell": Flags.boolean({ description: "Keep the openshell binary installed" }),
    gateway: Flags.string({ description: "Gateway name", default: "nemoclaw" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalUninstallPlanCommand);
    const plan = buildHostUninstallPlan({
      deleteModels: flags["delete-models"] ?? false,
      env: process.env,
      gatewayName: flags.gateway,
      keepOpenShell: flags["keep-openshell"] ?? false,
    });
    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(`Uninstall plan: ${plan.steps.length} steps for gateway '${plan.gatewayName}'`);
  }
}
