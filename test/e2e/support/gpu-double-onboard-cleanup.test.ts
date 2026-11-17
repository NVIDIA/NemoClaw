// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ test: vi.fn(), cleanupOllama: vi.fn() }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: captured.test,
}));
vi.mock("../live/gpu-e2e-ollama.ts", () => ({ cleanupOllama: captured.cleanupOllama }));

beforeEach(() => {
  vi.resetModules();
  captured.test.mockReset();
  captured.cleanupOllama.mockReset();
  vi.stubEnv("NEMOCLAW_CLI_BIN", "/fixture/nemoclaw");
});

async function runCleanupPaths() {
  await import("../live/gpu-double-onboard.test.ts");
  const run = captured.test.mock.calls[0]![2] as (fixtures: object) => Promise<void>;
  const stop = new Error("stop before onboarding");
  const disposables = new Map<string, () => Promise<void>>();
  const host = { command: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }) };
  const execution = run({
    artifacts: { target: { declare: vi.fn() } },
    runtimeProvider: { requireAvailable: vi.fn() },
    host,
    sandbox: { openshell: vi.fn().mockResolvedValue({ exitCode: 0 }) },
    cleanup: {
      trackDisposable: (name: string, dispose: () => Promise<void>) =>
        disposables.set(name, dispose),
      trackGateway: vi.fn(),
      trackSandbox: vi.fn(),
    },
    progress: {
      phase: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockImplementationOnce(() => {
          throw stop;
        }),
    },
    skip: vi.fn(),
  });
  await expect(execution).rejects.toBe(stop);
  const dispose = disposables.get("stop gpu double-onboard Ollama processes")!;
  return { host, dispose };
}

it("accepts successful shared cleanup in double-onboard setup and disposal", async () => {
  captured.cleanupOllama.mockResolvedValue({ exitCode: 0 });
  const { host, dispose } = await runCleanupPaths();
  expect(captured.cleanupOllama.mock.calls).toEqual([
    [host, "pre-cleanup-ollama-processes"],
    [host, "phase-1-stop-preexisting-ollama"],
  ]);
  await expect(dispose()).resolves.toBeUndefined();
  expect(captured.cleanupOllama).toHaveBeenLastCalledWith(host, "cleanup-ollama-processes");
});

it("retains best-effort setup and rejects failed double-onboard disposal", async () => {
  captured.cleanupOllama.mockResolvedValue({ exitCode: 17, stdout: "", stderr: "service failed" });
  const { host, dispose } = await runCleanupPaths();
  expect(captured.cleanupOllama.mock.calls).toEqual([
    [host, "pre-cleanup-ollama-processes"],
    [host, "phase-1-stop-preexisting-ollama"],
  ]);
  await expect(dispose()).rejects.toThrow();
  expect(captured.cleanupOllama).toHaveBeenLastCalledWith(host, "cleanup-ollama-processes");
});

it("retains pre-cleanup exception handling and propagates disposal transport failures", async () => {
  const transport = new Error("cleanup transport failed");
  captured.cleanupOllama.mockRejectedValueOnce(transport);
  captured.cleanupOllama.mockResolvedValueOnce({ exitCode: 0 });
  const { dispose } = await runCleanupPaths();
  captured.cleanupOllama.mockRejectedValueOnce(transport);
  await expect(dispose()).rejects.toBe(transport);
});
