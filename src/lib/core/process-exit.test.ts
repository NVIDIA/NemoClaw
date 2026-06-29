// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { spawnExitCode } from "./process-exit";

describe("spawnExitCode", () => {
  it.each([
    ["zero status", { status: 0 }, 0],
    ["nonzero status", { status: 42 }, 42],
    ["status before signal", { status: 7, signal: "SIGTERM" }, 7],
    ["SIGTERM", { status: null, signal: "SIGTERM" }, 143],
    ["SIGKILL", { status: null, signal: "SIGKILL" }, 137],
    ["missing signal", { status: null }, 1],
    ["null signal", { status: null, signal: null }, 1],
    ["unknown signal", { status: null, signal: "SIGBOGUS" as NodeJS.Signals }, 1],
  ] satisfies Array<
    [string, Parameters<typeof spawnExitCode>[0], number]
  >)("normalizes %s (#5936)", (_label, result, expected) => {
    expect(spawnExitCode(result)).toBe(expected);
  });
});
