// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { styleText } from "node:util";

/**
 * Legacy color constants (`G`, `B`, `D`, `R`, `RD`, `YW`) are frozen at module
 * import time; import after `NO_COLOR` and TTY state are configured. Prefer the
 * call-time severity helpers below for new output. The constants intentionally
 * retain their historical raw ANSI values, while new output uses `styleText`
 * so color capability is evaluated for the destination stream at call time.
 */
const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

export const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
export const B = useColor ? "\x1b[1m" : "";
export const D = useColor ? "\x1b[2m" : "";
export const R = useColor ? "\x1b[0m" : "";
export const RD = useColor ? "\x1b[1;31m" : "";
export const YW = useColor ? "\x1b[1;33m" : "";

// WARN and ERROR lines are emitted on stderr. `styleText({ stream })` therefore
// keys color off stderr's capability and honors NO_COLOR / NODE_DISABLE_COLORS /
// FORCE_COLOR (#6004). The old output keyed color off stdout, which dropped
// color on `onboard >log` and leaked ANSI into `onboard 2>log`.
function stderrSeverityLine(
  marker: "⚠ " | "✗ ",
  format: "yellow" | "red",
  message: string,
): string {
  const line = `${marker}${message}`;
  return `  ${process.env.NO_COLOR ? line : styleText(format, line, { stream: process.stderr })}`;
}

export const warnLine = (message: string): string => stderrSeverityLine("⚠ ", "yellow", message);
export const failLine = (message: string): string => stderrSeverityLine("✗ ", "red", message);
