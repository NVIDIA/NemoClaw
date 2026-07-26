// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { InferenceGetError, runInferenceGet } from "../../../lib/actions/inference-get";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

// Sandbox-first mirror of the global inference:get command; both delegate to
// the shared runInferenceGet action that reads the gateway-wide route.
export default class SandboxInferenceGetCommand extends NemoClawCommand {
  static id = "sandbox:inference:get";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Show the active NemoClaw inference route";
  static description =
    "Read the live OpenShell inference route through the NemoClaw CLI. The route is gateway-wide; the sandbox name is accepted so the sandbox-scoped grammar mirrors `inference set`.";
  static usage = ["<name> inference get [--json]"];
  static examples = [
    "<%= config.bin %> my-assistant inference get",
    "<%= config.bin %> my-assistant inference get --json",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(SandboxInferenceGetCommand);
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
