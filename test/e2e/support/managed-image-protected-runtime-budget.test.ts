// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import {
  protectedRuntimeDeadlines,
  protectedRuntimeDeadlineHost,
  PROTECTED_RUNTIME_CLEANUP_MS,
  PROTECTED_RUNTIME_EVIDENCE_MS,
  PROTECTED_RUNTIME_JOB_MINUTES,
  PROTECTED_RUNTIME_ROLLBACK_MS,
  PROTECTED_RUNTIME_RUNNER_HEADROOM_MS,
} from "../live/managed-image-protected-runtime-budget.ts";

const MINUTE = 60_000;
const START = 1_700_000_000_000;
const result: ShellProbeResult = {
  command: ["test"],
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  artifacts: { stdout: "stdout", stderr: "stderr", result: "command-result.json" },
};

it("charges setup to the job budget and reserves rollback, cleanup, and evidence within 75 minutes", () => {
  const setup = 12 * MINUTE;
  const deadlines = protectedRuntimeDeadlines(String(START), START + setup);
  expect(deadlines.providers - START).toBe(45 * MINUTE);
  expect(deadlines.rollback - deadlines.providers).toBe(PROTECTED_RUNTIME_ROLLBACK_MS);
  expect(deadlines.testTimeoutMs).toBe(48 * MINUTE);
  expect(
    setup +
      deadlines.testTimeoutMs +
      PROTECTED_RUNTIME_CLEANUP_MS +
      PROTECTED_RUNTIME_EVIDENCE_MS +
      PROTECTED_RUNTIME_RUNNER_HEADROOM_MS,
  ).toBe(PROTECTED_RUNTIME_JOB_MINUTES * MINUTE);
});

it.each([undefined, "", "0", "NaN", "Infinity", "-1", String(START + 1)])(
  "rejects an unavailable or invalid job-start timestamp %s",
  (value) => expect(() => protectedRuntimeDeadlines(value, START)).toThrow("job start"),
);

it("bounds nine slow serial transactions before they consume rollback or cleanup time", async () => {
  let now = START + 12 * MINUTE;
  const deadlines = protectedRuntimeDeadlines(String(START), now);
  const command = vi.fn(
    async (_command: string, _args: string[], options: ShellProbeRunOptions) => {
      const duration = Math.min(420_000, options.timeoutMs!);
      now += duration;
      return { ...result, timedOut: duration < 420_000 };
    },
  );
  const host = protectedRuntimeDeadlineHost({ command }, deadlines.providers, () => now);
  await host.command("qualification-1", [], { timeoutMs: 10 * MINUTE });
  await host.command("qualification-2", [], { timeoutMs: 10 * MINUTE });
  await host.command("qualification-3", [], { timeoutMs: 10 * MINUTE });
  await host.command("qualification-4", [], { timeoutMs: 10 * MINUTE });
  await expect(host.command("qualification-5", [], { timeoutMs: 10 * MINUTE })).rejects.toThrow(
    "exceeded its budget",
  );
  expect(command).toHaveBeenCalledTimes(5);
  expect(now).toBeLessThan(deadlines.providers);
  expect(deadlines.rollback - now).toBeGreaterThanOrEqual(PROTECTED_RUNTIME_ROLLBACK_MS);
});

it("keeps shorter command guards and gives rollback its separate reserved window", async () => {
  const deadlines = protectedRuntimeDeadlines(String(START), START);
  const command = vi.fn().mockResolvedValue(result);
  const providers = protectedRuntimeDeadlineHost(
    { command },
    deadlines.providers,
    () => deadlines.providers,
  );
  await expect(providers.command("late-provider")).rejects.toThrow("deadline exhausted");
  expect(command).not.toHaveBeenCalled();
  const rollback = protectedRuntimeDeadlineHost(
    { command },
    deadlines.rollback,
    () => deadlines.providers,
  );
  await rollback.command("rollback", [], { timeoutMs: 30_000 });
  expect(command).toHaveBeenCalledWith(
    "rollback",
    [],
    expect.objectContaining({ timeoutMs: 30_000 }),
  );
});

it("rejects a command that finishes after the shared deadline even when it exits zero", async () => {
  const now = vi
    .fn()
    .mockReturnValueOnce(START)
    .mockReturnValue(START + MINUTE);
  const command = vi.fn().mockResolvedValue(result);
  const host = protectedRuntimeDeadlineHost({ command }, START + MINUTE, now);
  await expect(host.command("slow-success")).rejects.toThrow("exceeded its budget");
});

it("refuses late setup before qualification can register or mutate runtime resources", () => {
  expect(() => protectedRuntimeDeadlines(String(START), START + 45 * MINUTE)).toThrow(
    "setup exhausted",
  );
});
