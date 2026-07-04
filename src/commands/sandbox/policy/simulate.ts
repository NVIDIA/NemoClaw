// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";

import { Args, Flags } from "@oclif/core";

import { simulateSandboxPolicy } from "../../../lib/actions/sandbox/policy-simulate";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import { renderSimulationReport, summaryNeedsAttention } from "../../../lib/policy/simulate";

export default class PolicySimulateCommand extends NemoClawCommand {
  static id = "sandbox:policy:simulate";
  static strict = true;
  static summary = "Statically evaluate a recorded trace against registered policy content";
  static description =
    `Statically evaluate which network requests in a recorded trace match the sandbox's registered policy content (built-in presets plus custom and generated policies), or a candidate policy file.

The evaluation is fail-closed and covers host, port, method, and path only. A request is reported ALLOWED only when every evaluated dimension is proven from the trace row; policy constraints the engine does not evaluate (protocol, allowed_ips, TLS, ancestry, MCP, deny rules) and trace rows missing a constrained field produce UNKNOWN verdicts. Malformed trace rows are reported, not dropped. Live gateway state is not consulted, so drift between the registry and the gateway is not detected.

Trace files are JSONL, one JSON object per line with at minimum a "host" field:
  {"host":"api.slack.com","port":443,"method":"POST","path":"/api/chat.postMessage"}

Use --from-file to provide a recorded trace, or pipe requests to stdin.
Use --policy-file to evaluate a candidate policy YAML without applying it.
Exit code is non-zero when any request is blocked, uncovered, or unknown, or any trace row is invalid.`;

  static usage = ["<name> --from-file <trace.jsonl> [--policy-file <policy.yaml>] [--json]"];

  static examples = [
    "<%= config.bin %> sandbox policy simulate alpha --from-file ./agent-trace.jsonl",
    "<%= config.bin %> sandbox policy simulate alpha --policy-file ./slack.yaml --from-file ./trace.jsonl",
    "<%= config.bin %> sandbox policy simulate alpha --from-file ./trace.jsonl --json",
  ];

  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      ignoreStdin: true,
      required: true,
    }),
  };

  static flags = {
    "from-file": Flags.string({
      description:
        'Path to a JSONL trace file, or "-" to read from stdin. Each line: {"host":"...","port":443,"method":"GET","path":"/"}',
      required: true,
    }),
    "policy-file": Flags.string({
      description:
        "Path to a candidate policy YAML file to test instead of the active sandbox policy. Useful for previewing a policy before applying it.",
      required: false,
    }),
    "preset-name": Flags.string({
      description:
        "Name to assign to the candidate presets when --policy-file is used. When omitted, preset names from the YAML file are kept.",
      required: false,
    }),
    json: Flags.boolean({
      description: "Output simulation results as JSON",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(PolicySimulateCommand);

    const stdinLines = flags["from-file"] === "-" ? await readStdin() : undefined;

    const result = simulateSandboxPolicy({
      sandboxName: args.sandboxName,
      fromFile: flags["from-file"],
      policyFile: flags["policy-file"],
      presetName: flags["preset-name"],
      stdinLines,
    });

    if (result.kind === "error") {
      this.failWithLines(result.lines);
      return;
    }

    const report = flags.json
      ? JSON.stringify({ ...result.summary, notes: result.notes }, null, 2)
      : renderSimulationReport(result.summary, false);
    process.stdout.write(report + (report.endsWith("\n") ? "" : "\n"));
    if (!flags.json) {
      for (const note of result.notes) {
        console.error(`  Note: ${note}`);
      }
    }

    if (summaryNeedsAttention(result.summary)) {
      this.setExitCode(1);
    }
  }
}

async function readStdin(): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    if (process.stdin.isTTY) {
      resolve([]);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
  });
}
