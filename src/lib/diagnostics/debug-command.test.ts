// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runDebugCommandWithOptions } from "../../../dist/lib/diagnostics/debug-command";

describe("debug command", () => {
  it("runs parsed debug options and falls back to the default sandbox", () => {
    const runDebug = vi.fn();
    runDebugCommandWithOptions(
      { quick: true, output: "/tmp/out.tgz" },
      {
        getDefaultSandbox: () => "alpha",
        runDebug,
      },
    );
    expect(runDebug).toHaveBeenCalledWith({
      quick: true,
      output: "/tmp/out.tgz",
      sandboxName: "alpha",
    });
  });
});
