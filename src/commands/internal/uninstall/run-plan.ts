// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import {
  allGatewayPortsRequested,
  runUninstallAllGatewayPorts,
} from "../../../lib/actions/uninstall/all-gateway-ports";
import { backupAllUnderPortableHostFence } from "../../../lib/actions/maintenance";
import { runUninstallPlanProduction } from "../../../lib/actions/uninstall/run-plan";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../../lib/cli/branding";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { GATEWAY_PORT } from "../../../lib/core/ports";
import { resolveGatewayName } from "../../../lib/onboard/gateway-binding";
import { withSandboxMutationLock } from "../../../lib/state/mcp-lifecycle-lock";

export default class InternalUninstallRunPlanCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = `${CLI_DISPLAY_NAME} Uninstaller`;
  static description = `Remove host-side ${CLI_DISPLAY_NAME} resources.`;
  static usage = [
    "internal uninstall run-plan [--yes] [--keep-openshell] [--delete-models] [--destroy-user-data] [--all-gateway-ports]",
  ];
  static examples = [`${CLI_NAME} internal uninstall run-plan --yes`];
  static flags = {
    yes: Flags.boolean({ description: "Skip the confirmation prompt" }),
    "all-gateway-ports": Flags.boolean({
      description:
        "Uninstall every gateway port on this host, not only the port NEMOCLAW_GATEWAY_PORT selects",
    }),
    "all-gateway-ports-child": Flags.boolean({ hidden: true }),
    "keep-openshell": Flags.boolean({ description: "Leave the openshell binary installed" }),
    "delete-models": Flags.boolean({
      description:
        "Remove all Ollama models and non-credential Hugging Face cache data (authentication files remain)",
    }),
    "destroy-user-data": Flags.boolean({
      description:
        "Skip eligible fresh sandbox backups and remove preserved data from the selected gateway state root",
    }),
    gateway: Flags.string({
      description: "Gateway name",
      default: resolveGatewayName(GATEWAY_PORT),
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalUninstallRunPlanCommand);
    const options = {
      assumeYes: flags.yes ?? false,
      deleteModels: flags["delete-models"] ?? false,
      destroyUserData: flags["destroy-user-data"] ?? false,
      gatewayName: flags.gateway,
      keepOpenShell: flags["keep-openshell"] ?? false,
    };
    const backupAllBeforeUninstall = (sandboxNames: readonly string[]) =>
      backupAllUnderPortableHostFence({
        purpose: "pre-uninstall",
        requireAll: true,
        sandboxNames,
        skipUnreachable: false,
      });
    if (allGatewayPortsRequested(flags["all-gateway-ports"], process.env)) {
      this.applyExitResult(
        await runUninstallAllGatewayPorts(options, {
          backupAllBeforeUninstall,
          withSandboxMutationLock,
        }),
      );
      return;
    }
    this.applyExitResult(
      await runUninstallPlanProduction(options, {
        backupAllBeforeUninstall,
        requireCompleteGatewayProcessCleanup: flags["all-gateway-ports-child"] ?? false,
        withSandboxMutationLock,
      }),
    );
  }
}
