// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { withStdoutRedirectedToStderr } from "../dist/lib/cli/stdout-guard.js";

describe("withStdoutRedirectedToStderr", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  it("sends stdout writes to stderr while the callback runs, and returns its value", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    };

    const result = await withStdoutRedirectedToStderr(async () => {
      process.stdout.write("progress line\n");
      return 42;
    });

    restore();
    restore = null;
    expect(result).toBe(42);
    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("progress line");
  });

  it("restores the original stdout writer after the callback resolves", async () => {
    const before = process.stdout.write;
    await withStdoutRedirectedToStderr(async () => undefined);
    expect(process.stdout.write).toBe(before);
  });

  it("restores the original stdout writer even when the callback throws", async () => {
    const before = process.stdout.write;
    await expect(
      withStdoutRedirectedToStderr(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.stdout.write).toBe(before);
  });
});
