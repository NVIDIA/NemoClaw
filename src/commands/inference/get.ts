// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  InferenceGetError,
  runInferenceGet,
} from "../../lib/actions/inference-get";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class InferenceGetCommand extends NemoClawCommand {
  static id = "inference:get";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Show the active NemoClaw inference route";
  static description = "Read the live OpenShell inference route through the NemoClaw CLI.";
  static usage = ["inference get [--json]"];
  static examples = ["<%= config.bin %> inference get", "<%= config.bin %> inference get --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(InferenceGetCommand);
    try {
      const result = await runInferenceGet({ quiet: this.jsonEnabled() });
      if (this.jsonEnabled()) return result;
    } catch (error) {
      if (error instanceof InferenceGetError) {
        this.failWithLines([error.message], error.exitCode);
        return;
      }
      throw error;
    }
  }
}
