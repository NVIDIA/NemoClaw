// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactDoctorReport, runGlobalDoctor } from "../lib/actions/sandbox/doctor";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { withStdoutRedirectedToStderr } from "../lib/cli/stdout-guard";

export default class DoctorCommand extends NemoClawCommand {
  static id = "doctor";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Diagnose host and gateway health";
  static description =
    "Run read-only host, runtime provider, OpenShell CLI, sandbox registry, and NemoClaw gateway checks. Use `<name> doctor` for one sandbox.";
  static usage = ["doctor [--json]"];
  static examples = ["<%= config.bin %> doctor", "<%= config.bin %> doctor --json"];
  static flags = {};

  public async run(): Promise<unknown> {
    await this.parse(DoctorCommand);
    const json = this.jsonEnabled();
    const report = json
      ? await withStdoutRedirectedToStderr(() => runGlobalDoctor({ quiet: true }))
      : await runGlobalDoctor();
    if (report.failed > 0) process.exitCode = 1;
    return json ? redactDoctorReport(report) : undefined;
  }
}
