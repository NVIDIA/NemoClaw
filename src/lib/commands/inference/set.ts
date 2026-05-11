// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import {
  InferenceSetError,
  runInferenceSet,
} from "../../actions/inference-set";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

export default class InferenceSetCommand extends NemoClawCommand {
  static id = "inference:set";
  static strict = true;
  static summary = "Switch the NemoClaw inference model";
  static description =
    "Update the OpenShell inference route and sync the running OpenClaw sandbox model identity.";
  static usage = [
    "inference set --provider <provider> --model <model> [--sandbox <name>] [--no-verify]",
  ];
  static examples = [
    "<%= config.bin %> inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b",
    "<%= config.bin %> inference set --provider openai-api --model gpt-5.4 --sandbox my-assistant",
  ];
  static flags = {
    provider: Flags.string({
      description: "OpenShell inference provider name",
      required: true,
    }),
    model: Flags.string({
      description: "Model id to route through the selected provider",
      required: true,
    }),
    sandbox: Flags.string({
      description: "Registered OpenClaw sandbox to sync; defaults to the NemoClaw default sandbox",
    }),
    "no-verify": Flags.boolean({
      description: "Pass --no-verify through to openshell inference set",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InferenceSetCommand);
    try {
      await runInferenceSet({
        provider: flags.provider,
        model: flags.model,
        sandboxName: flags.sandbox ?? null,
        noVerify: flags["no-verify"] === true,
      });
    } catch (error) {
      if (error instanceof InferenceSetError) {
        this.error(error.message, { exit: error.exitCode });
      }
      throw error;
    }
  }
}
