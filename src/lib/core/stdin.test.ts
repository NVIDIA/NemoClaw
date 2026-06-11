// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { isStdinTty, readLineFromStdin } from "./stdin";

/**
 * Scripted fs.readSync stand-in: a single character delivers that byte, 0
 * reports EOF, and any longer string throws an error with that code.
 */
function makeReadSync(events: Array<string | 0>) {
  return vi.fn((_fd: number, buffer: Buffer): number => {
    const event = events.shift();
    if (event === undefined) throw new Error("readSync called past end of script");
    if (event === 0) return 0;
    if (event.length === 1) {
      buffer[0] = event.charCodeAt(0);
      return 1;
    }
    const err = new Error(event) as NodeJS.ErrnoException;
    err.code = event;
    throw err;
  });
}

describe("readLineFromStdin", () => {
  it("retries on EAGAIN until input arrives instead of treating it as EOF (#5020)", () => {
    const sleep = vi.fn();
    const readSync = makeReadSync(["EAGAIN", "EAGAIN", "y", "\n"]);

    expect(readLineFromStdin({ readSync, sleep })).toBe("y");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("retries immediately on EINTR without sleeping", () => {
    const sleep = vi.fn();
    const readSync = makeReadSync(["EINTR", "n", "\n"]);

    expect(readLineFromStdin({ readSync, sleep })).toBe("n");
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["returns null at immediate EOF", [0], null],
    ["strips the trailing CR from CRLF input", ["y", "e", "s", "\r", "\n"], "yes"],
    ["returns buffered bytes when EOF arrives before a newline", ["y", 0], "y"],
    ["returns null on a hard error with no buffered bytes", ["EBADF"], null],
    ["returns buffered bytes when a hard error interrupts mid-line", ["y", "e", "EBADF"], "ye"],
  ] as const)("%s", (_label, events, expected) => {
    expect(readLineFromStdin({ readSync: makeReadSync([...events]), sleep: vi.fn() })).toBe(
      expected,
    );
  });

  it.each([
    ["EAGAIN"],
    ["EWOULDBLOCK"],
  ] as const)("gives up with null after the non-TTY deadline on persistent %s", (code) => {
    const sleep = vi.fn();
    const readSync = vi.fn((): number => {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    });

    expect(readLineFromStdin({ isTty: () => false, readSync, sleep })).toBeNull();
    // 10s virtual deadline at 25ms per retry = exactly 400 bounded waits.
    expect(sleep).toHaveBeenCalledTimes(400);
  });

  it("keeps waiting past the deadline on a TTY until input arrives", () => {
    const sleep = vi.fn();
    const events = [...Array.from({ length: 450 }, () => "EAGAIN"), "y", "\n"];

    expect(readLineFromStdin({ isTty: () => true, readSync: makeReadSync(events), sleep })).toBe(
      "y",
    );
    expect(sleep).toHaveBeenCalledTimes(450);
  });
});

describe("isStdinTty", () => {
  it("reports false when stdin is not a terminal", () => {
    // Vitest workers run with piped stdio, so fd 0 is never a TTY here.
    expect(isStdinTty()).toBe(false);
  });
});
