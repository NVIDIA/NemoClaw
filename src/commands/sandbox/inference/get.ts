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
    "Read the live OpenShell inference route. NEMOCLAW_GATEWAY_PORT selects the sandbox registry and fallback gateway; a registered sandbox's binding selects its recorded gateway.";
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
    const { args } = await this.parse(SandboxInferenceGetCommand);
    try {
      const result = await runInferenceGet({
        cliName: this.config.bin,
        quiet: this.jsonEnabled(),
        sandboxName: args.sandboxName,
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
