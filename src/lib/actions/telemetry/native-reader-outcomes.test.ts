// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import type { OpenShellSandboxCommandError } from "../../adapters/openshell/sandbox-command";

const runBuffered = vi.hoisted(() => vi.fn());
vi.mock("../../adapters/openshell/sandbox-command-cli", async (original) => ({
  ...(await original<typeof import("../../adapters/openshell/sandbox-command-cli")>()),
  createCliOpenShellSandboxCommandExecutor: () => ({ runBuffered }),
}));

import { createSupervisedSandboxCommandReader, NativeTelemetryReadError } from "./native-reader";

const request = {
  sandboxName: "private-name",
  target: { kind: "named", gatewayName: "nemoclaw" },
  command: ["cat", "/private/config"],
} as const;
const privateContent = "private-command-output-and-credentials";

it.each([
  "cancelled",
  "capture",
  "invocation",
  "timeout",
  "unavailable",
] satisfies OpenShellSandboxCommandError["kind"][])(
  "retains the bounded native command failure reason %s without command content",
  async (reason) => {
    runBuffered.mockResolvedValue({
      outcome: { kind: "failed", error: { kind: reason, message: privateContent } },
      stdout: privateContent,
      stderr: privateContent,
    });
    const reader = createSupervisedSandboxCommandReader(new AbortController().signal);
    try {
      const error = await reader.read(request).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NativeTelemetryReadError);
      expect(error).toMatchObject({ reason, message: `Native telemetry read failed: ${reason}` });
      expect(String(error)).not.toContain(privateContent);
      expect(JSON.stringify(error)).not.toContain(privateContent);
    } finally {
      reader.dispose();
    }
  },
);

it("distinguishes a nonzero native command exit without exposing stderr", async () => {
  runBuffered.mockResolvedValue({
    outcome: { kind: "completed", exitCode: 1 },
    stdout: privateContent,
    stderr: privateContent,
  });
  const reader = createSupervisedSandboxCommandReader(new AbortController().signal);
  try {
    await expect(reader.read(request)).rejects.toMatchObject({
      reason: "nonzero_exit",
      message: "Native telemetry read failed: nonzero_exit",
    });
  } finally {
    reader.dispose();
  }
});

it("rejects a cancelled read before starting a native command", async () => {
  const controller = new AbortController();
  controller.abort();
  runBuffered.mockClear();
  const reader = createSupervisedSandboxCommandReader(controller.signal);
  try {
    await expect(reader.read(request)).rejects.toMatchObject({ reason: "cancelled" });
    expect(runBuffered).not.toHaveBeenCalled();
  } finally {
    reader.dispose();
  }
});

it("rejects command output that settles after cancellation", async () => {
  const controller = new AbortController();
  runBuffered.mockImplementation(async () => {
    controller.abort();
    return { outcome: { kind: "completed", exitCode: 0 }, stdout: privateContent, stderr: "" };
  });
  const reader = createSupervisedSandboxCommandReader(controller.signal);
  try {
    await expect(reader.read(request)).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
    reader.dispose();
  }
});

it("returns a successful native observation and removes its signal listeners", async () => {
  runBuffered.mockResolvedValue({
    outcome: { kind: "completed", exitCode: 0 },
    stdout: "observed",
    stderr: "",
  });
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const reader = createSupervisedSandboxCommandReader(new AbortController().signal);
  try {
    expect(await reader.read(request)).toBe("observed");
  } finally {
    reader.dispose();
  }
  expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  expect(process.listenerCount("SIGINT")).toBe(beforeInt);
});
