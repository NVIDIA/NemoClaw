// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { quarantineSandbox } from "../../lib/actions/sandbox/quarantine/index";
import { NemoClawSandboxCommand } from "../../lib/cli/nemoclaw-sandbox-command";

export default class SandboxQuarantineCommand extends NemoClawSandboxCommand {
  static id = "sandbox:quarantine";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Fence and stop a sandbox without deleting its evidence";
  static description =
    "Persist a restart fence before stopping messaging, dashboard access, and the runtime workload. Partial failures leave the fence active and do not roll back completed stops.";
  static usage = ["<name> --reason <text> [--idempotency-key <key>] [--json]"];
  static examples = [
    '<%= config.bin %> alpha quarantine --reason "incident investigation"',
    '<%= config.bin %> sandbox quarantine alpha --reason "incident investigation" --idempotency-key incident-42',
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    reason: Flags.string({
      description: "Operator reason; the receipt stores only its SHA-256 digest",
      required: true,
    }),
    "idempotency-key": Flags.string({
      description: "Retry identity; the receipt stores only its SHA-256 digest",
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxQuarantineCommand);
    const generatedIdempotencyKey = flags["idempotency-key"] === undefined;
    const publishGeneratedIdempotencyKey = (key: string): void => {
      console.error(`  Idempotency key: ${key}`);
      console.error("  Save this key to reconcile the same request after an interruption.");
    };
    const request = {
      reason: flags.reason,
      idempotencyKey: flags["idempotency-key"],
    };
    const result = this.jsonEnabled()
      ? quarantineSandbox(args.sandboxName, request, {
          log: () => {},
          publishGeneratedIdempotencyKey,
        })
      : generatedIdempotencyKey
        ? quarantineSandbox(args.sandboxName, request, { publishGeneratedIdempotencyKey })
        : quarantineSandbox(args.sandboxName, request);
    this.setExitCode(result.exitCode);
    if (this.jsonEnabled()) return result;
    console.log(`  ${result.message}`);
    if (result.outcomes) {
      console.log(`  Execution observation: ${result.outcomes.executionObservation}`);
      console.log(`  Sandbox access observation: ${result.outcomes.sandboxAccessObservation}`);
      console.log(`  Service access stop: ${result.outcomes.serviceAccessStop}`);
      console.log("  Workspace: preserved");
    }
    if (result.fenceId) console.log(`  Fence: ${result.fenceId}`);
    if (result.receiptPath) console.log(`  Receipt: ${result.receiptPath}`);
  }
}
