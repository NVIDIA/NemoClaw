// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Command } from "@oclif/core";

import { runSandboxDoctor } from "./sandbox-doctor-action";

export default class SandboxDoctorCliCommand extends Command {
  static id = "sandbox:doctor";
  static strict = false;
  static summary = "Diagnose sandbox and gateway health";
  static description = "Run host, gateway, sandbox, inference, messaging, and local service diagnostics.";
  static usage = ["<name> doctor [--json]"];

  public async run(): Promise<void> {
    const [sandboxName, ...actionArgs] = this.argv;
    await runSandboxDoctor(sandboxName, actionArgs);
  }
}
