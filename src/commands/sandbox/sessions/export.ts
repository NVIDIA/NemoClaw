// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { exportSandboxSessions } from "../../../lib/actions/sandbox/sessions/export";
import { CLI_NAME } from "../../../lib/cli/branding";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class SandboxSessionsExportCommand extends NemoClawCommand {
  static id = "sandbox:sessions:export";
  static strict = false;
  // #5510: keep oclif from treating an option-shaped positional (e.g. a session
  // key typo like `-mytypo`) as a NonExistentFlag. With `'--' = false`, unknown
  // `-`-prefixed tokens fall through to argv so the stray-dash guard in run()
  // can emit actionable guidance instead of oclif's raw "Nonexistent flag".
  static "--" = false;
  static summary = "Export agent session JSONL out of a running sandbox";
  static description = [
    "Routes by the sandbox's agent kind, recorded in the registry.",
    "",
    "OpenClaw sandbox: tar the per-session JSONL files inside the sandbox and",
    "download the bundle to the host via `openshell sandbox download`. By default",
    "every session for the agent is exported; pass one or more positional keys to",
    "filter. Keys may be either an alias (e.g. `main`, `telegram:t-1`) or the",
    "canonical `agent:<id>:<rest>` form. Use --agent to scope aliases to a",
    "non-default agent; mismatched --agent + canonical-key combinations are",
    "refused. Trajectory files are excluded by default (large) and re-added with",
    "--include-trajectory.",
    "",
    "Hermes sandbox: invoke the in-sandbox `hermes sessions export` against a",
    "staging path under /sandbox/.nemoclaw-staging, then download the resulting",
    "single JSONL stream to the host. Hermes stores the session history in a",
    "SQLite database, so positional keys, --format tar, and --include-trajectory",
    "are OpenClaw-only and are rejected with a clear error when the sandbox is",
    "Hermes. --agent accepts only `hermes` (a no-op alias) on a Hermes sandbox",
    "and rejects any other value. The host destination defaults to",
    "./sessions-<sandbox>.jsonl; --out picks a different path.",
    "",
    "Note: session JSONL can contain pasted secrets (API keys, tokens). The",
    "downloaded bundle is written owner-only (0600); keep it private and avoid",
    "committing or sharing it without review.",
  ].join("\n");
  static usage = [
    "<name> [keys...] [--agent <id>] [--format <dir|tar>] [--out <path>] [--include-trajectory] [--json]",
  ];
  static examples = [
    "<%= config.bin %> sandbox sessions export alpha",
    "<%= config.bin %> sandbox sessions export alpha main --agent main",
    "<%= config.bin %> sandbox sessions export alpha agent:work:telegram:t-1 --include-trajectory",
    "<%= config.bin %> sandbox sessions export alpha --format tar --out ./bundles/alpha.tgz --json",
  ];
  static flags = {
    agent: Flags.string({
      description: "Agent id when keys are aliases rather than canonical form.",
    }),
    format: Flags.string({
      description:
        "Output format: 'dir' (default) writes a directory of session files; 'tar' writes a single .tgz bundle for sharing/upload.",
      options: ["dir", "tar"],
      default: "dir",
    }),
    out: Flags.string({
      description:
        "Host destination. Defaults to ./sessions-<sandbox>/ for dir format, or ./sessions-<sandbox>-<agent>.tgz for tar format.",
    }),
    "include-trajectory": Flags.boolean({
      description: "Include the (large) trajectory.jsonl files in the export.",
      default: false,
    }),
    json: Flags.boolean({
      description: "Print the export manifest as JSON instead of a status line.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags, argv } = await this.parse(SandboxSessionsExportCommand);
    const [sandboxName, ...rest] = argv as string[];
    if (!sandboxName) {
      this.failWithLines([`  Usage: ${SandboxSessionsExportCommand.usage[0]}`], 2);
      return;
    }
    const stray = rest.filter((token) => token.startsWith("-"));
    if (stray.length > 0) {
      const lines = [
        `  Unknown flag or option-shaped key: ${stray.join(", ")}`,
        "  Session keys must not start with '-'. Place flags after the sandbox name.",
      ];
      const deDashed = stray.map((token) => token.replace(/^-+/, "")).filter(Boolean);
      if (deDashed.length > 0) {
        lines.push(
          `  Did you mean: ${CLI_NAME} ${sandboxName} sessions export ${deDashed.join(" ")}?`,
        );
      }
      this.failWithLines(lines, 2);
      return;
    }
    try {
      await exportSandboxSessions({
        sandboxName,
        agent: flags.agent,
        keys: rest,
        format: flags.format === "tar" ? "tar" : "dir",
        out: flags.out,
        includeTrajectory: flags["include-trajectory"],
        json: flags.json,
      });
    } catch (error) {
      this.failWithLines([`  ${(error as Error).message}`], 1);
    }
  }
}
