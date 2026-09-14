// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { failLine } from "../cli/terminal-style";
import type { PortProbeResult } from "./preflight";

export interface PortConflictReportInput {
  port: number;
  label: string;
  envVar: string;
  portCheck: PortProbeResult;
}

export function formatPortConflictReport(input: PortConflictReportInput): string[] {
  const { port, label, envVar, portCheck } = input;
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
      "     To fix, verify that the same process still owns the port:",
      "",
      `       sudo lsof -i :${port} -sTCP:LISTEN -P -n`,
      // A service hint is not proof that the service still owns the listener:
      // after the standalone fallback runs, the gateway user service is
      // inactive while a standalone gateway holds the port, so its stop exits 0
      // and frees nothing (#11720). Make the port the success signal.
      "     Stop it through its service manager when one owns it, then recheck the port;",
      "     an inactive service reports success without releasing it.",
      "     Otherwise signal only the PID from that fresh check.",
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
