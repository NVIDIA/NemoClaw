// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags, type Interfaces } from "@oclif/core";
import { redactDoctorReport, runGlobalDoctor } from "../lib/actions/sandbox/doctor";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { withStdoutRedirectedToStderr } from "../lib/cli/stdout-guard";

const OUTPUT_MODE_CONFLICT_MESSAGE =
  "--json and --text are mutually exclusive. Use one or the other.";
const OCLIF_OUTPUT_MODE_CONFLICT = "--json=true cannot also be provided when using --text";

/** Identify only the parser failure reported in #11150. */
function isOutputModeConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes(OCLIF_OUTPUT_MODE_CONFLICT);
}

/** Preserve the parser exit value without serializing its command context. */
function parserExit(error: unknown): number | undefined {
  const exit = (error as { oclif?: { exit?: unknown } } | null)?.oclif?.exit;
  return typeof exit === "number" ? exit : undefined;
}

export default class DoctorCommand extends NemoClawCommand {
  static id = "doctor";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Diagnose host and gateway health";
  static description =
    "Run read-only host, runtime provider, OpenShell CLI, sandbox registry, and NemoClaw gateway checks. Use `<name> doctor` for one sandbox.";
  static usage = ["doctor [--json|--text]"];
  static examples = [
    "<%= config.bin %> doctor",
    "<%= config.bin %> doctor --text",
    "<%= config.bin %> doctor --json",
  ];
  static flags = {
    text: Flags.boolean({
      description: "Emit the human-readable report explicitly",
      exclusive: ["json"],
    }),
  };

  protected override toErrorJson(error: unknown): unknown {
    if (!isOutputModeConflict(error)) return super.toErrorJson(error);
    const exit = parserExit(error);
    return {
      error: {
        message: OUTPUT_MODE_CONFLICT_MESSAGE,
        ...(exit === undefined ? {} : { exit }),
      },
    };
  }

  protected override async catch(error: Interfaces.CommandError): Promise<unknown> {
    if (this.jsonEnabled() && isOutputModeConflict(error)) {
      console.error(OUTPUT_MODE_CONFLICT_MESSAGE);
    }
    return await super.catch(error);
  }

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
