// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { assertHermesReloadRollback } from "../live/mcp-bridge-hermes-lifecycle.ts";

function sandboxWithInspectionState(state: string): SandboxClient {
  return new SandboxClient({
    run: async () => ({
      command: ["openshell"],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${JSON.stringify({ ok: true, state })}\n`,
      stderr: "",
      artifacts: {
        stdout: "/tmp/stdout",
        stderr: "/tmp/stderr",
        result: "/tmp/result",
      },
    }),
  });
}

describe("Hermes MCP live rollback inspection", () => {
  it("accepts the managed inspection helper's matched result", async () => {
    await expect(
      assertHermesReloadRollback(
        sandboxWithInspectionState("matched"),
        "hermes-e2e",
        "https://mcp.example.test",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects the internal integrity state's current label", async () => {
    await expect(
      assertHermesReloadRollback(
        sandboxWithInspectionState("current"),
        "hermes-e2e",
        "https://mcp.example.test",
      ),
    ).rejects.toMatchObject({
      actual: { ok: true, state: "current" },
      expected: { ok: true, state: "matched" },
    });
  });
});
