// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { InferenceGetError, runInferenceGet } from "../../lib/actions/inference-get";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class InferenceGetCommand extends NemoClawCommand {
  static id = "inference:get";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Show the selected NemoClaw inference path";
  static description =
    "Read the selected sandbox's native NVIDIA provider path or the live shared OpenShell route.";
  static usage = ["inference get [--json]"];
  static examples = ["<%= config.bin %> inference get", "<%= config.bin %> inference get --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(InferenceGetCommand);
    try {
      const result = await runInferenceGet({
        cliName: this.config.bin,
        quiet: this.jsonEnabled(),
      });
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
