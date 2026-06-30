// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

function nonEmptyFlag(description: string) {
  return Flags.string({
    description,
    parse: async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) throw new Error(`${description} cannot be empty`);
      return trimmed;
    },
  });
}

import { InferenceSetError, runInferenceSet } from "../../lib/actions/inference-set";
import { CLI_NAME } from "../../lib/cli/branding";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class InferenceSetCommand extends NemoClawCommand {
  static id = "inference:set";
  static strict = true;
  static summary = "Switch the NemoClaw inference model";
  static description =
    "Update the OpenShell inference route and sync the running OpenClaw or Hermes sandbox config.";
  static usage = [
    "inference set --provider <provider> --model <model> [--sandbox <name>] [--no-verify] [--endpoint-url <url>] [--credential-env <ENV>] [--inference-api <api>]",
  ];
  static examples = [
    "<%= config.bin %> inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b",
    "<%= config.bin %> inference set --provider openai-api --model gpt-5.4 --sandbox my-assistant",
  ];
  static flags = {
    provider: nonEmptyFlag("OpenShell inference provider name"),
    model: nonEmptyFlag("Model id to route through the selected provider"),
    sandbox: Flags.string({
      description:
        "Registered sandbox to sync; defaults to the NemoClaw default sandbox or the unambiguous Hermes sandbox under nemohermes",
    }),
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
    const { flags } = await this.parse(InferenceSetCommand);
    if (!flags.provider || !flags.model) {
      this.printOpenShellRedirect();
      return;
    }
    try {
      await runInferenceSet({
        provider: flags.provider,
        model: flags.model,
        sandboxName: flags.sandbox ?? null,
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

  private printOpenShellRedirect(): void {
    this.failWithLines(
      [
        `  Unknown ${CLI_NAME} command: inference set`,
        "",
        "  This operation belongs to OpenShell.",
        "  Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
        `  To also sync the running sandbox config, pass --provider and --model to ${CLI_NAME} inference set.`,
        "",
        `  Run '${CLI_NAME} help' for NemoClaw commands.`,
      ],
      1,
    );
  }
}
