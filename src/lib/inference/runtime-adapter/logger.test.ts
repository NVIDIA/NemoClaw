// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalAdapterLogger } from "./logger";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-logger-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

describe("local adapter logger", () => {
  it("writes compact normalized JSONL fields", () => {
    const logPath = tempPath("adapter.log");
    const { defaultLogger } = createLocalAdapterLogger({ logPath });

    defaultLogger("request\ncompleted", {
      detail: `  ${"x".repeat(220)}  `,
      missing: undefined,
      status: 200,
    });

    const payload = JSON.parse(fs.readFileSync(logPath, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({ event: "request completed", missing: null, status: 200 });
    expect(String(payload.detail)).toHaveLength(180);
    expect(payload.ts).toEqual(expect.any(String));
  });

  it("isolates injected logger failures", () => {
    const onLoggerError = vi.fn();
    const { logEvent } = createLocalAdapterLogger({
      logPath: tempPath("adapter.log"),
      onLoggerError,
    });

    expect(() =>
      logEvent(() => {
        throw new Error("logger\nfailed");
      }, "request_failed"),
    ).not.toThrow();
    expect(onLoggerError).toHaveBeenCalledWith("logger failed");
  });

  it("reports default logger write failures when requested", () => {
    const parentFile = tempPath("not-a-directory");
    fs.writeFileSync(parentFile, "occupied");
    const onWriteError = vi.fn();
    const { defaultLogger } = createLocalAdapterLogger({
      logPath: path.join(parentFile, "adapter.log"),
      onWriteError,
    });

    expect(() => defaultLogger("adapter_ready")).not.toThrow();
    expect(onWriteError).toHaveBeenCalledOnce();
  });
});
