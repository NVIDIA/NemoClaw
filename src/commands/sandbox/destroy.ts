// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import {
  delegateSandboxDestroyBeforeLifecycleBoundary,
  destroySandbox,
} from "../../lib/actions/sandbox/destroy";
import { forceFlag, yesFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import type { DestroySandboxOptions } from "../../lib/domain/lifecycle/options";
import { enforceRemovedImmutabilityMigrationBoundary } from "../../lib/state/migrations/removed-immutability";

function destroyOptionsFromFlags(flags: {
  "cleanup-gateway"?: boolean;
  "keep-vllm"?: boolean;
  force?: boolean;
  yes?: boolean;
}): DestroySandboxOptions {
  const cleanupGatewayFlag = flags["cleanup-gateway"];
  return {
    force: flags.force === true,
    yes: flags.yes === true,
    ...(cleanupGatewayFlag === undefined ? {} : { cleanupGateway: cleanupGatewayFlag }),
    ...(flags["keep-vllm"] === true ? { keepVllm: true } : {}),
  };
}

export default class DestroyCliCommand extends NemoClawCommand {
  static id = "sandbox:destroy";
  static strict = true;
  static summary = "Stop NIM and delete sandbox";
  static description = "Destroy a sandbox and remove its local registry entry.";
  static usage = [
    "<name> [--yes|-y|--force] [--cleanup-gateway|--no-cleanup-gateway] [--keep-vllm]",
  ];
  static examples = [
    "<%= config.bin %> sandbox destroy alpha",
    "<%= config.bin %> sandbox destroy alpha --yes",
    "<%= config.bin %> sandbox destroy alpha --yes --cleanup-gateway",
    "<%= config.bin %> sandbox destroy alpha --yes --keep-vllm",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    yes: yesFlag(),
    force: forceFlag(
      "Skip confirmation. For eligible recovery records with no sandbox identity, archive and remove local tracking after current absence checks. Original runtime cleanup remains unverified.",
    ),
    "cleanup-gateway": Flags.boolean({
      description:
        "When destroying the last sandbox, also tear down the shared NemoClaw gateway. Default: preserve on Linux; cleanup for unattended macOS destroys. NEMOCLAW_CLEANUP_GATEWAY overrides the platform default.",
      allowNo: true,
    }),
    "keep-vllm": Flags.boolean({
      description:
        "Keep the managed vLLM container running after destroying the last sandbox that uses Local vLLM. NEMOCLAW_KEEP_VLLM=1 has the same effect.",
    }),
  };

  protected override async runBeforeLifecycleBoundary(): Promise<boolean> {
    const parsed = await this.parse(DestroyCliCommand);
    this.retainLifecycleParserOutput(parsed);
    enforceRemovedImmutabilityMigrationBoundary(parsed.args.sandboxName, {
      allowStateRecord: true,
    });
    return await delegateSandboxDestroyBeforeLifecycleBoundary(
      parsed.args.sandboxName,
      destroyOptionsFromFlags(parsed.flags),
    );
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DestroyCliCommand);
    await destroySandbox(args.sandboxName, destroyOptionsFromFlags(flags));
  }
}
