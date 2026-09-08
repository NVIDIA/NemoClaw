// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { rebuildSandbox, retireRebuildRecoveryBackup } from "../../lib/actions/sandbox/rebuild";
import { forceFlag, yesFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import {
  DCODE_AUTO_APPROVAL_MODES,
  type DcodeAutoApprovalMode,
} from "../../lib/onboard/dcode-auto-approval";
import { TOOL_DISCLOSURE_VALUES, type ToolDisclosure } from "../../lib/tool-disclosure";

export default class RebuildCliCommand extends NemoClawCommand {
  static id = "sandbox:rebuild";
  static strict = true;
  static summary = "Upgrade sandbox to current agent version";
  static description = "Back up, recreate, and restore a sandbox using the current agent image.";
  static usage = [
    "<name> [--yes|-y|--force] [--verbose|-v] [--tool-disclosure <progressive|direct>] [--dcode-auto-approval <disabled|thread-opt-in>] [--observability|--no-observability] [--retire-recovery <transaction-id>]",
  ];
  static examples = [
    "<%= config.bin %> sandbox rebuild alpha",
    "<%= config.bin %> sandbox rebuild alpha --yes --verbose",
    "<%= config.bin %> sandbox rebuild alpha --yes --tool-disclosure direct",
    "<%= config.bin %> sandbox rebuild my-dcode --dcode-auto-approval thread-opt-in",
    "<%= config.bin %> sandbox rebuild my-dcode --yes --observability",
    "<%= config.bin %> sandbox rebuild alpha --retire-recovery 11111111-1111-4111-8111-111111111111 --yes",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    yes: yesFlag(),
    force: forceFlag(),
    verbose: Flags.boolean({ char: "v", description: "Show verbose rebuild diagnostics" }),
    "tool-disclosure": Flags.string({
      description: "Change the sandbox tool-disclosure mode during the transactional rebuild",
      options: [...TOOL_DISCLOSURE_VALUES],
    }),
    "dcode-auto-approval": Flags.string({
      description: "Change managed Deep Agents Code thread auto-approval during rebuild",
      options: [...DCODE_AUTO_APPROVAL_MODES],
    }),
    observability: Flags.boolean({
      allowNo: true,
      description: "Change managed Deep Agents Code trace export during the transactional rebuild",
    }),
    "retire-recovery": Flags.string({
      description:
        "Retire an exact rebuild recovery after confirmed deletion and required data recovery",
      helpValue: "<transaction-id>",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RebuildCliCommand);
    const recoveryTransactionId = flags["retire-recovery"];
    if (recoveryTransactionId) {
      const retired = retireRebuildRecoveryBackup({
        sandboxName: args.sandboxName,
        transactionId: recoveryTransactionId,
        confirmDataRecovered: flags.yes === true,
      });
      this.log(
        `Retired rebuild recovery '${retired.transactionId}' for sandbox '${args.sandboxName}' from ${retired.backupPath}.`,
      );
      return;
    }
    await rebuildSandbox(args.sandboxName, {
      dcodeAutoApprovalMode:
        (flags["dcode-auto-approval"] as DcodeAutoApprovalMode | undefined) ?? undefined,
      force: flags.force === true,
      ...(flags.observability === undefined ? {} : { observabilityEnabled: flags.observability }),
      toolDisclosure: (flags["tool-disclosure"] as ToolDisclosure | undefined) ?? undefined,
      verbose: flags.verbose === true,
      yes: flags.yes === true,
    });
  }
}
