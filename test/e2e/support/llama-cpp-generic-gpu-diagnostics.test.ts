// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  captureManagedLlamaCppRuntimeLogs,
  withManagedLlamaCppFailureDiagnostics,
} from "../fixtures/llama-cpp-runtime-diagnostics.ts";

const runtime = { providerId: "docker", runtimeId: "a".repeat(64) };

it("captures bounded owned runtime logs when approval throws and redacts their credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llama-failure-"));
  const secret = 'fixture-secret-"\nvalue';
  const original = new Error("approval failed");
  const capture = vi.fn().mockReturnValue({ status: 0, stdout: secret, stderr: secret });
  const nextAgent = vi.fn();
  try {
    await expect(
      withManagedLlamaCppFailureDiagnostics(
        async () => {
          await Promise.reject(original);
          nextAgent();
        },
        { capture },
        new ArtifactSink(root, [secret]),
        runtime,
      ),
    ).rejects.toBe(original);
    expect(nextAgent).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["container", "logs", "--tail", "20000", runtime.runtimeId],
      30_000,
    );
    const raw = await readFile(path.join(root, "managed-runtime-logs-failure.json"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.parse(raw)).toMatchObject({
      ...runtime,
      status: 0,
      stdout: "[REDACTED]",
      stderr: "[REDACTED]",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves the original failure when diagnostics capture fails", async () => {
  const original = new Error("agent failed");
  const capture = vi.fn(() => {
    throw new Error("engine unavailable");
  });
  const writeJson = vi.fn().mockRejectedValue(new Error("artifact unavailable"));
  await expect(
    withManagedLlamaCppFailureDiagnostics(
      async () => {
        throw original;
      },
      { capture },
      { writeJson },
      runtime,
    ),
  ).rejects.toBe(original);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(writeJson).toHaveBeenCalledTimes(0);
});

it("preserves the original failure when diagnostics persist fails", async () => {
  const original = new Error("agent failed");
  const capture = vi.fn().mockReturnValue({ status: 1, stdout: "", stderr: "container absent" });
  const writeJson = vi.fn().mockRejectedValue(new Error("artifact unavailable"));
  await expect(
    withManagedLlamaCppFailureDiagnostics(
      async () => {
        throw original;
      },
      { capture },
      { writeJson },
      runtime,
    ),
  ).rejects.toBe(original);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(writeJson).toHaveBeenCalledTimes(1);
});

it("does not capture extra logs on ordinary success", async () => {
  const run = vi.fn().mockResolvedValue(undefined);
  const capture = vi.fn();
  const writeJson = vi.fn();
  await withManagedLlamaCppFailureDiagnostics(run, { capture }, { writeJson }, runtime);
  expect(run).toHaveBeenCalledTimes(1);
  expect(capture).not.toHaveBeenCalled();
  expect(writeJson).not.toHaveBeenCalled();
});

it.each(["setup", "post-agent"] as const)(
  "captures %s through the same bounded runtime owner",
  async (phase) => {
    const capture = vi.fn().mockReturnValue({
      status: 1,
      error: new Error("runtime unavailable"),
      stdout: "",
      stderr: "container absent",
    });
    const writeJson = vi.fn().mockResolvedValue(undefined);
    await captureManagedLlamaCppRuntimeLogs({ capture }, { writeJson }, runtime, phase);
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["container", "logs", "--tail", "20000", runtime.runtimeId],
      30_000,
    );
    expect(writeJson).toHaveBeenCalledExactlyOnceWith(`managed-runtime-logs-${phase}.json`, {
      ...runtime,
      status: 1,
      error: "runtime unavailable",
      stdout: "",
      stderr: "container absent",
    });
  },
);
