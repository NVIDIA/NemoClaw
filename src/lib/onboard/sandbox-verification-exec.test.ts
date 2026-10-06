// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { executeSandboxCommandForVerification } from "./sandbox-verification-exec";

describe("executeSandboxCommandForVerification", () => {
  it("runs the verification script through the selected gateway with a bounded timeout", async () => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 7 },
      stdout: " output \n",
      stderr: " warning \n",
    }));

    await expect(
      executeSandboxCommandForVerification("verify-box", "printf output", { runBuffered }),
    ).resolves.toEqual({ status: 7, stdout: "output", stderr: "warning" });
    expect(runBuffered).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "verify-box",
      target: { kind: "selected" },
      command: ["sh", "-c", "printf output"],
      timeoutMilliseconds: 15_000,
    });
  });

  it("maps typed transport failures and executor rejections to an unreachable result", async () => {
    await expect(
      executeSandboxCommandForVerification("verify-box", "true", {
        runBuffered: async () => ({
          outcome: {
            kind: "failed",
            error: { kind: "timeout", message: "timed out" },
          },
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBeNull();

    await expect(
      executeSandboxCommandForVerification("verify-box", "true", {
        runBuffered: async () => {
          throw new Error("spawn rejected");
        },
      }),
    ).resolves.toBeNull();
  });
});
