// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SECURITY_RESOURCE_LIMIT_DIAGNOSTIC =
  /\[SECURITY\][^\r\n]*(?:resource limits?|nproc|nofile)/iu;
const RESOURCE_LIMIT_PROBE_TOKEN =
  /__NEMOCLAW_RLIMIT_CONNECT_(?:BEGIN|END)__|(?:login|interactive)_(?:nproc|nofile)_(?:soft|hard)=\d+|(?:login|interactive)_raise_(?:nproc|nofile)=\d+/gu;

export function containsSecurityResourceLimitDiagnostic(output: string): boolean {
  return SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.test(output);
}

export function resourceLimitOutputFilterScript(): string {
  return [
    '"use strict";',
    'const readline = require("node:readline");',
    `const diagnostic = new RegExp(${JSON.stringify(SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.source)}, ${JSON.stringify(SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.flags)});`,
    `const probeToken = new RegExp(${JSON.stringify(RESOURCE_LIMIT_PROBE_TOKEN.source)}, ${JSON.stringify(RESOURCE_LIMIT_PROBE_TOKEN.flags)});`,
    "let diagnosticFound = false;",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    'lines.on("line", (line) => {',
    "  if (diagnostic.test(line)) diagnosticFound = true;",
    "  for (const match of line.matchAll(probeToken)) {",
    '    process.stdout.write(match[0] + "\\n");',
    "  }",
    "});",
    'lines.on("close", () => {',
    '  process.stdout.write("resource_limit_diagnostic=" + (diagnosticFound ? "1" : "0") + "\\n");',
    "});",
  ].join("\n");
}
