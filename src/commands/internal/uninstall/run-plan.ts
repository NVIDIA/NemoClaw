// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { runUninstallPlan } from "../../../lib/actions/uninstall/run-plan";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../../lib/cli/branding";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class InternalUninstallRunPlanCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = `${CLI_DISPLAY_NAME} Uninstaller`;
  static description = `Remove host-side ${CLI_DISPLAY_NAME} resources.`;
  static usage = [
    "internal uninstall run-plan [--yes] [--keep-openshell] [--delete-models] [--destroy-user-data]",
  ];
  static examples = [`${CLI_NAME} internal uninstall run-plan --yes`];
  static flags = {
    yes: Flags.boolean({ description: "Skip the confirmation prompt" }),
    "keep-openshell": Flags.boolean({ description: "Leave the openshell binary installed" }),
    "delete-models": Flags.boolean({
      description: `Remove ${CLI_DISPLAY_NAME}-pulled Ollama models`,
    }),
    "destroy-user-data": Flags.boolean({
      description:
        "Also remove preserved user data under ~/.nemoclaw/ (rebuild-backups/, backups/, sandboxes.json)",
    }),
    gateway: Flags.string({ description: "Gateway name", default: "nemoclaw" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalUninstallRunPlanCommand);
    const result = runUninstallPlan({
      assumeYes: flags.yes ?? false,
      deleteModels: flags["delete-models"] ?? false,
      destroyUserData: flags["destroy-user-data"] ?? false,
      gatewayName: flags.gateway,
      keepOpenShell: flags["keep-openshell"] ?? false,
    });
    this.applyExitResult(result);
  }
}
