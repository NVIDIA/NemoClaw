// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";

import * as dispatch from "../../src/lib/actions/sandbox/agent/passthrough-dispatch";
import { runAgentJsonPassthrough } from "../../src/lib/actions/sandbox/agent/passthrough-json";

describe("runAgentJsonPassthrough tool call failure", () => {
  it("treats a zero-exit tool call failure as an error", async () => {
    // Mock the OpenClaw dispatch to return a zero-exit with "Tool Call failed" output.
    vi.spyOn(dispatch, "runOpenClawAgentDispatch").mockResolvedValue({
      outcome: { kind: "exited", exitCode: 0 },
      stdout: "Tool Call failed\n",
      stderr: "",
    } as any);

    const proc = {
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    } as any;

    const command = ["openclaw", "agent", "--agent", "main", "--json"];
    await expect(runAgentJsonPassthrough("alpha", command, proc)).rejects.toThrow("exit:1");
  });
});
