// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { withStdoutRedirectedToStderr } from "../../cli/stdout-guard";
import type { ProcessSessionChild, ProcessSessionSignals } from "../../core/process-session";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { createCliOpenShellSandboxTransferExecutor } from "./sandbox-transfer-cli";
import type { OpenShellSandboxTransferRequest } from "./sandbox-transfer";

const request: OpenShellSandboxTransferRequest = {
  direction: "upload",
  sandboxName: "alpha",
  target: { kind: "selected" },
  source: "/host/space name/",
  destination: "/sandbox/work/",
};

function harness() {
  const events = new EventEmitter();
  const signals = new EventEmitter();
  const signalSource: ProcessSessionSignals = {
    add: (signal, listener) => {
      signals.on(signal, listener);
    },
    remove: (signal, listener) => {
      signals.off(signal, listener);
    },
  };
  const child: ProcessSessionChild = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    once: events.once.bind(events) as ProcessSessionChild["once"],
  };
  const spawnChild = vi.fn<
    (binary: string, args: readonly string[], options: SpawnOptions) => ProcessSessionChild
  >(() => child);
  const executor = createCliOpenShellSandboxTransferExecutor({
    resolveBinary: () => "/trusted/openshell",
    spawnChild,
    signalSource,
  });
  return { events, signals, child, spawnChild, executor };
}

describe("CLI sandbox transfer", () => {
  it.each(["upload", "download"] as const)(
    "preserves %s arguments, inherited stdio, and unlimited duration",
    async (direction) => {
      vi.stubEnv("NVIDIA_API_KEY", "not-for-the-child");
      const h = harness();
      const pending = h.executor.run({
        ...request,
        direction,
        target: { kind: "named", gatewayName: "nemoclaw-8091" },
      });
      h.events.emit("close", 7, null);
      const result = await pending;
      try {
        expect(h.spawnChild).toHaveBeenCalledWith(
          "/trusted/openshell",
          [
            "sandbox",
            direction,
            "-g",
            "nemoclaw-8091",
            "alpha",
            "/host/space name/",
            "/sandbox/work/",
          ],
          { cwd: REPOSITORY_ROOT, env: expect.any(Object), stdio: "inherit" },
        );
        expect(h.spawnChild.mock.calls[0]?.[2].env).not.toHaveProperty("NVIDIA_API_KEY");
        expect(result.outcome).toEqual({ kind: "completed", exitCode: 7 });
      } finally {
        result.release();
      }
    },
  );

  it("preserves the human-output channel while stdout is reserved for machine output", async () => {
    const h = harness();
    await withStdoutRedirectedToStderr(async () => {
      const pending = h.executor.run(request);
      h.events.emit("close", 0, null);
      const result = await pending;
      try {
        expect(h.spawnChild.mock.calls[0]?.[2].stdio).toEqual([
          "inherit",
          process.stderr,
          "inherit",
        ]);
      } finally {
        result.release();
      }
    });
  });

  it.each([
    { sandboxName: "--other" },
    { target: { kind: "named", gatewayName: "../other" } },
    { source: "" },
    { destination: "bad\0path" },
  ])("rejects invalid transfer input before invoking OpenShell: %j", async (override) => {
    const h = harness();
    const result = await h.executor.run({
      ...request,
      ...override,
    } as OpenShellSandboxTransferRequest);
    expect(result.outcome).toEqual({ kind: "failed", reason: "invalid_request" });
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("rejects a gateway endpoint override before spawning", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://untrusted.invalid");
    const h = harness();
    expect((await h.executor.run(request)).outcome).toEqual({
      kind: "failed",
      reason: "invalid_request",
    });
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("returns unavailable when no executable can be resolved", async () => {
    const executor = createCliOpenShellSandboxTransferExecutor({ resolveBinary: () => null });
    expect((await executor.run(request)).outcome).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
  });

  it.each(["ENOENT", "EACCES"])(
    "contains %s subprocess errors until the child closes",
    async (code) => {
      const h = harness();
      let settled = false;
      const pending = h.executor.run(request).then((result) => {
        settled = true;
        return result;
      });
      h.events.emit(
        "error",
        Object.assign(new Error("secret-token /internal/credential/file"), { code }),
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      h.events.emit("close", null, null);
      const result = await pending;
      try {
        expect(result.outcome).toEqual({
          kind: "failed",
          reason: code === "ENOENT" ? "unavailable" : "invocation",
        });
        expect(JSON.stringify(result)).not.toMatch(/secret-token|internal/);
      } finally {
        result.release();
      }
    },
  );

  it.each([
    ["SIGINT", []],
    ["SIGTERM", [["SIGTERM"]]],
  ] as const)(
    "keeps %s interruption through a zero exit and caller cleanup",
    async (signal, forwardedSignals) => {
      const h = harness();
      const unrelated = vi.fn();
      h.signals.on(signal, unrelated);
      const pending = h.executor.run(request);
      h.signals.emit(signal);
      expect(vi.mocked(h.child.kill).mock.calls).toEqual(forwardedSignals);
      h.events.emit("close", 0, null);
      const result = await pending;
      try {
        expect(result.outcome).toEqual({ kind: "failed", reason: "interrupted" });
        expect(result.wasInterrupted()).toBe(true);
        expect(h.signals.listenerCount(signal)).toBe(2);
      } finally {
        result.release();
      }
      expect(h.signals.listeners(signal)).toEqual([unrelated]);
    },
  );

  it("remembers interruption after transfer completion until the caller releases", async () => {
    const h = harness();
    const pending = h.executor.run(request);
    h.child.exitCode = 0;
    h.events.emit("close", 0, null);
    const result = await pending;
    try {
      expect(result.wasInterrupted()).toBe(false);
      h.signals.emit("SIGTERM");
      expect(result.wasInterrupted()).toBe(true);
      expect(h.child.kill).not.toHaveBeenCalled();
    } finally {
      result.release();
    }
    expect(h.signals.eventNames()).toEqual([]);
  });

  it("does not report success when the child closes without an exit status", async () => {
    const h = harness();
    const pending = h.executor.run(request);
    h.events.emit("close", null, null);
    const result = await pending;
    try {
      expect(result.outcome).toEqual({ kind: "failed", reason: "indeterminate" });
    } finally {
      result.release();
    }
  });
});
