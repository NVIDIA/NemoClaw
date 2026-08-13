// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLocalAdapterLogger } from "./logger";

describe("local adapter logger", () => {
  it("contains diagnostic conversion failures and skips conversion without a callback", () => {
    const messageGetter = vi.fn(() => {
      throw new Error("message conversion failed");
    });
    const hostileFailure = Object.create(Error.prototype);
    Object.defineProperty(hostileFailure, "message", { get: messageGetter });
    const injectedLogger = () => {
      throw hostileFailure;
    };

    const withoutDiagnostic = createLocalAdapterLogger({ logPath: "/unused/adapter.log" });
    expect(() => withoutDiagnostic.logEvent(injectedLogger, "request_failed")).not.toThrow();
    expect(messageGetter).not.toHaveBeenCalled();

    const onLoggerError = vi.fn();
    const withDiagnostic = createLocalAdapterLogger({
      logPath: "/unused/adapter.log",
      onLoggerError,
    });
    expect(() => withDiagnostic.logEvent(injectedLogger, "request_failed")).not.toThrow();
    expect(messageGetter).toHaveBeenCalledOnce();
    expect(onLoggerError).toHaveBeenCalledWith("adapter logger diagnostic unavailable");
  });

  it("writes normalized JSONL fields and reports logger failures without throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-logger-"));
    const logPath = path.join(dir, "adapter.log");
    const onLoggerError = vi.fn();
    try {
      const { defaultLogger, logEvent } = createLocalAdapterLogger({ logPath, onLoggerError });
      defaultLogger("request\ncompleted", {
        detail: `  ${"x".repeat(220)}  `,
        missing: undefined,
        status: 200,
      });
      const payload = JSON.parse(fs.readFileSync(logPath, "utf8")) as Record<string, unknown>;
      expect(payload).toMatchObject({ event: "request completed", missing: null, status: 200 });
      expect(String(payload.detail)).toHaveLength(180);

      expect(() =>
        logEvent(() => {
          throw new Error("logger\nfailed");
        }, "request_failed"),
      ).not.toThrow();
      expect(onLoggerError).toHaveBeenCalledWith("logger failed");

      const onWriteError = vi.fn();
      const failing = createLocalAdapterLogger({
        logPath: path.join(logPath, "child"),
        onWriteError,
      });
      expect(() => failing.defaultLogger("adapter_ready")).not.toThrow();
      expect(onWriteError).toHaveBeenCalledOnce();

      const onWriteCallbackFailure = vi.fn(() => {
        throw new Error("write callback failed");
      });
      const onLoggerCallbackFailure = vi.fn(() => {
        throw new Error("logger callback failed");
      });
      const injectedLoggerFailure = vi.fn(() => {
        throw new Error("injected logger failed");
      });
      const callbackFailures = createLocalAdapterLogger({
        logPath: path.join(logPath, "callback-child"),
        onWriteError: onWriteCallbackFailure,
        onLoggerError: onLoggerCallbackFailure,
      });
      expect(() => callbackFailures.defaultLogger("adapter_ready")).not.toThrow();
      expect(onWriteCallbackFailure).toHaveBeenCalledOnce();
      expect(() =>
        callbackFailures.logEvent(injectedLoggerFailure, "request_failed"),
      ).not.toThrow();
      expect(injectedLoggerFailure).toHaveBeenCalledOnce();
      expect(onLoggerCallbackFailure).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
