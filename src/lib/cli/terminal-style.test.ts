// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { B, D, G, R, RD, YW } from "./terminal-style";

describe("terminal-style", () => {
  it("exports terminal style strings", () => {
    for (const value of [B, D, G, R, RD, YW]) {
      expect(typeof value).toBe("string");
    }
  });
});

const ORIGINAL_TTY = process.stdout.isTTY;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

// #6004: warnLine/failLine read NO_COLOR + stdout.isTTY at module load, so each
// case reloads the module under a stubbed environment.
async function loadStyle(opts: { tty: boolean; noColor?: string }) {
  vi.resetModules();
  setTTY(opts.tty);
  vi.stubEnv("NO_COLOR", opts.noColor ?? "");
  return import("./terminal-style");
}

describe("preflight line helpers (#6004)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    setTTY(ORIGINAL_TTY);
  });

  it("renders warn ⚠ in yellow and fail ✗ in red on a color-capable TTY", async () => {
    const { warnLine, failLine } = await loadStyle({ tty: true, noColor: "" });
    expect(warnLine("disk low")).toBe("  \x1b[1;33m⚠ disk low\x1b[0m");
    expect(failLine("docker down")).toBe("  \x1b[1;31m✗ docker down\x1b[0m");
  });

  it("emits plain text (no ANSI) under NO_COLOR=1", async () => {
    const { warnLine, failLine } = await loadStyle({ tty: true, noColor: "1" });
    expect(warnLine("disk low")).toBe("  ⚠ disk low");
    expect(failLine("docker down")).toBe("  ✗ docker down");
  });

  it("emits plain text (no ANSI) when stdout is not a TTY", async () => {
    const { warnLine, failLine } = await loadStyle({ tty: false });
    expect(warnLine("x")).toBe("  ⚠ x");
    expect(failLine("y")).toBe("  ✗ y");
  });
});
