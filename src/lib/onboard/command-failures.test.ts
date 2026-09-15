// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runOnboardCommand } from "./command";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboarding command failures", () => {
  it("re-throws a non-cancellation, non-gateway error so genuine bugs still surface (#7627)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("unexpected boom");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("unexpected boom");
  });

  it("returns without rethrowing and preserves exit code 130 when a prompt rejects with SIGINT (#7439, #11039)", async () => {
    const exit = vi.fn<(code: number) => never>();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(
        runOnboardCommand({
          flags: {},
          env: {},
          runOnboard: async () => {
            throw Object.assign(new Error("Prompt interrupted"), {
              code: "SIGINT",
            });
          },
          error: () => {},
          exit,
        }),
      ).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
      // The signal handler cannot publish 130 when the process drains before
      // asynchronous signal delivery, as at the agent-selection prompt.
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rethrows non-cancellation onboarding failures unchanged (#5976)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("docker is not reachable");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("docker is not reachable");
  });
});
