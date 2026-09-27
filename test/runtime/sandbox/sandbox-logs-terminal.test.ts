// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { showSandboxLogsWithDeps } from "../../../src/lib/actions/sandbox/logs.js";

describe("sandbox logs for terminal agents", () => {
  it("skips the OpenClaw gateway log source but keeps OpenShell audit logs", async () => {
    const calls: string[] = [];
    const enableAuditLogs = vi.fn(async () => ({ ok: true as const, value: undefined }));
    let exitCode: number | null = null;

    try {
      await showSandboxLogsWithDeps(
        "deepagents-code",
        { follow: false, lines: "20", since: null },
        {
          getSessionAgent: () =>
            ({
              runtime: { kind: "terminal" },
            }) as never,
          enableAuditLogs,
          isDockerRuntimeDown: () => false,
          logs: {
            checkAvailability: () => null,
            read: async (request) => {
              calls.push(request.source);
              return {
                content: request.source === "openshell" ? "openshell audit line\n" : "",
                diagnostic: "",
                outcome: { kind: "completed", exitCode: 0 },
              };
            },
            follow: vi.fn() as never,
          },
          writeStdout: () => undefined,
          exit: ((code: number): never => {
            exitCode = code;
            throw new Error("exit");
          }) as never,
        },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("exit");
    }

    expect(exitCode).toBe(0);
    expect(enableAuditLogs).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "selected" },
      sandboxName: "deepagents-code",
      timeoutMs: expect.any(Number),
    });
    expect(calls).toEqual(["openshell"]);
  });

  it("logs --follow spawns only the OpenShell source for terminal agents", async () => {
    const calls: string[] = [];
    const enableAuditLogs = vi.fn(async () => ({ ok: true as const, value: undefined }));
    let exitCode: number | null = null;
    let finish: (value: { outcome: { kind: "completed"; exitCode: number } }) => void = () => {};
    const completion = new Promise<{ outcome: { kind: "completed"; exitCode: number } }>(
      (resolve) => {
        finish = resolve;
      },
    );

    await showSandboxLogsWithDeps(
      "deepagents-code",
      { follow: true, lines: "20", since: null },
      {
        getSessionAgent: () =>
          ({
            runtime: { kind: "terminal" },
          }) as never,
        enableAuditLogs,
        isDockerRuntimeDown: () => false,
        logs: {
          checkAvailability: () => null,
          read: vi.fn(),
          follow: (request) => {
            calls.push(request.source);
            return { diagnostic: null, output: null, completion, cancel() {} };
          },
        },
        exit: ((code: number): never => {
          exitCode = code;
          return undefined as never;
        }) as never,
      },
    );

    expect(enableAuditLogs).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "selected" },
      sandboxName: "deepagents-code",
      timeoutMs: expect.any(Number),
    });
    expect(calls.includes("openshell")).toBe(true);
    expect(calls).not.toContain("gateway");
    finish({ outcome: { kind: "completed", exitCode: 0 } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exitCode).toBe(0);
  });
});
