// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import {
  InferenceGetError,
  runInferenceGet,
} from "../../actions/inference-get";
import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";

export default class InferenceGetCommand extends NemoClawCommand {
  static id = "inference:get";
  static strict = true;
  static summary = "Show the active NemoClaw inference route";
  static description = "Read the live OpenShell inference route through the NemoClaw CLI.";
  static usage = ["inference get [--json]"];
  static examples = ["<%= config.bin %> inference get", "<%= config.bin %> inference get --json"];
  static flags = {
    json: Flags.boolean({
      description: "Print provider and model as JSON",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InferenceGetCommand);
    try {
      await runInferenceGet({ json: flags.json === true });
    } catch (error) {
      if (error instanceof InferenceGetError) {
        this.error(error.message, { exit: error.exitCode });
      }
      throw error;
    }
  }
}
