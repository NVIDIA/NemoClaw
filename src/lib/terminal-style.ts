// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- presentation constants are covered through CLI subprocess tests. */

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

export const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
export const B = useColor ? "\x1b[1m" : "";
export const D = useColor ? "\x1b[2m" : "";
export const R = useColor ? "\x1b[0m" : "";
export const RD = useColor ? "\x1b[1;31m" : "";
export const YW = useColor ? "\x1b[1;33m" : "";
