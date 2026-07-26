// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { failLine } from "../cli/terminal-style";
import type { PortProbeResult } from "./preflight";

export interface PortConflictReportInput {
  port: number;
  label: string;
  envVar: string;
  portCheck: PortProbeResult;
  serviceHints?: string[];
}

export function formatPortConflictReport(input: PortConflictReportInput): string[] {
  const { port, label, envVar, portCheck, serviceHints = [] } = input;
  const lines = [
    "",
    failLine(`Port ${port} is not available.`),
    `     ${label} needs this port.`,
    "",
  ];

  if (portCheck.process && portCheck.process !== "unknown") {
    lines.push(
      `     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`,
      "",
      "     To fix, stop the conflicting process:",
      "",
      portCheck.pid
        ? `       sudo kill ${portCheck.pid}`
        : `       sudo lsof -i :${port} -sTCP:LISTEN -P -n`,
      ...serviceHints,
    );
  } else {
    lines.push(
      `     Could not identify the process using port ${port}.`,
      `     Run: sudo lsof -i :${port} -sTCP:LISTEN`,
    );
  }

  lines.push(
    "",
    "     Or rerun with a different port:",
    `       ${envVar}=<port> nemoclaw onboard`,
    "",
    `     Detail: ${portCheck.reason}`,
  );

  return lines;
}

export function printPortConflictReport(
  input: PortConflictReportInput,
  writeError: (line: string) => void = console.error,
): void {
  for (const line of formatPortConflictReport(input)) {
    writeError(line);
  }
}
