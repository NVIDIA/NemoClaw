// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { B, D, failLine, G, R, RD, warnLine, YW } from "./terminal-style";

describe("terminal-style", () => {
  it("exports terminal style strings", () => {
    for (const value of [B, D, G, R, RD, YW]) {
      expect(typeof value).toBe("string");
    }
  });
});

const ORIGINAL_STDOUT = {
  isTTY: process.stdout.isTTY,
  getColorDepth: process.stdout.getColorDepth,
};
const ORIGINAL_STDERR = {
  isTTY: process.stderr.isTTY,
  getColorDepth: process.stderr.getColorDepth,
};

// styleText decides color from the target stream's reported color depth
// (`getColorDepth()`), which is where a real terminal folds in isTTY, NO_COLOR,
// NODE_DISABLE_COLORS and FORCE_COLOR. Depth 1 = no color (what NO_COLOR / a
// redirected pipe / CI report); depth 24 = truecolor. Model both directly so
// each case is deterministic regardless of the worker's own TTY/env.
function stubStream(stream: NodeJS.WriteStream, isTTY: boolean, colorDepth: number): void {
  Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true });
  Object.defineProperty(stream, "getColorDepth", { value: () => colorDepth, configurable: true });
}

function restoreStream(
  stream: NodeJS.WriteStream,
  original: { isTTY: boolean | undefined; getColorDepth: unknown },
): void {
  Object.defineProperty(stream, "isTTY", { value: original.isTTY, configurable: true });
  Object.defineProperty(stream, "getColorDepth", {
    value: original.getColorDepth,
    configurable: true,
  });
}

async function withRestoredStreams<T>(callback: () => T | Promise<T>): Promise<T> {
  try {
    return await callback();
  } finally {
    restoreStream(process.stdout, ORIGINAL_STDOUT);
    restoreStream(process.stderr, ORIGINAL_STDERR);
  }
}

// styleText's `yellow`/`red`/`green` formats (as of Node 22.16) wrap text in
// SGR color codes with a `39` (default-foreground) reset.
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[39m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[39m`;
describe("preflight severity lines (#6004)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("colors warn/error from stderr — their real stream — not stdout (#6004)", async () => {
    await withRestoredStreams(() => {
      // stdout redirected to a file, terminal still on stderr: warn/error must
      // stay colored because they land on the color-capable stderr.
      vi.stubEnv("NO_COLOR", "");
      stubStream(process.stderr, true, 24);
      stubStream(process.stdout, false, 1);
      expect(warnLine("disk low")).toBe(`  ${YELLOW("⚠ disk low")}`);
      expect(failLine("docker down")).toBe(`  ${RED("✗ docker down")}`);
    });
  });

  it("drops warn/error color when stderr is redirected but stdout is a TTY (#6004)", async () => {
    await withRestoredStreams(() => {
      // The inverse leak: stderr redirected to a log, stdout still a terminal.
      // warn/error must go plain so no raw ANSI lands in the log.
      vi.stubEnv("NO_COLOR", "");
      stubStream(process.stdout, true, 24);
      stubStream(process.stderr, false, 1);
      expect(warnLine("disk low")).toBe("  ⚠ disk low");
      expect(failLine("docker down")).toBe("  ✗ docker down");
    });
  });

  it("keeps NO_COLOR authoritative when FORCE_COLOR is also set", async () => {
    await withRestoredStreams(() => {
      vi.stubEnv("NO_COLOR", "1");
      vi.stubEnv("FORCE_COLOR", "1");
      stubStream(process.stdout, true, 24);
      stubStream(process.stderr, true, 24);
      expect(warnLine("a")).toBe("  ⚠ a");
      expect(failLine("b")).toBe("  ✗ b");
    });
  });

  it("selects the legacy true-color green when configured before import", async () => {
    await withRestoredStreams(async () => {
      stubStream(process.stdout, true, 24);
      vi.stubEnv("NO_COLOR", "");
      vi.stubEnv("COLORTERM", "truecolor");
      vi.resetModules();

      const freshStyles = await import("./terminal-style");
      expect(freshStyles.G).toBe("\x1b[38;2;118;185;0m");
    });
  });
});
