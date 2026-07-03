// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { styleText } from "node:util";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

export const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
export const B = useColor ? "\x1b[1m" : "";
export const D = useColor ? "\x1b[2m" : "";
export const R = useColor ? "\x1b[0m" : "";
export const RD = useColor ? "\x1b[1;31m" : "";
export const YW = useColor ? "\x1b[1;33m" : "";

/**
 * Semantic severity levels for onboard preflight output (#6004).
 *
 * `info` keeps the default terminal color; `ok`/`warn`/`error` add a colored
 * marker so warnings and failures stand out in the lengthy preflight output.
 */
export type SeverityLevel = "info" | "ok" | "warn" | "error";

type SeverityStyle = {
  marker: string;
  format: "green" | "yellow" | "red" | null;
  stream: NodeJS.WriteStream;
};

// The stream each level is written to decides its color. `ok`/`info` are
// emitted on stdout (`console.log`/`console.info`); `warn`/`error` on stderr
// (`console.warn`/`console.error`). `styleText({ stream })` then keys color off
// that stream's own capability and honors NO_COLOR / NODE_DISABLE_COLORS /
// FORCE_COLOR (#6004). This replaces the previous helpers, which colored from
// `process.stdout.isTTY` while printing to stderr — so redirecting either
// stream independently mis-styled the other (dropped color on `onboard >log`,
// leaked ANSI into `onboard 2>log`).
const SEVERITY_STYLES: Record<SeverityLevel, SeverityStyle> = {
  info: { marker: "", format: null, stream: process.stdout },
  ok: { marker: "✓ ", format: "green", stream: process.stdout },
  warn: { marker: "⚠ ", format: "yellow", stream: process.stderr },
  error: { marker: "✗ ", format: "red", stream: process.stderr },
};

/**
 * Render one indented preflight line at `level`. The returned string is meant
 * to be passed to the matching console method (`ok`/`info` → `console.log` /
 * `console.info`; `warn` → `console.warn`; `error` → `console.error`) so its
 * color decision matches the stream it lands on.
 */
export function severityLine(level: SeverityLevel, message: string): string {
  const { marker, format, stream } = SEVERITY_STYLES[level];
  const body = `${marker}${message}`;
  return `  ${format ? styleText(format, body, { stream }) : body}`;
}

export const infoLine = (message: string): string => severityLine("info", message);
export const okLine = (message: string): string => severityLine("ok", message);
export const warnLine = (message: string): string => severityLine("warn", message);
export const failLine = (message: string): string => severityLine("error", message);
