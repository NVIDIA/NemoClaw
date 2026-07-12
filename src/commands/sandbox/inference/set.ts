// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { InferenceSetError, runInferenceSet } from "../../../lib/actions/inference-set";
import { nonEmptyFlag } from "../../../lib/cli/flag-helpers";
import { inferenceSetRequiredFlagsFailureLines } from "../../../lib/cli/inference-set-help";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

// Sandbox-first mirror of the global inference:set command; both delegate to
// the shared runInferenceSet action. Flags only enforce the non-empty contract
// here — deep validation (provider allowlist, model id charset, custom endpoint
// URL/credential/API normalization) is intentionally centralized in
// runInferenceSet so the global and sandbox-first grammars share one
// validation surface (covered by test/lib/actions/inference-set.test.ts).
export default class SandboxInferenceSetCommand extends NemoClawCommand {
  static id = "sandbox:inference:set";
  static strict = true;
  static summary = "Switch the NemoClaw inference model";
  static description =
    "Update the OpenShell inference route and sync the named OpenClaw or Hermes sandbox config. Mirrors `inference set --sandbox <name>` with the sandbox name in sandbox-first position.";
  static usage = [
    "<name> inference set --provider <provider> --model <model> [--no-verify] [--endpoint-url <url>] [--credential-env <ENV>] [--inference-api <api>]",
  ];
  static examples = [
    "<%= config.bin %> my-assistant inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b",
    "<%= config.bin %> my-assistant inference set --provider openai-api --model gpt-5.4",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    provider: nonEmptyFlag("OpenShell inference provider name"),
    model: nonEmptyFlag("Model id to route through the selected provider"),
    "no-verify": Flags.boolean({
      description: "Pass --no-verify through to openshell inference set",
    }),
    "endpoint-url": Flags.string({
      description: "Trusted endpoint URL to persist when switching to a compatible custom provider",
    }),
    "credential-env": Flags.string({
      description:
        "Trusted credential env name to persist when switching to a compatible custom provider",
    }),
    "inference-api": Flags.string({
      description:
        "Trusted API family to persist for compatible custom providers (openai-completions, anthropic-messages, openai-responses)",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxInferenceSetCommand);
    if (!flags.provider || !flags.model) {
      this.printRequiredFlags();
      return;
    }
    try {
      await runInferenceSet({
        provider: flags.provider,
        model: flags.model,
        sandboxName: args.sandboxName,
        noVerify: flags["no-verify"] === true,
        endpointUrl: flags["endpoint-url"] ?? null,
        credentialEnv: flags["credential-env"] ?? null,
        inferenceApi: flags["inference-api"] ?? null,
      });
    } catch (error) {
      if (error instanceof InferenceSetError) {
        this.failWithLines([error.message], error.exitCode);
        return;
      }
      throw error;
    }
  }

  private printRequiredFlags(): void {
    this.failWithLines(inferenceSetRequiredFlagsFailureLines("<name> inference set"));
  }
}
