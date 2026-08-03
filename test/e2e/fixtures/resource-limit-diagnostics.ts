// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SECURITY_RESOURCE_LIMIT_DIAGNOSTIC =
  /\[SECURITY\][^\r\n]*(?:resource limits?|nproc|nofile)/iu;
const RESOURCE_LIMIT_PROBE_FIELD =
  /^(?:login|interactive)_(?:(?:nproc|nofile)_(?:soft|hard)|raise_(?:nproc|nofile))=\d+$/u;

export const RESOURCE_LIMIT_CONNECT_BEGIN_MARKER = "__NEMOCLAW_RLIMIT_CONNECT_BEGIN__";
export const RESOURCE_LIMIT_CONNECT_END_MARKER = "__NEMOCLAW_RLIMIT_CONNECT_END__";

export function containsSecurityResourceLimitDiagnostic(output: string): boolean {
  return SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.test(output);
}

export function resourceLimitOutputFilterScript(): string {
  return [
    '"use strict";',
    'const readline = require("node:readline");',
    `const diagnostic = new RegExp(${JSON.stringify(SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.source)}, ${JSON.stringify(SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.flags)});`,
    `const probeField = new RegExp(${JSON.stringify(RESOURCE_LIMIT_PROBE_FIELD.source)}, ${JSON.stringify(RESOURCE_LIMIT_PROBE_FIELD.flags)});`,
    `const beginMarker = ${JSON.stringify(RESOURCE_LIMIT_CONNECT_BEGIN_MARKER)};`,
    `const endMarker = ${JSON.stringify(RESOURCE_LIMIT_CONNECT_END_MARKER)};`,
    "let diagnosticFound = false;",
    "let frameComplete = false;",
    "let frameOpen = false;",
    "let protocolError = false;",
    "const seenFields = new Set();",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    'lines.on("line", (line) => {',
    "  if (diagnostic.test(line)) diagnosticFound = true;",
    "  if (line === beginMarker) {",
    "    if (frameOpen || frameComplete) protocolError = true;",
    "    else {",
    "      frameOpen = true;",
    '      process.stdout.write(beginMarker + "\\n");',
    "    }",
    "    return;",
    "  }",
    "  if (line === endMarker) {",
    "    if (!frameOpen || frameComplete) protocolError = true;",
    "    else {",
    "      frameOpen = false;",
    "      frameComplete = true;",
    '      process.stdout.write(endMarker + "\\n");',
    "    }",
    "    return;",
    "  }",
    "  if (line.includes(beginMarker) || line.includes(endMarker)) {",
    "    protocolError = true;",
    "    return;",
    "  }",
    "  if (!probeField.test(line)) return;",
    "  if (!frameOpen || frameComplete) {",
    "    protocolError = true;",
    "    return;",
    "  }",
    '  const key = line.slice(0, line.indexOf("="));',
    "  if (seenFields.has(key)) protocolError = true;",
    "  seenFields.add(key);",
    '  process.stdout.write(line + "\\n");',
    "});",
    'lines.on("close", () => {',
    "  if (frameOpen || !frameComplete) protocolError = true;",
    '  process.stdout.write("resource_limit_diagnostic=" + (diagnosticFound ? "1" : "0") + "\\n");',
    '  process.stdout.write("resource_limit_protocol_error=" + (protocolError ? "1" : "0") + "\\n");',
    "});",
  ].join("\n");
}
