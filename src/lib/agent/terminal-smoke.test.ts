// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "./defs";
import { runAgentSmokeCommands } from "./terminal-smoke";

describe("terminal agent smoke gateway scope", () => {
  it("pins every smoke exec to the owning OpenShell gateway (#8942)", () => {
    const capture = vi.fn((_args: string[]) => ({
      output: "NEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    }));

    expect(
      runAgentSmokeCommands(
        "alpha",
        loadAgent("langchain-deepagents-code"),
        capture,
        "nemoclaw-8091",
      ),
    ).toEqual({ ok: true });

    expect(capture).toHaveBeenCalled();
    for (const [args] of capture.mock.calls) {
      expect(args.slice(0, 7)).toEqual([
        "sandbox",
        "exec",
        "-n",
        "alpha",
        "-g",
        "nemoclaw-8091",
        "--",
      ]);
    }
  });
});
