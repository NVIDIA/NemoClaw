// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { runSandboxDoctor } from "../../lib/actions/sandbox/doctor";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { withStdoutRedirectedToStderr } from "../../lib/cli/stdout-guard";
import { redactForLog } from "../../lib/security/redact";

export default class SandboxDoctorCliCommand extends NemoClawCommand {
  static id = "sandbox:doctor";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Diagnose sandbox and gateway health";
  static description =
    "Run host, gateway, sandbox, inference, messaging, and local service diagnostics.";
  static usage = ["<name> [--json] [--fix]"];
  static examples = [
    "<%= config.bin %> sandbox doctor alpha",
    "<%= config.bin %> sandbox doctor alpha --json",
    "<%= config.bin %> sandbox doctor alpha --fix",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    fix: Flags.boolean({
      description:
        "Restore the mutable OpenClaw config permission contract if `openclaw doctor --fix` tightened it, and approve pending allowlisted dashboard/CLI tool-scope upgrades",
      default: false,
      // `--fix` mutates sandbox permissions; keep it out of the machine-readable
      // `--json` readiness-gate path so automation cannot trigger a silent repair.
      exclusive: ["json"],
    }),
  };

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(SandboxDoctorCliCommand);
    const json = this.jsonEnabled();
    if (json) {
      // `--fix` is mutually exclusive with `--json` (enforced above), so the
      // JSON path is always read-only. Redirect any stray stdout to stderr so
      // the report stays the only thing on stdout.
      const report = await withStdoutRedirectedToStderr(() =>
        runSandboxDoctor(args.sandboxName, ["--json"], { quietJson: true }),
      );
      if (report && report.failed > 0) process.exitCode = 1;
      // Parity with `sandbox status --json` (#4310): redact the returned
      // report itself so programmatic consumers of the resolved value — not
      // just the logJson-printed stdout (#3657) — never see token-shaped
      // values in check details.
      return redactForLog(report);
    }
    const doctorArgs = flags.fix ? ["--fix"] : [];
    await runSandboxDoctor(args.sandboxName, doctorArgs, { quietJson: false });
  }
}
