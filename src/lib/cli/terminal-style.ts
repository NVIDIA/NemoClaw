// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
 * Preflight result line helpers (#6004). Render a warning (`⚠`) line in yellow
 * and a failure (`✗`) line in red so they stand out from the default-colored
 * `✓`/INFO lines in the lengthy onboard preflight output. Color is suppressed
 * automatically when `NO_COLOR` is set or stdout is not a TTY (via `YW`/`RD`/`R`
 * being empty strings), so CI output stays plain text.
 */
export function warnLine(message: string): string {
  return `  ${YW}⚠ ${message}${R}`;
}

export function failLine(message: string): string {
  return `  ${RD}✗ ${message}${R}`;
}
