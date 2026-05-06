// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { runUninstallPlan } from "../../../lib/actions/uninstall-run-plan";

export default class InternalUninstallRunPlanCommand extends Command {
  static hidden = true;
  static strict = true;
  static summary = "NemoClaw Uninstaller";
  static description = "Remove host-side NemoClaw resources.";
  static usage = ["internal uninstall run-plan [--yes] [--keep-openshell] [--delete-models]"];
  static examples = ["<%= config.bin %> internal uninstall run-plan --yes"];
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ description: "Skip the confirmation prompt" }),
    "keep-openshell": Flags.boolean({ description: "Leave the openshell binary installed" }),
    "delete-models": Flags.boolean({ description: "Remove NemoClaw-pulled Ollama models" }),
    gateway: Flags.string({ description: "Gateway name", default: "nemoclaw" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalUninstallRunPlanCommand);
    const result = runUninstallPlan({
      assumeYes: flags.yes ?? false,
      deleteModels: flags["delete-models"] ?? false,
      gatewayName: flags.gateway,
      keepOpenShell: flags["keep-openshell"] ?? false,
    });
    process.exit(result.exitCode);
  }
}
