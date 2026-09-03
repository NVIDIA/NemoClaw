// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command } from "@oclif/core";
import { sendInstallerTelemetry } from "../../../lib/actions/telemetry/send";
import type { TelemetryOperation } from "../../../lib/domain/telemetry/event";

export default class InternalInstallerTelemetryCommand extends Command {
  static hidden = true;
  static strict = true;
  static summary = "Internal: send installer telemetry";
  static description = "Attempt the allowlisted completion event for a successful installer run.";
  static usage = ["internal installer telemetry <install|update>"];
  static examples = ["<%= config.bin %> internal installer telemetry install"];
  static args = {
    operation: Args.string({
      description: "Completed installer operation",
      options: ["install", "update"],
      required: true,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(InternalInstallerTelemetryCommand);
    await sendInstallerTelemetry(args.operation as TelemetryOperation);
  }
}
